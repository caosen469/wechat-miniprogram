// createCircle —— 建圈（spec 5.1）：全库仅允许一个家庭圈，创建者即圈主。
// 生成 circles 与 members 文档各一条，字段见 spec 4.1/4.2 字段表。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

const NICKNAME_MAX_LEN = 30

function err (code, message) {
  // 异常统一返回 {code, message}（spec 5.2）
  return { code, message }
}

// 全新环境集合可能尚未创建，建圈前先补建（已存在时报错，忽略即可）
async function ensureCollection (name) {
  try {
    await db.createCollection(name)
  } catch (e) { /* 已存在 */ }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const nickname = typeof event.nickname === 'string' ? event.nickname.trim() : ''
  const avatarFileID = typeof event.avatarFileID === 'string' ? event.avatarFileID.trim() : ''

  if (!nickname || nickname.length > NICKNAME_MAX_LEN) {
    return err('VALIDATION_FAILED', `昵称必填且不超过 ${NICKNAME_MAX_LEN} 字`)
  }
  if (!avatarFileID) {
    return err('VALIDATION_FAILED', '头像不能为空')
  }

  await ensureCollection('circles')
  await ensureCollection('members')

  // 已在圈（active）的用户不能再建圈
  const selfRes = await db.collection('members')
    .where({ openid: OPENID, status: 'active' })
    .get()
  if (selfRes.data.length > 0) {
    return err('ALREADY_IN_CIRCLE', '你已在家庭圈中，无需再建')
  }

  // 单圈模型：全库已有圈子则拒绝。
  // 4–6 人家庭量级，两个无圈用户同时建圈的竞态窗口可忽略，先检查后写入即可
  const circleCount = await db.collection('circles').count()
  if (circleCount.total > 0) {
    return err('CIRCLE_EXISTS', '家庭圈已存在，请向圈主索取邀请码入圈')
  }

  const now = new Date()

  const circle = {
    ownerId: OPENID,
    pairIds: [], // 指定「另一半」后才填充（spec 4.1）
    createdAt: now
  }
  const circleAdded = await db.collection('circles').add({ data: circle })

  const member = {
    openid: OPENID,
    nickname,
    avatarUrl: avatarFileID, // 云存储 fileID，头像昵称填写能力上传（spec 4.2）
    role: 'owner',
    status: 'active',
    joinedAt: now,
    leftAt: null,
    lastReadAt: null
  }
  const memberAdded = await db.collection('members').add({ data: member })

  return {
    circle: { _id: circleAdded._id, ...circle },
    member: { _id: memberAdded._id, ...member }
  }
}
