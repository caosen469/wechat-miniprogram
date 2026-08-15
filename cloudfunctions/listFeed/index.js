// listFeed —— 记录流水（spec 5.1、4.6；T16 + T18 合并版）。
// 按 happenedAt 时间倒序（补记排位正确，spec 4.5），同一 happenedAt 按
// createdAt 决胜（T16 列表的发布序）；可见性过滤经公共 visibility.js
// （spec 4.6 三档 + 4.2 退出成员记录不可见）；作者/参与者昵称头像与地点
// 名称类型由服务端 join，前端不做二次请求。before/after 游标 + limit 分页。
//
// 家庭圈 4–6 人量级，取全量记录在函数内过滤后分页（spec 4.4 派生值同理：
// 量级小，无需把可见性下推到查询条件）。
const cloud = require('wx-server-sdk')
const { isVisible } = require('./visibility')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const PAGE_DEFAULT = 20
const PAGE_MAX = 50

function err (code, message) {
  // 异常统一返回 {code, message}（spec 5.2）
  return { code, message }
}

// records 集合尚不存在（还没人发布过）时按空处理，与 bootstrap 的 safeGet 约定一致
async function safeGet (query) {
  try {
    return await query.get()
  } catch (e) {
    return { data: [] }
  }
}

// 游标解析（Date 或 ISO 字符串——callFunction 序列化后是字符串），非法值忽略：
//   before — happenedAt ≤ 游标（翻页，≤ 因补记只精确到分钟）
//   after  — createdAt > 游标（红点条展开最新未读用，与 bootstrap.unreadCount 同水位语义）
function parseCursor (value) {
  if (!value) return null
  const date = value instanceof Date ? value : new Date(value)
  return isNaN(date.getTime()) ? null : date
}

const happenedTs = r => new Date(r.happenedAt).getTime()

// 排序：happenedAt 倒序（补记语义），同 happenedAt 按 createdAt 决胜
function byTimeDesc (a, b) {
  const d = happenedTs(b) - happenedTs(a)
  return d !== 0 ? d : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()

  // ---- 鉴权 + 可见性前置一次拉齐（spec 5.1、4.2）----
  // 全量 members 一次取回：请求者 active 与否即鉴权答案，active 集合供可见性过滤
  const allMembersRes = await safeGet(db.collection('members').limit(100))
  const me = allMembersRes.data.find(m => m.openid === OPENID && m.status === 'active')
  if (!me) {
    return err('NOT_IN_CIRCLE', '你还不在家庭圈中')
  }
  const activeOpenids = new Set(
    allMembersRes.data.filter(m => m.status === 'active').map(m => m.openid)
  )

  // ---- 拉记录：placeId 过滤（limit 1000 放宽服务端默认 100 条，家庭圈量级足够）----
  const cond = {}
  if (typeof event.placeId === 'string' && event.placeId) {
    cond.placeId = event.placeId
  }
  const recordsRes = await safeGet(db.collection('records').where(cond).limit(1000))

  // ---- 过滤 + 游标 + 排序 + 分页（在可见记录之上切片）----
  const before = parseCursor(event.before)
  const after = parseCursor(event.after)
  const limitRaw = Number(event.limit) || PAGE_DEFAULT
  const limit = Math.min(Math.max(Math.floor(limitRaw), 1), PAGE_MAX)
  const visible = recordsRes.data.filter(r =>
    isVisible(r, OPENID, activeOpenids) &&
    // before 游标用 ≤：补记只精确到分钟，同一分钟的记录用 < 会被永久跳过；
    // 代价是游标本身可能重复出现在下一页，由前端按 _id 去重
    (!before || happenedTs(r) <= before.getTime()) &&
    // after 游标用 >（严格晚于）：与 bootstrap.unreadCount 的未读口径一致
    (!after || new Date(r.createdAt).getTime() > after.getTime())
  ).sort(byTimeDesc)

  // ---- join：作者/参与者昵称头像（spec 5.1）+ 地点名称类型（简版列表展示用）----
  // places 全量拉取后按 placeId 映射（家庭圈量级足够，无需按记录逐个查）
  const memberByOpenid = new Map(allMembersRes.data.map(m => [m.openid, m]))
  const placesRes = await safeGet(db.collection('places').limit(1000))
  const placeById = new Map(placesRes.data.map(p => [p._id, p]))
  // 成员索引含已退出/被移除成员：其参与的记录仍需展示昵称头像（记录保留，ADR 0002）
  const brief = m => m ? { openid: m.openid, nickname: m.nickname, avatarUrl: m.avatarUrl } : null

  const records = visible.slice(0, limit).map(r => {
    const place = placeById.get(r.placeId) || null
    return {
      ...r,
      author: brief(memberByOpenid.get(r.authorId)),
      participants: (r.participantIds || [])
        .map(id => brief(memberByOpenid.get(id)))
        .filter(Boolean),
      place: place ? { name: place.name, type: place.type } : null
    }
  })

  return { records }
}
