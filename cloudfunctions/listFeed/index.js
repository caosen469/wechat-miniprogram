// listFeed —— 简版足迹流水（spec 5.1、4.6；T16）。
// 返回记录数组（默认时间倒序，createdAt），作者昵称头像与地点名称由服务端
// join 返回，前端不做二次请求。可见性过滤经公共 visibility.js（spec 4.6 +
// 4.2 退出成员记录不可见）。非最终形态：T19 升级为地点为一等公民的足迹列表。
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

// before 游标：Date 或 ISO 字符串（callFunction 序列化后是字符串），非法值忽略
function parseBefore (before) {
  if (!before) return null
  const date = before instanceof Date ? before : new Date(before)
  return isNaN(date.getTime()) ? null : date
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

  // ---- 拉记录：placeId 过滤 + createdAt 倒序 ----
  // limit 1000：服务端 get() 默认只取 100 条，显式放宽到上限（家庭圈量级足够）
  const cond = {}
  if (typeof event.placeId === 'string' && event.placeId) {
    cond.placeId = event.placeId
  }
  const recordsRes = await safeGet(
    db.collection('records').where(cond).orderBy('createdAt', 'desc').limit(1000)
  )

  // ---- 过滤 + 游标 + 分页（在可见记录之上切片）----
  const before = parseBefore(event.before)
  const limitRaw = Number(event.limit) || PAGE_DEFAULT
  const limit = Math.min(Math.max(Math.floor(limitRaw), 1), PAGE_MAX)
  const visible = recordsRes.data.filter(r =>
    isVisible(r, OPENID, activeOpenids) &&
    (!before || r.createdAt < before)
  ).slice(0, limit)

  // ---- join：作者昵称头像（spec 5.2）+ 地点名称类型（简版列表展示用）----
  // places 全量拉取后按 placeId 映射（家庭圈量级足够，无需按记录逐个查）
  const memberByOpenid = new Map(allMembersRes.data.map(m => [m.openid, m]))
  const placesRes = await safeGet(db.collection('places').limit(1000))
  const placeById = new Map(placesRes.data.map(p => [p._id, p]))

  const records = visible.map(r => {
    const author = memberByOpenid.get(r.authorId) || null
    const place = placeById.get(r.placeId) || null
    return {
      ...r,
      author: author ? { nickname: author.nickname, avatarUrl: author.avatarUrl } : null,
      place: place ? { name: place.name, type: place.type } : null
    }
  })

  return { records }
}
