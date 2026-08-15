// getPlaceDetail —— 地点详情（spec 5.1）：{place, records[]}，records 按
// happenedAt 时间倒序（同 happenedAt 按 createdAt 决胜，与 listFeed 一致）、
// 可见性过滤经公共 visibility.js（spec 4.6 + 4.2 退出成员记录不可见）、
// 服务端 join 作者/参与者昵称头像。
const cloud = require('wx-server-sdk')
const { isVisible } = require('./visibility')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function err (code, message) {
  return { code, message }
}

const happenedTs = r => new Date(r.happenedAt).getTime()

function byTimeDesc (a, b) {
  const d = happenedTs(b) - happenedTs(a)
  return d !== 0 ? d : new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()

  // ---- 鉴权 + 可见性前置一次拉齐（spec 5.1、4.2）----
  const allMembersRes = await db.collection('members').limit(100).get()
  const me = allMembersRes.data.find(m => m.openid === OPENID && m.status === 'active')
  if (!me) {
    return err('NOT_IN_CIRCLE', '你不在家庭圈中')
  }
  const activeOpenids = new Set(
    allMembersRes.data.filter(m => m.status === 'active').map(m => m.openid)
  )

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

  // ---- 该地点记录：可见性过滤（spec 4.6 + 4.2）→ 时间倒序 → join ----
  let records
  try {
    records = (await db.collection('records').where({ placeId }).limit(1000).get()).data
  } catch (e) {
    records = []
  }
  const memberByOpenid = new Map(allMembersRes.data.map(m => [m.openid, m]))
  // 成员索引含已退出/被移除成员：其参与的记录仍需展示昵称头像（记录保留，ADR 0002）
  const brief = m => m ? { openid: m.openid, nickname: m.nickname, avatarUrl: m.avatarUrl } : null
  const list = records
    .filter(r => isVisible(r, OPENID, activeOpenids))
    .sort(byTimeDesc)
    .map(r => ({
      ...r,
      author: brief(memberByOpenid.get(r.authorId)),
      participants: (r.participantIds || [])
        .map(id => brief(memberByOpenid.get(id)))
        .filter(Boolean)
    }))

  return { place, records: list }
}
