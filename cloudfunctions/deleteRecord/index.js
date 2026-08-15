// deleteRecord —— 删除记录（spec 5.1）：能看见就能删除（spec 4.6 可见性过滤）。
// 删文档同时 cloud.deleteFile 删媒体（图/视频/语音）；顺带刷新地点封面
// （封面 = 该地点最新一条记录的首图，spec 4.4，与 publishRecord 同一派生规则）。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function err (code, message) {
  return { code, message }
}

// spec 4.6 可见性过滤规则（所有读路径统一实现；各云函数各持一份副本）
function canSee (record, openid) {
  if (record.visibility === 'family') return true
  if (record.visibility === 'pair') return (record.pairIds || []).includes(openid)
  return record.authorId === openid
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

  // ---- 鉴权：openid → active 成员 ----
  const memberRes = await db.collection('members')
    .where({ openid: OPENID, status: 'active' })
    .get()
  if (memberRes.data.length === 0) {
    return err('NOT_IN_CIRCLE', '你不在家庭圈中')
  }

  // ---- 取记录：不存在与不可见统一 NOT_VISIBLE（spec 5.2）----
  const recordId = typeof event.recordId === 'string' ? event.recordId : ''
  if (!recordId) return err('NOT_VISIBLE', '记录不存在')
  let record
  try {
    record = (await db.collection('records').doc(recordId).get()).data
  } catch (e) {
    return err('NOT_VISIBLE', '记录不存在')
  }
  if (!canSee(record, OPENID)) {
    return err('NOT_VISIBLE', '记录不存在')
  }

  // ---- 删云存储媒体：图/视频 + 语音（失败不阻断删文档，文件可由后台定期清理兜底）----
  const fileIDs = (record.media || [])
    .map(m => m && m.fileID)
    .filter(Boolean)
  if (record.audio && record.audio.fileID) {
    fileIDs.push(record.audio.fileID)
  }
  if (fileIDs.length > 0) {
    try {
      await cloud.deleteFile({ fileList: fileIDs })
    } catch (e) { /* 已删或权限问题，不阻断 */ }
  }

  // ---- 删文档 + 刷新地点封面（剩余记录中最新「有图」记录的首图，无则清空）----
  await db.collection('records').doc(recordId).remove()
  try {
    const rest = (await db.collection('records')
      .where({ placeId: record.placeId })
      .get()).data
    await db.collection('places').doc(record.placeId).update({
      data: { coverFileID: computeCover(rest) }
    })
  } catch (e) { /* 地点可能已被并发删除，忽略 */ }

  return {}
}
