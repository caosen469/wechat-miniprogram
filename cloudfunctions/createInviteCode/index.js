// createInviteCode —— 生成邀请码（spec 5.1、4.3 字段表）：仅圈主可调。
// 6 位大写字母数字码（去掉易混淆的 0/O/1/I），24 小时有效，可重复使用（多人凭同一码入圈）。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

// 排除易混淆字符的字母表；6 位 32 字符集 ≈ 10 亿组合，家庭量级碰撞极小，撞了重生成即可
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LEN = 6
const VALID_HOURS = 24

function err (code, message) {
  // 异常统一返回 {code, message}（spec 5.2）
  return { code, message }
}

// 全新环境集合可能尚未创建，先补建（已存在时报错，忽略即可）
async function ensureCollection (name) {
  try {
    await db.createCollection(name)
  } catch (e) { /* 已存在 */ }
}

// openid → active 成员；不在圈返回 null（读失败按无圈处理）
async function getActiveMember (openid) {
  try {
    const res = await db.collection('members').where({ openid, status: 'active' }).get()
    return res.data[0] || null
  } catch (e) {
    return null
  }
}

function randomCode () {
  let code = ''
  for (let i = 0; i < CODE_LEN; i++) {
    code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
  }
  return code
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()

  const me = await getActiveMember(OPENID)
  if (!me) {
    return err('NOT_IN_CIRCLE', '你不在家庭圈中')
  }
  if (me.role !== 'owner') {
    return err('NOT_OWNER', '仅圈主可以生成邀请码')
  }

  await ensureCollection('invite_codes')

  // 唯一索引兜底：极小概率撞码时换一个重试；重试耗尽仍未拿到空闲码则报错，
  // 绝不写入未检查过的码（会撞唯一索引）
  let code = null
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = randomCode()
    const clash = await db.collection('invite_codes').where({ code: candidate }).count()
    if (clash.total === 0) {
      code = candidate
      break
    }
  }
  if (!code) {
    return err('VALIDATION_FAILED', '邀请码生成失败，请重试')
  }

  const now = new Date()
  const inviteCode = {
    code,
    createdAt: now,
    expiresAt: new Date(now.getTime() + VALID_HOURS * 3600 * 1000),
    revoked: false,
    createdBy: OPENID
  }
  await db.collection('invite_codes').add({ data: inviteCode })

  return { inviteCode }
}
