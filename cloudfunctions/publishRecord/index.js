// publishRecord —— 发布回忆记录·简化版（spec 5.1、4.4/4.5 字段表，T15）。
// 可见范围/参与者/语音/补记时间均不做：visibility 恒 'family'。
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

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()

  // ---- 鉴权：openid → active 成员（spec 5.1）----
  const memberRes = await db.collection('members')
    .where({ openid: OPENID, status: 'active' })
    .get()
  if (memberRes.data.length === 0) {
    return err('NOT_IN_CIRCLE', '你还不在家庭圈中')
  }

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

  // ---- 地点解析：placeId 直用；newPlace 按 poiId 归并（poiId=null 手动地点每次新建）----
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

    const poiId = typeof event.newPlace.poiId === 'string' && event.newPlace.poiId
      ? event.newPlace.poiId
      : null
    if (poiId) {
      // 同 poiId 视为同店，归并到已有地点（类型继承首打卡选定，不覆盖，spec 4.4）
      const existed = await db.collection('places').where({ poiId }).get()
      if (existed.data.length > 0) {
        place = existed.data[0]
      }
    }
    if (!place) {
      const { latitude, longitude } = event.newPlace.location || {}
      const newDoc = {
        poiId,
        name: event.newPlace.name.trim(),
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

  // ---- 建记录（spec 4.5 字段表；简化版固定值见文件头注释）----
  const now = new Date()
  const record = {
    placeId: place._id,
    authorId: OPENID,
    participantIds: [],
    media: event.media,
    text,
    audio: null,
    rating,
    visibility: 'family',
    happenedAt: now,
    collectionId: null,
    createdAt: now,
    updatedAt: now
  }
  const added = await db.collection('records').add({ data: record })

  // ---- 封面顺带刷新：最新一条记录的首图（spec 4.4）----
  const firstImage = event.media.find(m => m.type === 'image')
  if (firstImage && place.coverFileID !== firstImage.fileID) {
    await db.collection('places').doc(place._id).update({
      data: { coverFileID: firstImage.fileID }
    })
  }

  return { recordId: added._id, placeId: place._id }
}
