// updateProfile —— 修改我的资料（spec 5.1）：active 成员可改昵称、头像、提醒开关，至少传一项。
// 提醒开关（T24，spec 8.1）：remindersOn=false 落 members.remindersOff=true，
// 云端 sendReminders 与前端续授权都以此为准——关 = 不再请求授权也不再发。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const NICKNAME_MAX_LEN = 30

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

  const me = await getActiveMember(OPENID)
  if (!me) {
    return err('NOT_IN_CIRCLE', '你不在家庭圈中')
  }

  const data = {}
  if (event.nickname !== undefined) {
    const nickname = typeof event.nickname === 'string' ? event.nickname.trim() : ''
    if (!nickname || nickname.length > NICKNAME_MAX_LEN) {
      return err('VALIDATION_FAILED', `昵称必填且不超过 ${NICKNAME_MAX_LEN} 字`)
    }
    data.nickname = nickname
  }
  if (event.avatarFileID !== undefined) {
    const avatarFileID = typeof event.avatarFileID === 'string' ? event.avatarFileID.trim() : ''
    if (!avatarFileID) {
      return err('VALIDATION_FAILED', '头像不能为空')
    }
    data.avatarUrl = avatarFileID
  }
  if (event.remindersOn !== undefined) {
    if (typeof event.remindersOn !== 'boolean') {
      return err('VALIDATION_FAILED', '提醒开关参数无效')
    }
    data.remindersOff = !event.remindersOn
  }
  if (Object.keys(data).length === 0) {
    return err('VALIDATION_FAILED', '没有要修改的内容')
  }

  await db.collection('members').doc(me._id).update({ data })

  return {}
}
