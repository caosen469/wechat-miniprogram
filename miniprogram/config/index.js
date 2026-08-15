// 环境配置：唯一需要手填的地方。
// 开通云开发后，把「环境 ID」填到 env（它不是 AppID！见 docs/setup/environment.md）。
// 留空时 wx.cloud.init 走默认环境（账号下只有一个环境时可用）。
// tencentMapKey：腾讯位置服务 WebServiceAPI key（发布页「当前位置一键打卡」逆地址反查
// 最近 POI 用），在 lbs.qq.com 申请后填入；留空时该通道降级为提示改用其他通道。
// subscribeTemplateId：「新日志提醒」订阅消息模板 id（备忘录类目，T24，spec 8.1），
// 与 cloudfunctions/sendReminders/index.js 的 config.templateId 保持一致；
// 留空 = 走预设降级路径（spec 10.3）：不请求授权、不发推送，只用站内红点提醒。
module.exports = {
  env: '',
  tencentMapKey: '',
  subscribeTemplateId: 'SrxJDhkAa9CZIDsHCwB3UdijgXc3H-cFaNFAn9qbpY8'
}
