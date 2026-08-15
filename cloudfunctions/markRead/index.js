// markRead —— 红点水位（spec 5.1、8.2）：把当前成员 members.lastReadAt 更新为
// 「现在」。首页红点条「N 条新回忆」点击展开最新记录后调用，之后
// bootstrap.unreadCount 以新水位重新统计（红点消失）。水位语义见 spec 4.2：
// 新记录数 = records.createdAt > lastReadAt 且可见。
// 幂等：重复调用只是把水位推到更晚，无副作用；入参为空。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

// members 集合尚不存在（理论上不会：入圈时已建）时按不在圈处理，与 bootstrap 一致
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
    db.collection('members').where({ openid: OPENID, status: 'active' }).limit(1)
  )
  const me = memberRes.data[0]
  if (!me) {
    return { code: 'NOT_IN_CIRCLE', message: '你还不在家庭圈中' }
  }

  // 水位更新为当前时间（云函数侧时钟，避免依赖设备时间）
  await db.collection('members').doc(me._id).update({
    data: { lastReadAt: new Date() }
  })

  return { ok: true }
}
