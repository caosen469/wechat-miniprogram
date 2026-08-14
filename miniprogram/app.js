const { env } = require('./config/index')

App({
  onLaunch () {
    if (env) {
      wx.cloud.init({ env, traceUser: true })
    } else {
      // env 未填写时走默认环境；有多个环境时必须填 docs/setup/environment.md 里记录的环境 ID
      wx.cloud.init({ traceUser: true })
    }
  }
})
