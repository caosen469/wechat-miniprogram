// joinCircle —— 凭邀请码入圈（spec 5.1）：码有效且未过期未作废、active 成员 < 12，
// 收集昵称头像。曾退出/被移除的成员凭新码再次入圈时重新激活原成员文档
// （openid 是唯一索引，不能新建第二条）。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const NICKNAME_MAX_LEN = 30
const MEMBER_LIMIT = 12

function err (code, message) {
  return { code, message }
}

// 全新环境集合可能尚未创建，先补建（已存在时报错，忽略即可）
async function ensureCollection (name) {
  try {
    await db.createCollection(name)
  } catch (e) { /* 已存在 */ }
}

async function safeGet (query) {
  try {
    return await query.get()
  } catch (e) {
    return { data: [] }
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const code = typeof event.code === 'string' ? event.code.trim().toUpperCase() : ''
  const nickname = typeof event.nickname === 'string' ? event.nickname.trim() : ''
  const avatarFileID = typeof event.avatarFileID === 'string' ? event.avatarFileID.trim() : ''

  if (!nickname || nickname.length > NICKNAME_MAX_LEN) {
    return err('VALIDATION_FAILED', `昵称必填且不超过 ${NICKNAME_MAX_LEN} 字`)
  }
  if (!avatarFileID) {
    return err('VALIDATION_FAILED', '头像不能为空')
  }
  if (!code) {
    return err('INVITE_INVALID', '请输入邀请码')
  }

  await ensureCollection('invite_codes')
  await ensureCollection('members')

  // 码校验：存在、未作废、未过期（spec 5.1）
  const codeRes = await safeGet(db.collection('invite_codes').where({ code }))
  const invite = codeRes.data[0]
  if (!invite || invite.revoked || invite.expiresAt <= new Date()) {
    return err('INVITE_INVALID', '邀请码无效或已过期，请向圈主索取新码')
  }

  // 已在圈的不能再入
  const activeRes = await safeGet(
    db.collection('members').where({ openid: OPENID, status: 'active' })
  )
  if (activeRes.data.length > 0) {
    return err('ALREADY_IN_CIRCLE', '你已在家庭圈中')
  }

  // 成员上限 12（spec 5.1：在云函数校验）
  const activeCount = await db.collection('members').where({ status: 'active' }).count()
  if (activeCount.total >= MEMBER_LIMIT) {
    return err('CIRCLE_FULL', '家庭成员已满（12 人）')
  }

  const now = new Date()
  const existing = await safeGet(db.collection('members').where({ openid: OPENID }))
  const old = existing.data[0]

  if (old) {
    // 重新激活：保留 joinedAt 原值语义（重新入圈算新加入时间），状态与资料重置
    const data = {
      nickname,
      avatarUrl: avatarFileID,
      status: 'active',
      joinedAt: now,
      leftAt: null
    }
    await db.collection('members').doc(old._id).update({ data })
    return { member: { _id: old._id, openid: OPENID, role: old.role, lastReadAt: null, ...data } }
  }

  const member = {
    openid: OPENID,
    nickname,
    avatarUrl: avatarFileID, // 云存储 fileID，头像昵称填写能力上传（spec 4.2）
    role: 'member',
    status: 'active',
    joinedAt: now,
    leftAt: null,
    lastReadAt: null
  }
  const memberAdded = await db.collection('members').add({ data: member })

  return { member: { _id: memberAdded._id, ...member } }
}
