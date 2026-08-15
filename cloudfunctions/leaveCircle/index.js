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

  return {}
}
