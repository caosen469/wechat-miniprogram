// leaveCircle —— 自退家庭圈（spec 5.1）：active 成员可退，圈主不可退（MVP 圈主不可转让）。
// 退出后 status 置 'left'，文档保留（历史记录不可见不可改，ADR 0002）。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function err (code, message) {
  return { code, message }
}

async function getActiveMember (openid) {
  try {
    const res = await db.collection('members').where({ openid, status: 'active' }).get()
    return res.data[0] || null
  } catch (e) {
    return null
  }
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()

  const me = await getActiveMember(OPENID)
  if (!me) {
    return err('NOT_IN_CIRCLE', '你不在家庭圈中')
  }
  if (me.role === 'owner') {
    return err('VALIDATION_FAILED', '圈主不可退出家庭圈')
  }

  await db.collection('members').doc(me._id).update({
    data: { status: 'left', leftAt: new Date() }
  })

  // 自退的若是另一半：清空 circles.pairIds，设置页不再显示旧搭档；
  // 旧 pair 记录保留创建时快照，不受影响（spec 4.5）
  try {
    const circleRes = await db.collection('circles').limit(1).get()
    const circle = circleRes.data[0]
    if (circle && (circle.pairIds || []).includes(OPENID)) {
      await db.collection('circles').doc(circle._id).update({
        data: { pairIds: [] }
      })
    }
  } catch (e) { /* circles 异常不阻断退出本身 */ }

  return {}
}
