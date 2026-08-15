// publishRecord —— 发布回忆记录（spec 5.1、4.4/4.5 字段表，T15 + T18）。
// 可见范围三档：family（默认）/ pair（固化 circles.pairIds 创建时快照）/ private；
// 参与者多选（须为 active 成员，不含作者）；补记时间 happenedAt（默认现在，拒绝未来）。
// 新地点按 poiId 查重归并（手动地点 poiId=null 不参与自动归并）；
// 媒体约束服务端复核（图 ≤9、视频 ≤3 且每段 ≤60s、合计 ≤12）。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

// 与 miniprogram/services/mediaRules.js 的 LIMITS 保持一致（前端即时拦截，服务端复核）
const MEDIA_LIMITS = {
  IMAGE_MAX: 9,
  VIDEO_MAX: 3,
  VIDEO_DURATION_MAX: 60,
  TOTAL_MAX: 12
}
const TEXT_MAX = 500
const PLACE_NAME_MAX_LEN = 50
const PLACE_TYPES = ['restaurant', 'attraction', 'accommodation', 'other']
const VISIBILITIES = ['family', 'pair', 'private']

function err (code, message) {
  // 异常统一返回 {code, message}（spec 5.2）
  return { code, message }
}

// 全新环境 places/records 集合可能尚未创建，首次写入前先补建
// （已存在时报错，忽略即可；与 createCircle 的补建约定一致）
async function ensureCollection (name) {
  try {
    await db.createCollection(name)
  } catch (e) { /* 已存在 */ }
}

// 媒体服务端复核：[{fileID, type: 'image'|'video', duration?}]，可为空（原型允许未配媒体）
function validateMedia (media) {
  if (!Array.isArray(media)) {
    return '媒体格式不正确'
  }
  if (media.length > MEDIA_LIMITS.TOTAL_MAX) {
    return `图片加视频最多 ${MEDIA_LIMITS.TOTAL_MAX} 个`
  }
  let images = 0
  let videos = 0
  for (const item of media) {
    if (!item || typeof item.fileID !== 'string' || !item.fileID) {
      return '存在无效的媒体文件'
    }
    if (item.type === 'image') {
      images++
      if (images > MEDIA_LIMITS.IMAGE_MAX) {
        return `图片最多 ${MEDIA_LIMITS.IMAGE_MAX} 张`
      }
    } else if (item.type === 'video') {
      if (typeof item.duration !== 'number' || item.duration <= 0) {
        return '视频缺少有效时长'
      }
      if (item.duration > MEDIA_LIMITS.VIDEO_DURATION_MAX) {
        return `每段视频不能超过 ${MEDIA_LIMITS.VIDEO_DURATION_MAX} 秒`
      }
      videos++
      if (videos > MEDIA_LIMITS.VIDEO_MAX) {
        return `视频最多 ${MEDIA_LIMITS.VIDEO_MAX} 段`
      }
    } else {
      return '媒体类型只能是图片或视频'
    }
  }
  return null
}

function validateNewPlace (newPlace) {
  if (!newPlace || typeof newPlace !== 'object') {
    return '缺少新地点信息'
  }
  if (typeof newPlace.name !== 'string' || !newPlace.name.trim() || newPlace.name.trim().length > PLACE_NAME_MAX_LEN) {
    return `地点名称必填且不超过 ${PLACE_NAME_MAX_LEN} 字`
  }
  if (!PLACE_TYPES.includes(newPlace.type)) {
    return '请选择地点类型'
  }
  return null
}

// 参与者须全部是 active 成员且不含作者（作者隐含，spec 4.5）
function validateParticipantIds (participantIds, activeOpenids, authorOpenid) {
  if (!Array.isArray(participantIds)) {
    return '参与者格式不正确'
  }
  for (const id of participantIds) {
    if (typeof id !== 'string' || !id) {
      return '存在无效的参与者'
    }
    if (id === authorOpenid) {
      return '参与者不用包含你自己'
    }
    if (!activeOpenids.includes(id)) {
      return '参与者必须是在圈成员'
    }
  }
  return null
}

// 补记时间：接受 Date/ISO 字符串/时间戳，拒绝未来（spec 4.5 happenedAt 可改、默认现在）
function parseHappenedAt (value) {
  if (value === undefined || value === null) {
    return { date: new Date() }
  }
  const date = value instanceof Date ? value : new Date(value)
  if (isNaN(date.getTime())) {
    return { error: '补记时间无效' }
  }
  if (date.getTime() > Date.now() + 60 * 1000) {
    return { error: '补记时间不能是未来' }
  }
  return { date }
}

// 封面派生规则（spec 4.4），publishRecord/updateRecord/deleteRecord 三个写路径统一：
// 按 happenedAt 最新的一条「有图」记录的首图；无任何有图记录则 null。
// 补记的旧时间记录不会覆盖更新的封面；无图记录不会清掉已有封面。
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

  // ---- 鉴权：openid → active 成员（spec 5.1）----
  const memberRes = await db.collection('members')
    .where({ openid: OPENID, status: 'active' })
    .get()
  if (memberRes.data.length === 0) {
    return err('NOT_IN_CIRCLE', '你还不在家庭圈中')
  }

  // ---- 可见范围三档（spec 4.5/4.6）----
  const visibility = event.visibility === undefined ? 'family' : event.visibility
  if (!VISIBILITIES.includes(visibility)) {
    return err('VALIDATION_FAILED', '可见范围只能是家庭圈 / 仅我俩 / 仅自己')
  }
  let pairIds
  if (visibility === 'pair') {
    // pair 档固化 circles.pairIds 创建时快照（spec 4.5，重指不影响历史记录）
    const circleRes = await db.collection('circles').limit(1).get()
    pairIds = (circleRes.data[0] || {}).pairIds || []
    if (pairIds.length !== 2) {
      return err('VALIDATION_FAILED', '「仅我俩」需要圈主先在设置中指定另一半')
    }
    // 只有二人组成员能发 pair 档：否则作者自己都看不见这条记录（spec 4.6）
    if (!pairIds.includes(OPENID)) {
      return err('VALIDATION_FAILED', '「仅我俩」只面向圈主指定的二人组')
    }
  }

  // ---- 参与者：从 active 成员中多选，可跳过（spec 4.5）----
  const activeOpenids = (await db.collection('members')
    .where({ status: 'active' })
    .get()).data.map(m => m.openid)
  const participantIds = event.participantIds === undefined ? [] : event.participantIds
  const participantError = validateParticipantIds(participantIds, activeOpenids, OPENID)
  if (participantError) return err('VALIDATION_FAILED', participantError)

  // ---- 补记时间：默认现在，可改（spec 4.5）----
  const happened = parseHappenedAt(event.happenedAt)
  if (happened.error) return err('VALIDATION_FAILED', happened.error)

  // ---- 校验：媒体 / 文字 / 星级（服务端复核，spec 5.1）----
  const mediaError = validateMedia(event.media)
  if (mediaError) return err('VALIDATION_FAILED', mediaError)

  const text = typeof event.text === 'string' ? event.text.trim() : ''
  if (text.length > TEXT_MAX) {
    return err('VALIDATION_FAILED', `吐槽不能超过 ${TEXT_MAX} 字`)
  }

  const rating = event.rating
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return err('VALIDATION_FAILED', '请打 1–5 星评分')
  }

  // ---- 地点解析：placeId 直用；newPlace 先按 poiId 归并、再按同名归并 ----
  await ensureCollection('places')
  await ensureCollection('records')
  let place = null
  if (typeof event.placeId === 'string' && event.placeId) {
    try {
      const placeRes = await db.collection('places').doc(event.placeId).get()
      place = placeRes.data
    } catch (e) {
      return err('VALIDATION_FAILED', '地点不存在')
    }
  } else if (event.newPlace) {
    const placeError = validateNewPlace(event.newPlace)
    if (placeError) return err('VALIDATION_FAILED', placeError)

    const name = event.newPlace.name.trim()
    const poiId = typeof event.newPlace.poiId === 'string' && event.newPlace.poiId
      ? event.newPlace.poiId
      : null
    // 归并键 1（spec 4.4）：同 poiId 视为同店，类型继承首打卡选定不覆盖
    if (poiId) {
      const existed = await db.collection('places').where({ poiId }).get()
      if (existed.data.length > 0) {
        place = existed.data[0]
      }
    }
    // 归并键 2（2026-08-15 真机反馈）：poiId 未命中（手动地点 poiId=null，
    // 或 POI id 变了）时按同名精确归并——「清华大学」打三次卡合为一个地点。
    // 替代原 ADR 0001「手动地点不参与自动归并」的约定
    if (!place) {
      const byName = await db.collection('places').where({ name }).get()
      if (byName.data.length > 0) {
        place = byName.data[0]
      }
    }
    if (!place) {
      const { latitude, longitude } = event.newPlace.location || {}
      const newDoc = {
        poiId,
        name,
        type: event.newPlace.type,
        location: (typeof latitude === 'number' && typeof longitude === 'number')
          ? new db.Geo.Point(longitude, latitude)
          : null, // 手动新地点可以没有坐标
        coverFileID: null,
        createdBy: OPENID,
        createdAt: new Date()
      }
      const added = await db.collection('places').add({ data: newDoc })
      place = { _id: added._id, ...newDoc }
    }
  } else {
    return err('VALIDATION_FAILED', '请选择打卡地点')
  }

  // ---- 建记录（spec 4.5 字段表；pairIds 仅 pair 档固化快照）----
  const now = new Date()
  const record = {
    placeId: place._id,
    authorId: OPENID,
    participantIds,
    media: event.media,
    text,
    audio: null,
    rating,
    visibility,
    ...(visibility === 'pair' ? { pairIds } : {}),
    happenedAt: happened.date,
    collectionId: null,
    createdAt: now,
    updatedAt: now
  }
  const added = await db.collection('records').add({ data: record })

  // ---- 封面顺带刷新：最新一条「有图」记录的首图（spec 4.4；补记旧时间不覆盖）----
  const placeRecords = (await db.collection('records')
    .where({ placeId: place._id })
    .get()).data
  const cover = computeCover(placeRecords)
  if (cover !== place.coverFileID) {
    await db.collection('places').doc(place._id).update({
      data: { coverFileID: cover }
    })
  }

  return { recordId: added._id, placeId: place._id }
}
