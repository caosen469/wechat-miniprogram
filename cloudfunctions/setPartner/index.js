// setPartner —— 圈主指定/更换另一半（spec 5.1、4.1）。
// 只改 circles.pairIds（当前二人组，仅用于新记录固化快照与圈主重指），
// 不动任何历史记录——旧 pair 记录保留创建时快照（spec 4.5，快照语义非引用）。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

function err (code, message) {
  return { code, message }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext()
  const partnerOpenid = typeof event.partnerOpenid === 'string' ? event.partnerOpenid.trim() : ''

  // ---- 鉴权：active 成员 → 圈主 ----
  const memberRes = await db.collection('members')
    .where({ openid: OPENID, status: 'active' })
    .get()
  const me = memberRes.data[0]
  if (!me) {
    return err('NOT_IN_CIRCLE', '你不在家庭圈中')
  }
  if (me.role !== 'owner') {
    return err('NOT_OWNER', '仅圈主可以指定另一半')
  }
  if (!partnerOpenid) {
    return err('VALIDATION_FAILED', '缺少另一半')
  }
  if (partnerOpenid === OPENID) {
    return err('VALIDATION_FAILED', '另一半得是另一位成员')
  }

  // ---- 校验目标：须为 active 成员 ----
  const targetRes = await db.collection('members')
    .where({ openid: partnerOpenid, status: 'active' })
    .get()
  if (targetRes.data.length === 0) {
    return err('VALIDATION_FAILED', '找不到这位成员')
  }

  // ---- 只改 circles.pairIds，不动历史记录（spec 4.1/4.5）----
  const circleRes = await db.collection('circles').limit(1).get()
  const circle = circleRes.data[0]
  if (!circle) {
    return err('VALIDATION_FAILED', '圈子数据异常，请联系开发者')
  }
  await db.collection('circles').doc(circle._id).update({
    data: { pairIds: [OPENID, partnerOpenid] }
  })

  return {}
}
