// listFeed —— 记录流水（spec 5.1）：时间倒序（按 happenedAt，补记排位正确），
// 可见性过滤（spec 4.6），服务端 join 作者/参与者昵称头像（前端无二次请求）。
// before 游标翻页：只返回 happenedAt 早于 before 的记录。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const PAGE_SIZE = 20

function err (code, message) {
  return { code, message }
}

// spec 4.6 可见性过滤规则（所有读路径统一实现；listFeed/getRecord/getPlaceDetail 各持一份副本）
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

  // ---- 鉴权：openid → active 成员（spec 5.1；被移除/自退成员一律 NOT_IN_CIRCLE）----
  const memberRes = await db.collection('members')
    .where({ openid: OPENID, status: 'active' })
    .get()
  if (memberRes.data.length === 0) {
    return err('NOT_IN_CIRCLE', '你不在家庭圈中')
  }

  // ---- 拉记录：placeId 可选过滤（records 集合尚不存在按空处理）----
  let records
  try {
    let query = db.collection('records')
    if (typeof event.placeId === 'string' && event.placeId) {
      query = query.where({ placeId: event.placeId })
    }
    records = (await query.limit(100).get()).data
  } catch (e) {
    records = []
  }

  // ---- 可见性过滤（spec 4.6）→ before 游标 → happenedAt 倒序 ----
  let list = records.filter(r => canSee(r, OPENID))
  if (event.before !== undefined && event.before !== null) {
    const before = new Date(event.before)
    if (!isNaN(before.getTime())) {
      // 用 ≤ 而非 <：补记只精确到分钟，同一分钟的记录跨页时用 < 会被永久跳过；
      // 代价是游标本身可能重复出现在下一页，由前端按 _id 去重
      list = list.filter(r => new Date(r.happenedAt).getTime() <= before.getTime())
    }
  }
  list.sort((a, b) => new Date(b.happenedAt).getTime() - new Date(a.happenedAt).getTime())

  const members = await memberIndex()
  return { records: list.slice(0, PAGE_SIZE).map(r => withJoined(r, members)) }
}
