// 阶段 0 测试云函数：验证「部署 + 小程序端调用 + openid 自动注入」整条链路。
// 阶段 1 起被 bootstrap 等业务函数替代，保留作环境健康检查。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

exports.main = async () => {
  const { OPENID } = cloud.getWXContext()
  return {
    message: 'Hello World from cloud function',
    openid: OPENID
  }
}
