// updateRecord —— 编辑记录（spec 5.1）：能看见就能编辑（公共 visibility.js：
// spec 4.6 三档 + 4.2 退出成员记录不可见）。
// 可改字段：text / rating / visibility / participantIds / happenedAt / media / audio，只改传入的。
// visibility 改 pair 时以「改动时」的 circles.pairIds 重固化快照；从 pair 改走则清除快照。
// 被替换/删除的旧语音文件从云存储删除（与 media 孤儿清理同一规则）。
const cloud = require('wx-server-sdk')
const { isVisible } = require('./visibility')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const MEDIA_LIMITS = { // 与 publishRecord 保持一致（服务端复核）
  IMAGE_MAX: 9,
  VIDEO_MAX: 3,
  VIDEO_DURATION_MAX: 60,
  TOTAL_MAX: 12
}
const TEXT_MAX = 500
const VISIBILITIES = ['family', 'pair', 'private']

function err (code, message) {
  return { code, message }
}

function validateMedia (media) {
  if (!Array.isArray(media)) return '媒体格式不正确'
  if (media.length > MEDIA_LIMITS.TOTAL_MAX) {
    return `图片加视频最多 ${MEDIA_LIMITS.TOTAL_MAX} 个`
  }
  let images = 0
  let videos = 0
  for (const item of media) {
    if (!item || typeof item.fileID !== 'string' || !item.fileID) return '存在无效的媒体文件'
    if (item.type === 'image') {
      if (++images > MEDIA_LIMITS.IMAGE_MAX) return `图片最多 ${MEDIA_LIMITS.IMAGE_MAX} 张`
    } else if (item.type === 'video') {
      if (typeof item.duration !== 'number' || item.duration <= 0) return '视频缺少有效时长'
      if (item.duration > MEDIA_LIMITS.VIDEO_DURATION_MAX) {
        return `每段视频不能超过 ${MEDIA_LIMITS.VIDEO_DURATION_MAX} 秒`
      }
      if (++videos > MEDIA_LIMITS.VIDEO_MAX) return `视频最多 ${MEDIA_LIMITS.VIDEO_MAX} 段`
    } else {
      return '媒体类型只能是图片或视频'
    }
  }
  return null
}

// 语音复核（spec 4.5）：null（删除语音）或 {fileID, duration}（0 < duration ≤ 60 秒）。
// 与 publishRecord 的 validateAudio 同一规则，返回落库值或错误文案
function validateAudio (audio) {
  if (audio === null) return { value: null }
  if (typeof audio !== 'object' || Array.isArray(audio)) return { error: '语音格式不正确' }
  if (typeof audio.fileID !== 'string' || !audio.fileID) return { error: '语音缺少有效文件' }
  if (typeof audio.duration !== 'number' || !(audio.duration > 0)) return { error: '语音缺少有效时长' }
  if (audio.duration > MEDIA_LIMITS.VIDEO_DURATION_MAX) {
    return { error: `语音不能超过 ${MEDIA_LIMITS.VIDEO_DURATION_MAX} 秒` }
  }
  return { value: { fileID: audio.fileID, duration: audio.duration } }
}

function validateParticipantIds (participantIds, activeOpenids, authorOpenid) {
  if (!Array.isArray(participantIds)) return '参与者格式不正确'
  for (const id of participantIds) {
    if (typeof id !== 'string' || !id) return '存在无效的参与者'
    if (id === authorOpenid) return '参与者不用包含作者'
    if (!activeOpenids.includes(id)) return '参与者必须是在圈成员'
  }
  return null
}

function parseHappenedAt (value) {
  const date = value instanceof Date ? value : new Date(value)
  if (isNaN(date.getTime())) return { error: '补记时间无效' }
  if (date.getTime() > Date.now() + 60 * 1000) return { error: '补记时间不能是未来' }
  return { date }
}

// 封面派生规则（spec 4.4），publishRecord/updateRecord/deleteRecord 三个写路径统一：
// 按 happenedAt 最新的一条「有图」记录的首图；无任何有图记录则 null。
function computeCover (records) {
  const sorted = records.slice()
    .sort((a, b) => new Date(b.happenedAt).getTime() - new Date(a.happenedAt).getTime())
  for (const r of sorted) {
    const image = (r.media || []).find(m => m && m.type === 'image' && m.fileID)
    if (image) return image.fileID
  }
  return null
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()

  // ---- 鉴权 + 可见性前置一次拉齐（spec 5.1、4.2）----
  const allMembersRes = await db.collection('members').limit(100).get()
  const me = allMembersRes.data.find(m => m.openid === OPENID && m.status === 'active')
  if (!me) {
    return err('NOT_IN_CIRCLE', '你不在家庭圈中')
  }
  const activeOpenids = new Set(
    allMembersRes.data.filter(m => m.status === 'active').map(m => m.openid)
  )

  // ---- 取记录：不存在与不可见统一 NOT_VISIBLE（spec 5.2）----
  const recordId = typeof event.recordId === 'string' ? event.recordId : ''
  if (!recordId) return err('NOT_VISIBLE', '记录不存在')
  let record
  try {
    record = (await db.collection('records').doc(recordId).get()).data
  } catch (e) {
    return err('NOT_VISIBLE', '记录不存在')
  }
  if (!isVisible(record, OPENID, activeOpenids)) {
    return err('NOT_VISIBLE', '记录不存在')
  }

  // ---- 只改传入的字段，逐一复核 ----
  const patch = {}

  if (event.text !== undefined) {
    const text = typeof event.text === 'string' ? event.text.trim() : ''
    if (text.length > TEXT_MAX) return err('VALIDATION_FAILED', `吐槽不能超过 ${TEXT_MAX} 字`)
    patch.text = text
  }

  if (event.rating !== undefined) {
    if (!Number.isInteger(event.rating) || event.rating < 1 || event.rating > 5) {
      return err('VALIDATION_FAILED', '请打 1–5 星评分')
    }
    patch.rating = event.rating
  }

  if (event.media !== undefined) {
    const mediaError = validateMedia(event.media)
    if (mediaError) return err('VALIDATION_FAILED', mediaError)
    patch.media = event.media
  }

  if (event.audio !== undefined) {
    const audio = validateAudio(event.audio)
    if (audio.error) return err('VALIDATION_FAILED', audio.error)
    patch.audio = audio.value
  }

  if (event.visibility !== undefined) {
    if (!VISIBILITIES.includes(event.visibility)) {
      return err('VALIDATION_FAILED', '可见范围只能是家庭圈 / 仅我俩 / 仅自己')
    }
    if (event.visibility === 'pair') {
      // 重固化快照：以改动时的 circles.pairIds 为准（spec 4.5 快照语义）
      const circleRes = await db.collection('circles').limit(1).get()
      const pairIds = (circleRes.data[0] || {}).pairIds || []
      if (pairIds.length !== 2) {
        return err('VALIDATION_FAILED', '「仅我俩」需要圈主先在设置中指定另一半')
      }
      // 改动者必须在二人组内：否则会把自己锁在记录之外（能看见才能编辑，编辑后仍须看得见）
      if (!pairIds.includes(OPENID)) {
        return err('VALIDATION_FAILED', '「仅我俩」只面向圈主指定的二人组')
      }
      patch.visibility = 'pair'
      patch.pairIds = pairIds
    } else {
      patch.visibility = event.visibility
      patch.pairIds = _.remove() // 非 pair 档快照无意义，清除
    }
  }

  if (event.participantIds !== undefined) {
    const participantError = validateParticipantIds(
      event.participantIds, [...activeOpenids], record.authorId
    )
    if (participantError) return err('VALIDATION_FAILED', participantError)
    patch.participantIds = event.participantIds
  }

  if (event.happenedAt !== undefined) {
    const happened = parseHappenedAt(event.happenedAt)
    if (happened.error) return err('VALIDATION_FAILED', happened.error)
    patch.happenedAt = happened.date
  }

  if (Object.keys(patch).length === 0) {
    return err('VALIDATION_FAILED', '没有要修改的内容')
  }

  patch.updatedAt = new Date()
  await db.collection('records').doc(recordId).update({ data: patch })

  // ---- 被替换掉的媒体/语音文件从云存储删除（否则成永久孤儿文件）----
  const orphanFiles = []
  if (event.media !== undefined) {
    const kept = new Set(event.media.map(m => m.fileID))
    const orphans = (record.media || [])
      .map(m => m && m.fileID)
      .filter(id => id && !kept.has(id))
    orphanFiles.push(...orphans)
  }
  if (event.audio !== undefined && record.audio && record.audio.fileID &&
      !(patch.audio && patch.audio.fileID === record.audio.fileID)) {
    orphanFiles.push(record.audio.fileID)
  }
  if (orphanFiles.length > 0) {
    try {
      await cloud.deleteFile({ fileList: orphanFiles })
    } catch (e) { /* 已删或权限问题，不阻断 */ }
  }

  // ---- 媒体/到访时间变化会改变「最新有图记录」：顺带刷新地点封面（spec 4.4）----
  if (event.media !== undefined || event.happenedAt !== undefined) {
    try {
      const placeRecords = (await db.collection('records')
        .where({ placeId: record.placeId })
        .get()).data
      await db.collection('places').doc(record.placeId).update({
        data: { coverFileID: computeCover(placeRecords) }
      })
    } catch (e) { /* 地点可能已被并发删除，忽略 */ }
  }

  return {}
}
