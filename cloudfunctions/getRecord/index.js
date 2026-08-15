// getRecord —— 记录详情（spec 5.1）：可见者才返回（spec 4.6 过滤）。
// 不存在与不可见统一返回 NOT_VISIBLE——前端对 NOT_VISIBLE 静默处理
// （记录可能已被删，spec 5.2），不给请求者泄露「存在但看不见」的信息。
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

  // ---- 取记录：不存在与不可见统一 NOT_VISIBLE ----
  const recordId = typeof event.recordId === 'string' ? event.recordId : ''
  if (!recordId) {
    return err('NOT_VISIBLE', '记录不存在')
  }
  let record
  try {
    record = (await db.collection('records').doc(recordId).get()).data
  } catch (e) {
    return err('NOT_VISIBLE', '记录不存在')
  }
  if (!canSee(record, OPENID)) {
    return err('NOT_VISIBLE', '记录不存在')
  }

  const members = await memberIndex()
  return { record: withJoined(record, members) }
}
