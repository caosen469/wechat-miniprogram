const { env } = require('./config/index')
const { flush } = require('./services/uploadQueue')

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
    // 弱网补传触发（spec 7.2）：恢复联网即补传
    wx.onNetworkStatusChange(res => {
      if (res.isConnected && res.networkType !== 'none') flush()
    })
  },

  onShow () {
    // 回前台补传（后台 5 秒网络请求被中断，回来再补，spec 7.1）
    flush()
  }
})
