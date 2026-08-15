// revokeInviteCode —— 作废邀请码（spec 5.1）：仅圈主可调，作废后凭该码入圈被拒。
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
  const code = typeof event.code === 'string' ? event.code.trim().toUpperCase() : ''

  const me = await getActiveMember(OPENID)
  if (!me) {
    return err('NOT_IN_CIRCLE', '你不在家庭圈中')
  }
  if (me.role !== 'owner') {
    return err('NOT_OWNER', '仅圈主可以作废邀请码')
  }
  if (!code) {
    return err('VALIDATION_FAILED', '缺少邀请码')
  }

  let docRes
  try {
    docRes = await db.collection('invite_codes').where({ code }).get()
  } catch (e) {
    docRes = { data: [] }
  }
  const target = docRes.data[0]
  if (!target) {
    return err('INVITE_INVALID', '邀请码不存在')
  }

  await db.collection('invite_codes').doc(target._id).update({
    data: { revoked: true }
  })

  return {}
}
