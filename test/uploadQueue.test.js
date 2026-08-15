// T22：弱网上传队列（spec 7.2 全部行为规则）。
// 小程序端没有 wx 运行时，测试用最小 wx mock（storage / cloud.uploadFile /
// cloud.callFunction / getNetworkType / removeSavedFile）驱动
// services/uploadQueue.js 的队列逻辑：入队、并发 3、指数退避重试、网络错误
// 挂起、publishRecord 提交时机、recordId 防重发、成功清理本地文件。
const uploadQueue = require('../miniprogram/services/uploadQueue')

// ---- 最小 wx mock：每次测试重建，队列/上传结果可控 ----
function makeWx () {
  const state = {
    storage: {},
    uploads: [], // 每次 uploadFile 调用的 {cloudPath, filePath}
    uploadResults: [], // 队列式上传结果：{error} 抛错 / {} 成功（fileID 由 cloudPath 派生）
    inFlight: 0,
    maxInFlight: 0,
    removed: [], // removeSavedFile 的文件
    publishCalls: [], // publishRecord 的入参
    publishResult: { recordId: 'r-1' },
    networkType: 'wifi'
  }
  const wx = {
    getStorageSync: k => state.storage[k],
    setStorageSync: (k, v) => { state.storage[k] = v },
    getNetworkType: ({ success }) => success({ networkType: state.networkType }),
    removeSavedFile: ({ filePath }) => { state.removed.push(filePath) },
    cloud: {
      uploadFile: async ({ cloudPath, filePath }) => {
        state.uploads.push({ cloudPath, filePath })
        state.inFlight++
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
        const next = state.uploadResults.length ? state.uploadResults.shift() : {}
        await new Promise(r => setTimeout(r, 0))
        state.inFlight--
        if (next && next.error) {
          const err = new Error(next.error)
          err.errMsg = next.error
          throw err
        }
        return { fileID: `cloud://${cloudPath}` }
      },
      callFunction: async ({ name, data }) => {
        if (name === 'publishRecord') {
          state.publishCalls.push(data)
          return { result: state.publishResult }
        }
        return { result: {} }
      }
    }
  }
  return { wx, state }
}

// 通用构造：一条发布 job 的入队参数（1 图 + 1 视频 + 语音）
const jobArgs = (over = {}) => ({
  payload: {
    newPlace: { poiId: 'POI-1', name: '外婆家', type: 'restaurant', location: null },
    text: '好吃',
    rating: 4,
    visibility: 'family',
    participantIds: ['openid-b'],
    happenedAt: 1785000000000
  },
  media: [
    { path: 'wxfile://store/a.jpg', type: 'image' },
    { path: 'wxfile://store/b.mp4', type: 'video', duration: 12 }
  ],
  audio: { path: 'wxfile://store/voice.aac', duration: 5 },
  ...over
})

const queueState = wx => wx.getStorageSync('uploadQueue') || []

beforeEach(() => {
  delete global.wx
})

describe('uploadQueue（弱网上传队列，spec 7.2）', () => {
  test('enqueue：job 落 storage（仅元数据），pendingCount 计数', async () => {
    const { wx, state } = makeWx()
    global.wx = wx
    uploadQueue.enqueue(jobArgs())

    expect(uploadQueue.pendingCount()).toBe(1)
    const raw = state.storage.uploadQueue
    expect(Array.isArray(raw)).toBe(true)
    expect(raw).toHaveLength(1)
    const job = raw[0]
    expect(job.status).toBe('pending')
    expect(job.recordId).toBeNull()
    expect(job.media).toHaveLength(2)
    expect(job.audio).toBeTruthy()
    // 只存元数据：无 base64、无文件本体
    expect(JSON.stringify(raw)).not.toContain('base64')
    expect(job.media[0].localPath).toBe('wxfile://store/a.jpg')
    expect(job.media[0].cloudPath).toMatch(/^records\/\d+-0-[a-z0-9]+\.jpg$/)
    expect(job.audio.cloudPath).toMatch(/^records\/\d+-voice-[a-z0-9]+\.aac$/)
  })

  test('flush 全成功：媒体+语音传齐后 publishRecord 一次，成功清理本地文件，状态条归零', async () => {
    const { wx, state } = makeWx()
    global.wx = wx
    const fired = []
    const unsub = uploadQueue.onChange(n => fired.push(n))
    uploadQueue.enqueue(jobArgs())

    await uploadQueue.flush({ backoff: () => 0 })
    unsub()

    expect(state.publishCalls).toHaveLength(1)
    const payload = state.publishCalls[0]
    expect(payload.media).toHaveLength(2)
    expect(payload.media[0].fileID).toMatch(/^cloud:\/\/records\//)
    expect(payload.media[0].type).toBe('image')
    expect(payload.media[1].type).toBe('video')
    expect(payload.media[1].duration).toBe(12)
    expect(payload.audio.fileID).toMatch(/^cloud:\/\/records\//)
    expect(payload.audio.duration).toBe(5)
    expect(payload.text).toBe('好吃')
    expect(payload.rating).toBe(4)
    expect(payload.visibility).toBe('family')
    expect(payload.participantIds).toEqual(['openid-b'])
    expect(payload.newPlace.name).toBe('外婆家')
    // 三个本地文件上传成功后都被清理
    expect(state.removed.sort()).toEqual([
      'wxfile://store/a.jpg',
      'wxfile://store/b.mp4',
      'wxfile://store/voice.aac'
    ].sort())
    expect(uploadQueue.pendingCount()).toBe(0)
    // onChange 实时推送：入队 → 1，完成后 → 0
    expect(fired[fired.length - 1]).toBe(0)
  })

  test('并发上限 3：6 个媒体同时最多 3 个在传', async () => {
    const { wx, state } = makeWx()
    global.wx = wx
    uploadQueue.enqueue(jobArgs({
      media: Array.from({ length: 6 }, (_, i) => ({ path: `wxfile://store/m${i}.jpg`, type: 'image' })),
      audio: null
    }))

    await uploadQueue.flush({ backoff: () => 0 })

    expect(state.maxInFlight).toBe(3)
    expect(state.publishCalls).toHaveLength(1)
    expect(state.publishCalls[0].media).toHaveLength(6)
  })

  test('断网类错误：立即挂起不重试、不提交、不清理', async () => {
    const { wx, state } = makeWx()
    global.wx = wx
    uploadQueue.enqueue(jobArgs({ media: [{ path: 'wxfile://store/a.jpg', type: 'image' }], audio: null }))
    state.uploadResults = [{ error: 'request:fail network is down' }]

    await uploadQueue.flush({ backoff: () => 0 })

    expect(state.uploads).toHaveLength(1) // 挂起立即返回，无重试
    expect(state.publishCalls).toHaveLength(0)
    expect(state.removed).toHaveLength(0)
    expect(uploadQueue.pendingCount()).toBe(1) // 保持待同步
    expect(queueState(wx)[0].media[0].fileID).toBe('')
  })

  test('非网络类失败：指数退避重试 3 次后仍失败则挂起（共 4 次尝试）', async () => {
    const { wx, state } = makeWx()
    global.wx = wx
    uploadQueue.enqueue(jobArgs({ media: [{ path: 'wxfile://store/a.jpg', type: 'image' }], audio: null }))
    state.uploadResults = Array.from({ length: 4 }, () => ({ error: 'some other error' }))

    await uploadQueue.flush({ backoff: () => 0 })

    expect(state.uploads).toHaveLength(4) // 1 次 + 3 次退避重试
    expect(state.publishCalls).toHaveLength(0)
    expect(uploadQueue.pendingCount()).toBe(1)
  })

  test('非网络类失败：第 4 次尝试成功则继续提交', async () => {
    const { wx, state } = makeWx()
    global.wx = wx
    uploadQueue.enqueue(jobArgs({ media: [{ path: 'wxfile://store/a.jpg', type: 'image' }], audio: null }))
    state.uploadResults = [
      { error: 'some error' },
      { error: 'some error' },
      { error: 'some error' }
    ] // 第 4 次调用走默认成功

    await uploadQueue.flush({ backoff: () => 0 })

    expect(state.uploads).toHaveLength(4)
    expect(state.publishCalls).toHaveLength(1)
    expect(uploadQueue.pendingCount()).toBe(0)
  })

  test('publishRecord 网络类失败：job 保留、媒体不重传，下次 flush 只重提记录', async () => {
    const { wx, state } = makeWx()
    global.wx = wx
    uploadQueue.enqueue(jobArgs({ media: [{ path: 'wxfile://store/a.jpg', type: 'image' }], audio: null }))

    state.publishResult = { code: 'NETWORK', message: 'network is down' }
    await uploadQueue.flush({ backoff: () => 0 })
    expect(state.publishCalls).toHaveLength(1)
    expect(uploadQueue.pendingCount()).toBe(1) // 网络类：保留待重提

    state.publishResult = { recordId: 'r-final' }
    await uploadQueue.flush({ backoff: () => 0 })
    expect(state.uploads).toHaveLength(1) // 媒体没有重传
    expect(state.publishCalls).toHaveLength(2)
    expect(state.publishCalls[1].media[0].fileID).toBe(state.publishCalls[0].media[0].fileID)
    expect(uploadQueue.pendingCount()).toBe(0)
  })

  test('幂等：job 已有 recordId 时不再调 publishRecord（防重发，spec 7.2）', async () => {
    const { wx, state } = makeWx()
    global.wx = wx
    uploadQueue.enqueue(jobArgs({ media: [], audio: null }))
    // 模拟上次已提交成功但清理未完成：recordId 已回填
    queueState(wx)[0].recordId = 'r-existing'
    queueState(wx)[0].status = 'pending'
    state.storage.uploadQueue = queueState(wx)

    await uploadQueue.flush({ backoff: () => 0 })

    expect(state.publishCalls).toHaveLength(0)
    expect(uploadQueue.pendingCount()).toBe(0) // 直接落 done
  })

  test('publishRecord 非网络类失败：job 置 failed 并带说明，未上传的本地文件被清理', async () => {
    const { wx, state } = makeWx()
    global.wx = wx
    uploadQueue.enqueue(jobArgs({
      media: [
        { path: 'wxfile://store/a.jpg', type: 'image' },
        { path: 'wxfile://store/b.jpg', type: 'image' }
      ],
      audio: null
    }))
    // 第一张传成功、第二张传失败挂起 → job 未就绪不会提交…改为：都传成功但记录提交失败
    state.publishResult = { code: 'VALIDATION_FAILED', message: '缺地点' }

    await uploadQueue.flush({ backoff: () => 0 })

    const job = queueState(wx)[0]
    expect(job.status).toBe('failed')
    expect(job.error).toBe('缺地点')
    expect(uploadQueue.pendingCount()).toBe(1) // 状态条仍提示
    // 终态失败：已上传的文件不重复清理（上传时已清），无未上传残留
    expect(state.removed).toHaveLength(2)
  })

  test('离线（networkType none）：flush 不发起任何请求', async () => {
    const { wx, state } = makeWx()
    global.wx = wx
    state.networkType = 'none'
    uploadQueue.enqueue(jobArgs())

    await uploadQueue.flush({ backoff: () => 0 })

    expect(state.uploads).toHaveLength(0)
    expect(state.publishCalls).toHaveLength(0)
    expect(uploadQueue.pendingCount()).toBe(1)
  })

  test('无媒体的纯文字记录：入队后直接提交 publishRecord', async () => {
    const { wx, state } = makeWx()
    global.wx = wx
    uploadQueue.enqueue(jobArgs({ media: [], audio: null }))

    await uploadQueue.flush({ backoff: () => 0 })

    expect(state.uploads).toHaveLength(0)
    expect(state.publishCalls).toHaveLength(1)
    expect(state.publishCalls[0].media).toEqual([])
    expect(state.publishCalls[0].audio).toBeNull()
    expect(uploadQueue.pendingCount()).toBe(0)
  })

  test('discardFailed：清掉终态失败任务，pending 保留', async () => {
    const { wx, state } = makeWx()
    global.wx = wx
    uploadQueue.enqueue(jobArgs({ media: [], audio: null }))
    uploadQueue.enqueue(jobArgs({ media: [], audio: null }))
    queueState(wx)[0].status = 'failed'
    queueState(wx)[0].error = '缺地点'
    state.storage.uploadQueue = queueState(wx)

    uploadQueue.discardFailed()

    const rest = queueState(wx)
    expect(rest).toHaveLength(1)
    expect(rest[0].status).toBe('pending')
    expect(uploadQueue.pendingCount()).toBe(1)
  })
})
