// uploadQueue —— 弱网上传队列（spec 7.2 全部行为规则，T22）。
// 旅行弱网/离线也能打卡：媒体选中时已由发布页 wx.saveFile 持久化（本模块只存
// 元数据，不存 base64）；点「发布」enqueue 一条 job（媒体 + 语音 + 记录负载）→
// flush 按并发 3 上传 → 全部 fileID 到齐才调 publishRecord；断网/超时类错误
// 立即转挂起等补传，其他失败指数退避（1s/2s/4s/8s…）最多 3 次后挂起。
// 幂等：cloudPath = records/{时间戳}-{随机串} 保证文件唯一；job.recordId 在
// publishRecord 成功后回填，已建过记录的重发只补文件不重建记录（spec 7.2）。
// 补传触发：app.onShow + wx.onNetworkStatusChange（恢复联网即触发，spec 7.2）；
// 上传成功即 wx.removeSavedFile 清本地文件。首页「N 条待同步」状态条经
// onChange 订阅实时刷新。
const { callApi } = require('./api')

const STORAGE_KEY = 'uploadQueue'
const CONCURRENCY = 3
const MAX_RETRIES = 3

const rand = () => Math.random().toString(36).slice(2, 10)
// 临时文件扩展名 → 云存储路径扩展名（视频统一 mp4，图片统一 jpg，语音 aac）
const extOf = item => (item.type === 'video' ? 'mp4' : item.type === 'audio' ? 'aac' : 'jpg')
// 指数退避：1s / 2s / 4s / 8s（spec 7.2）；测试注入 0 延迟
const defaultBackoff = retry => Math.min(1000 * 2 ** retry, 8000)

// 断网/超时/被中断类错误：直接转挂起等补传，不做 3 次重试（spec 7.2：这类错误
// 重试也白费，等网络恢复的下一轮 flush 再试）。
// 覆盖：network is down / 超时 / 切后台中断 / request:fail / 云端响应超时
// （-501002）/ 云文件请求失败（-503001），见调研 weak-network-upload.md
function isNetworkError (err) {
  const msg = (err && (err.errMsg || err.message)) || ''
  return /network is down|timed out|timeout|interrupted|request:fail|connect fail|-50[13]00[12]/i.test(msg)
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function load () {
  try {
    const raw = wx.getStorageSync(STORAGE_KEY)
    return Array.isArray(raw) ? raw : []
  } catch (e) {
    return []
  }
}

function save (jobs) {
  wx.setStorageSync(STORAGE_KEY, jobs)
  emit()
}

// ---- 变更订阅：首页状态条靠它实时刷新（不依赖 onShow 轮询）----
const listeners = new Set()
function onChange (fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
function emit () {
  const count = pendingCount()
  for (const fn of listeners) fn(count)
}

// 未完成 job 数（pending 补传中 + failed 待说明），首页「N 条待同步」
function pendingCount () {
  return load().filter(j => j.status !== 'done').length
}

// 未完成 job 明细（状态条点击后的说明用）
function list () {
  return load().filter(j => j.status !== 'done')
}

// 放弃所有终态失败的任务（状态条弹窗的「放弃」）：避免状态条永久卡死；
// 失败 job 的本地文件在置 failed 时已清理，这里只清队列
function discardFailed () {
  save(load().filter(j => j.status !== 'failed'))
}

// 入队一条发布 job（spec 7.2 入队时机：点「发布」才入队；草稿阶段只持久化不传）。
// media/audio 为发布页已持久化的本地路径；携带 fileID 的条目标 done（新建不会有）。
function enqueue ({ payload, media = [], audio = null }) {
  const base = Date.now()
  const job = {
    id: `job-${base}-${rand()}`,
    status: 'pending',
    recordId: null, // 幂等：publishRecord 成功后回填，防重发（spec 7.2）
    payload,
    media: media.map((m, i) => ({
      localPath: m.path,
      cloudPath: `records/${base}-${i}-${rand()}.${extOf(m)}`,
      type: m.type,
      duration: m.duration,
      fileID: m.fileID || '',
      status: m.fileID ? 'done' : 'pending'
    })),
    audio: audio
      ? {
          localPath: audio.path,
          cloudPath: `records/${base}-voice-${rand()}.aac`,
          duration: audio.duration,
          fileID: audio.fileID || '',
          status: audio.fileID ? 'done' : 'pending'
        }
      : null,
    error: '' // 非网络类提交失败的说明（状态条点击展示）
  }
  const jobs = load()
  jobs.push(job)
  save(jobs)
  return job.id
}

// 单个文件上传：成功 → 记 fileID + 清本地文件；网络类错误 → 挂起（返回 false，
// item 保持 pending 下次 flush 再试）；其他失败 → 指数退避重试最多 3 次后挂起
async function uploadOne (item, retry, opts) {
  try {
    const res = await wx.cloud.uploadFile({ cloudPath: item.cloudPath, filePath: item.localPath })
    item.fileID = res.fileID
    item.status = 'done'
    // 上传成功即清理本地文件（spec 7.2）
    wx.removeSavedFile({ filePath: item.localPath, fail: () => {} })
    return true
  } catch (err) {
    if (isNetworkError(err)) return false
    if (retry < MAX_RETRIES) {
      const backoff = (opts && opts.backoff) || defaultBackoff
      await delay(backoff(retry))
      return uploadOne(item, retry + 1, opts)
    }
    return false
  }
}

// 一个 job 的媒体+语音：并发 3 上传（spec 7.2）
async function uploadJobMedia (job, opts) {
  const items = []
  for (const m of job.media) if (!m.fileID) items.push(m)
  if (job.audio && !job.audio.fileID) items.push(job.audio)
  if (items.length === 0) return
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const item = items[cursor++]
      await uploadOne(item, 0, opts) // 失败即挂起：fileID 仍空，保持 pending
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker))
}

// job 可提交：媒体+语音全部就绪
function jobReady (job) {
  return job.media.every(m => m.fileID) && (!job.audio || job.audio.fileID)
}

// 提交 publishRecord：全部 fileID 到齐后才调（spec 7.2）。
// 网络类失败保留 job（媒体已传、fileID 已记，下次 flush 直接重提，不重传文件）；
// 非网络类失败置 failed + 记录说明 + 清理未上传的本地文件
async function submitJob (job) {
  if (job.recordId) {
    // 幂等：已建过记录（上次提交成功但清理未完成）→ 不再重建（spec 7.2）
    job.status = 'done'
    return
  }
  const media = job.media.map(m => ({
    fileID: m.fileID,
    type: m.type,
    ...(m.type === 'video' ? { duration: m.duration } : {})
  }))
  const audio = job.audio && job.audio.fileID
    ? { fileID: job.audio.fileID, duration: job.audio.duration }
    : null
  try {
    const result = await callApi('publishRecord', {
      newPlace: job.payload.newPlace,
      media,
      audio,
      text: job.payload.text,
      rating: job.payload.rating,
      visibility: job.payload.visibility,
      participantIds: job.payload.participantIds,
      ...(job.payload.happenedAt !== undefined ? { happenedAt: job.payload.happenedAt } : {})
    })
    job.recordId = result.recordId
    job.status = 'done'
  } catch (err) {
    if (isNetworkError(err)) {
      // 网络类：job 保留 pending，下次 flush 重提
    } else {
      job.status = 'failed'
      job.error = err.message || '发布失败'
      // 终态失败：清掉未上传的本地文件，免得留孤儿占本地额度
      for (const m of job.media) {
        if (!m.fileID) wx.removeSavedFile({ filePath: m.localPath, fail: () => {} })
      }
      if (job.audio && !job.audio.fileID) {
        wx.removeSavedFile({ filePath: job.audio.localPath, fail: () => {} })
      }
    }
  }
}

function getNetwork () {
  return new Promise(resolve => {
    wx.getNetworkType({
      success: res => resolve(res.networkType !== 'none'),
      fail: () => resolve(true) // 查不到就当有网，试了才知道
    })
  })
}

// 补传主入口（app.onShow / 网络恢复 / 发布页入队后调用）：无网不白跑；
// 逐 job：上传媒体 → 就绪则提交；每步变更即落库
let flushing = false
async function flush (opts = {}) {
  if (flushing) return
  if (!(await getNetwork())) return
  flushing = true
  try {
    const jobs = load()
    for (const job of jobs) {
      if (job.status !== 'pending') continue
      await uploadJobMedia(job, opts)
      if (jobReady(job)) await submitJob(job)
      save(jobs)
    }
  } finally {
    flushing = false
  }
}

module.exports = {
  enqueue,
  flush,
  onChange,
  pendingCount,
  list,
  discardFailed,
  // 供发布页编辑模式复用（cloudPath 同一约定）
  rand,
  extOf
}
