const { env } = require('./config/index')

App({
  globalData: {
    // bootstrap 云函数的冷启动结果 {me, circle, members, unreadCount}，登录跳转的判断依据
    bootstrap: null
  },

  onLaunch () {
    if (env) {
      wx.cloud.init({ env, traceUser: true })
    } else {
      // env 未填写时走默认环境；有多个环境时必须填 docs/setup/environment.md 里记录的环境 ID
      wx.cloud.init({ traceUser: true })
    }
  }
})
