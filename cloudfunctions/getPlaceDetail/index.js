// getPlaceDetail —— 地点详情（spec 5.1）：{place, records[]}，records 按
// happenedAt 时间倒序、可见性过滤（spec 4.6）、服务端 join 作者/参与者昵称头像。
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

// openid → 昵称头像索引。含已退出/被移除成员：其记录保留（ADR 0002），展示仍需昵称头像
async function memberIndex () {
  const res = await db.collection('members').limit(100).get()
  const map = {}
  for (const m of res.data) {
    map[m.openid] = { openid: m.openid, nickname: m.nickname, avatarUrl: m.avatarUrl }
  }
  return map
}

function withJoined (record, members) {
  const brief = id => members[id] || { openid: id, nickname: '曾经的成员', avatarUrl: '' }
  return {
    ...record,
    author: brief(record.authorId),
    participants: (record.participantIds || []).map(brief)
  }
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

  // ---- 地点 ----
  const placeId = typeof event.placeId === 'string' ? event.placeId : ''
  if (!placeId) {
    return err('VALIDATION_FAILED', '缺少地点')
  }
  let place
  try {
    place = (await db.collection('places').doc(placeId).get()).data
  } catch (e) {
    return err('VALIDATION_FAILED', '地点不存在')
  }

  // ---- 该地点记录：可见性过滤（spec 4.6）→ happenedAt 倒序 ----
  let records
  try {
    records = (await db.collection('records').where({ placeId }).limit(100).get()).data
  } catch (e) {
    records = []
  }
  const list = records
    .filter(r => canSee(r, OPENID))
    .sort((a, b) => new Date(b.happenedAt).getTime() - new Date(a.happenedAt).getTime())

  const members = await memberIndex()
  return { place, records: list.map(r => withJoined(r, members)) }
}
