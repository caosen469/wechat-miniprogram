// getRecord —— 记录详情（spec 5.1、4.6；T16 + T18 合并版）。
// 可见者才返回（公共 visibility.js：spec 4.6 三档 + 4.2 退出成员记录不可见）；
// 不存在与不可见统一返回 NOT_VISIBLE，不泄露存在性（spec 5.2：前端对 NOT_VISIBLE 静默）。
// 服务端 join 作者/参与者昵称头像、地点名称类型，并给出到访序号（「第 N 次到访」，
// 按该请求者可见的同地点记录 happenedAt 倒序计）。T20 升级为相册式完整详情。
const cloud = require('wx-server-sdk')
const { isVisible } = require('./visibility')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function err (code, message) {
  // 异常统一返回 {code, message}（spec 5.2）
  return { code, message }
}

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

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()

  // ---- 鉴权 + 可见性前置一次拉齐（spec 5.1、4.2）----
  const allMembersRes = await safeGet(db.collection('members').limit(100))
  const me = allMembersRes.data.find(m => m.openid === OPENID && m.status === 'active')
  if (!me) {
    return err('NOT_IN_CIRCLE', '你还不在家庭圈中')
  }
  const activeOpenids = new Set(
    allMembersRes.data.filter(m => m.status === 'active').map(m => m.openid)
  )

  // ---- 取记录：不存在与不可见一律 NOT_VISIBLE ----
  if (typeof event.recordId !== 'string' || !event.recordId) {
    return err('NOT_VISIBLE', '记录不存在')
  }
  let record = null
  try {
    record = (await db.collection('records').doc(event.recordId).get()).data
  } catch (e) {
    return err('NOT_VISIBLE', '记录不存在')
  }
  if (!record) {
    return err('NOT_VISIBLE', '记录不存在')
  }

  if (!isVisible(record, OPENID, activeOpenids)) {
    return err('NOT_VISIBLE', '记录不存在')
  }

  // ---- join：作者/参与者昵称头像（spec 5.1）+ 地点名称类型（spec 6.4 地点上下文）----
  const memberByOpenid = new Map(allMembersRes.data.map(m => [m.openid, m]))
  const brief = m => m ? { openid: m.openid, nickname: m.nickname, avatarUrl: m.avatarUrl } : null
  const author = brief(memberByOpenid.get(record.authorId))
  const participants = (record.participantIds || [])
    .map(id => brief(memberByOpenid.get(id)))
    .filter(Boolean)
  let place = null
  try {
    place = (await db.collection('places').doc(record.placeId).get()).data
  } catch (e) {
    place = null // 地点文档异常不阻断详情
  }

  // ---- 到访序号：该请求者可见的同地点记录按时间倒序取位次 ----
  // limit 1000：服务端 get() 默认只取 100 条，显式放宽到上限（家庭圈量级足够）
  const placeRecordsRes = await safeGet(
    db.collection('records').where({ placeId: record.placeId }).limit(1000)
  )
  const visibleIds = placeRecordsRes.data
    .filter(r => isVisible(r, OPENID, activeOpenids))
    .sort(byTimeDesc)
    .map(r => r._id)
  // 倒序列表第 i 位 = 正数第 (总可见数 - i) 次到访；目标不在列表（理论不会；
  // 同地点记录超 1000 条窗口时可能发生——家庭圈量级不触发）回退 1
  const idx = visibleIds.indexOf(record._id)
  const visitNo = idx >= 0 ? visibleIds.length - idx : 1

  return {
    record: { ...record, participants },
    author,
    place: place ? { name: place.name, type: place.type } : null,
    visitNo
  }
}
