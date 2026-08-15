// 提醒授权三件套（T24，spec 8.1 / ADR 0004）：
//   ① 发布成功后引导一次（publish 页弹层，引导勾选「总是保持以上选择，不再询问」）；
//   ② 自然点击点静默续授权（index 红点条点击时调，已勾选后不再弹窗、白攒额度）；
//   ③ 设置页常驻开关（profile 页，关 = 不再请求授权也不再发）。
// 开关状态以服务端为准（members.remindersOff，经 updateProfile 写入）；
// 模板 id 在 config 配置，留空 = 降级路径（spec 10.3）：整套静默不工作，红点兜底。
const { subscribeTemplateId } = require('../config/index')

// 发布后引导只做一次（spec 8.1「引导一次」，本地标记）
const GUIDE_KEY = 'reminder-guided'

// 提醒总开关：服务端 members.remindersOff，缺省视为开
const isOn = me => !(me && me.remindersOff)

// wx.requestSubscribeMessage 必须在用户点击的同步回调里调（T9 调研 1.2：
// 放 onLoad 或异步 await 之后会被拦截），所以本封装只供 tap 处理器直接调用。
// 结果一律静默：拒绝、额度异常（43101）都不打扰用户（spec 8.1 降级原则）
function requestAuth () {
  if (!subscribeTemplateId) return Promise.resolve()
  return new Promise(resolve => {
    wx.requestSubscribeMessage({
      tmplIds: [subscribeTemplateId],
      success: resolve,
      fail: resolve
    })
  })
}

// 发布成功后是否弹引导：模板已配置 + 提醒开着 + 没引导过
function shouldGuide (me) {
  return !!subscribeTemplateId && isOn(me) && !wx.getStorageSync(GUIDE_KEY)
}

function markGuided () {
  wx.setStorageSync(GUIDE_KEY, true)
}

// 自然点击点静默续授权（spec 8.1）：已勾选「总是保持以上选择」后调用不再弹窗，
// 每次点一点就攒一条发送额度；关了提醒的人不再被请求授权
function silentRenew (me) {
  if (subscribeTemplateId && isOn(me)) requestAuth()
}

module.exports = { isOn, requestAuth, shouldGuide, markGuided, silentRenew }
