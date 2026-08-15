// markRead —— 红点水位更新（spec 5.1、4.2、8.2）：首页红点条展开最新记录后调用，
// 把调用者的 lastReadAt 推进到当前时间（云函数侧时钟，不信任设备时间）。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function err (code, message) {
  // 异常统一返回 {code, message}（spec 5.2），与 listFeed 等函数同一形态
  return { code, message }
}

// members 集合尚未创建（全新环境）时按空处理，最终走 NOT_IN_CIRCLE 分支
async function safeGet (query) {
  try {
    return await query.get()
  } catch (e) {
    return { data: [] }
  }
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()

  const memberRes = await safeGet(
    db.collection('members').where({ openid: OPENID, status: 'active' })
  )
  const me = memberRes.data[0]
  if (!me) {
    return err('NOT_IN_CIRCLE', '你还不在家庭圈中')
  }

  const now = new Date()
  await db.collection('members').doc(me._id).update({
    data: { lastReadAt: now }
  })
  // 返回服务端写入的时间：前端用它推进本地水位（云函数侧时钟，不信任设备时间）
  return { lastReadAt: now }
}
