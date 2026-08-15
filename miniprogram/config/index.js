// 环境配置：唯一需要手填的地方。
// 开通云开发后，把「环境 ID」填到 env（它不是 AppID！见 docs/setup/environment.md）。
// 留空时 wx.cloud.init 走默认环境（账号下只有一个环境时可用）。
// tencentMapKey：腾讯位置服务 WebServiceAPI key（发布页「当前位置一键打卡」逆地址反查
// 最近 POI 用），在 lbs.qq.com 申请后填入；留空时该通道降级为提示改用其他通道。
module.exports = {
  env: '',
  tencentMapKey: ''
}
