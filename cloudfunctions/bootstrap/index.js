// bootstrap —— 冷启动鉴权底座（spec 5.1）。
// 鉴权链路：openid（云开发自动注入）→ 查成员身份与状态 → 决定后续可见范围。
// 这条链路是所有业务云函数的第一步，后续函数照此成形。
// 不在圈（无 active 成员记录）返回 { me: null }，前端据此进入 onboarding。
const cloud = require('wx-server-sdk')
const { isVisible } = require('./visibility')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

// 全新环境下业务集合尚未创建，读失败按空处理（首次建圈时 createCircle 会补建集合）
async function safeGet (query) {
  try {
    return await query.get()
  } catch (err) {
    return { data: [] }
  }
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()

  // openid → 成员身份与状态
  const memberRes = await safeGet(
    db.collection('members').where({ openid: OPENID, status: 'active' })
  )
  const me = memberRes.data[0]
  if (!me) {
    return { me: null }
  }

  const circleRes = await safeGet(db.collection('circles').limit(1))
  const circle = circleRes.data[0] || null

  // 成员列表含退出/被移除成员（记录保留、查询时按 status 过滤，ADR 0002；设置页要显示状态）
  const allMembersRes = await safeGet(db.collection('members').limit(100))
  const members = allMembersRes.data

  // 未读数（spec 4.2）：createdAt > 水位线 且对本人可见（spec 4.6 公共过滤，
  // 与 listFeed/listPlaces 同口径）且非本人所发（自己发的不给自己红点）。
  // 水位线：lastReadAt（首次 markRead 前）回退到 joinedAt，避免入圈即满屏红点。
  // 家庭圈 4–6 人量级，全量拉取后函数内过滤（spec 4.4 派生值同理，无需下推查询）。
  const watermark = me.lastReadAt || me.joinedAt
  let unreadCount = 0
  if (watermark) {
    const watermarkTs = new Date(watermark).getTime()
    if (!isNaN(watermarkTs)) {
      const activeOpenids = new Set(
        members.filter(m => m.status === 'active').map(m => m.openid)
      )
      const recordsRes = await safeGet(db.collection('records').limit(1000))
      unreadCount = recordsRes.data.filter(r =>
        isVisible(r, OPENID, activeOpenids) &&
        r.authorId !== OPENID &&
        new Date(r.createdAt).getTime() > watermarkTs
      ).length
    }
  }

  return { me, circle, members, unreadCount }
}
