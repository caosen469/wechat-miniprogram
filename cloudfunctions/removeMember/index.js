// removeMember —— 圈主移除成员（spec 5.1）：仅圈主可调，不可移除自己。
// 被移除者 status 置 'removed'，文档保留（ADR 0002），下次冷启动 bootstrap
// 查不到 active 记录，自动落回 onboarding。
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

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const memberId = typeof event.memberId === 'string' ? event.memberId.trim() : ''

  const me = await getActiveMember(OPENID)
  if (!me) {
    return err('NOT_IN_CIRCLE', '你不在家庭圈中')
  }
  if (me.role !== 'owner') {
    return err('NOT_OWNER', '仅圈主可以移除成员')
  }
  if (!memberId) {
    return err('VALIDATION_FAILED', '缺少成员')
  }

  let target
  try {
    target = await db.collection('members').doc(memberId).get()
  } catch (e) {
    return err('VALIDATION_FAILED', '成员不存在')
  }
  const member = target.data
  if (member.openid === OPENID) {
    return err('VALIDATION_FAILED', '不可移除自己')
  }
  if (member.status !== 'active') {
    return err('VALIDATION_FAILED', '该成员已不在圈中')
  }

  await db.collection('members').doc(memberId).update({
    data: { status: 'removed', leftAt: new Date() }
  })

  return {}
}
