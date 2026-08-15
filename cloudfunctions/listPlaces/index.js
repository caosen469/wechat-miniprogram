// listPlaces —— 足迹列表聚合（spec 5.1、6.2）：首页地点为一等公民的定稿形态。
// 每个地点聚合其全部「可见」记录（spec 4.6 三档 + 4.2 退出成员不可见）：
// 均分 / 到访次数 / 情绪档位分布（宝藏 4–5★、还行 3★、踩雷 1–2★）——派生值
// 不落库，每次现算（spec 4.4）。封面为最新有图记录的首图、最多 4 张拼图，
// 同样基于可见记录现算（纯 private 记录的首图不会成为他人看到的封面）。
// 排序按最近一次到访时间倒序。
//
// 家庭圈 4–6 人量级，取全量记录在函数内聚合（spec 4.4 同理：无需下推到查询）。
const cloud = require('wx-server-sdk')
const { isVisible } = require('./visibility')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const COVER_MAX = 4

function err (code, message) {
  // 异常统一返回 {code, message}（spec 5.2）
  return { code, message }
}

// records / places 集合尚不存在（还没人发布过）时按空处理，与 listFeed 的 safeGet 约定一致
async function safeGet (query) {
  try {
    return await query.get()
  } catch (e) {
    return { data: [] }
  }
}

const happenedTs = r => new Date(r.happenedAt).getTime()

// 排序：happenedAt 倒序（补记语义），同 happenedAt 按 createdAt 决胜（与 listFeed 一致）
function byTimeDesc (a, b) {
  const d = happenedTs(b) - happenedTs(a)
  return d !== 0 ? d : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
}

// 情绪档位（spec 3）：评分映射三档——宝藏 4–5★、还行 3★、踩雷 1–2★
const tierOfRating = rating => (rating >= 4 ? 'good' : rating === 3 ? 'mid' : 'bad')

// 一条记录的首图 fileID；无图（或纯视频）返回 null
const firstImageOf = r => {
  const image = (r.media || []).find(m => m && m.type === 'image' && m.fileID)
  return image ? image.fileID : null
}

// 单个地点的聚合卡片：覆盖 listPlaces 的全部派生值
function aggregatePlace (place, records) {
  const sorted = records.slice().sort(byTimeDesc)
  const sum = sorted.reduce((acc, r) => acc + (r.rating || 0), 0)
  const tierCounts = { good: 0, mid: 0, bad: 0 }
  for (const r of sorted) {
    tierCounts[tierOfRating(r.rating || 0)]++
  }
  const covers = []
  for (const r of sorted) {
    const image = firstImageOf(r)
    if (image) covers.push(image)
    if (covers.length >= COVER_MAX) break
  }
  return {
    _id: place._id,
    name: place.name,
    type: place.type,
    location: place.location || null,
    // 均分保留 1 位小数；次数为 0 的地点根本不会出现在列表里，sum 不必除零
    avgRating: Math.round((sum / sorted.length) * 10) / 10,
    visitCount: sorted.length,
    tierCounts,
    covers,
    lastVisitedAt: sorted[0].happenedAt
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()

  // ---- 三次读取彼此独立，并行拉齐后先鉴权（spec 5.1、4.2）----
  const [allMembersRes, recordsRes, placesRes] = await Promise.all([
    safeGet(db.collection('members').limit(100)),
    safeGet(db.collection('records').limit(1000)),
    safeGet(db.collection('places').limit(1000))
  ])
  const me = allMembersRes.data.find(m => m.openid === OPENID && m.status === 'active')
  if (!me) {
    return err('NOT_IN_CIRCLE', '你还不在家庭圈中')
  }
  const activeOpenids = new Set(
    allMembersRes.data.filter(m => m.status === 'active').map(m => m.openid)
  )

  // ---- 全量记录：可见性过滤后按地点分桶 ----
  const byPlace = new Map()
  for (const r of recordsRes.data) {
    if (!isVisible(r, OPENID, activeOpenids)) continue
    if (!byPlace.has(r.placeId)) byPlace.set(r.placeId, [])
    byPlace.get(r.placeId).push(r)
  }

  // ---- 逐个聚合（引用的地点已不存在时跳过）----
  const cards = placesRes.data
    .filter(p => byPlace.has(p._id))
    .map(p => aggregatePlace(p, byPlace.get(p._id)))
    .sort((a, b) => new Date(b.lastVisitedAt).getTime() - new Date(a.lastVisitedAt).getTime())

  return { places: cards }
}
