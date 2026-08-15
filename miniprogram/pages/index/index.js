const { callApi } = require('../../services/api')

Page({
  data: {
    checking: true, // 冷启动身份检查中
    checkFailed: false,
    me: null,
    cloudResult: '',
    testing: false
  },

  async onShow () {
    // 每次页面实例只做一次冷启动检查；从 onboarding reLaunch 回来是全新实例，会重新查
    if (this.bootstrapped) return
    this.bootstrapped = true
    await this.checkMembership()
  },

  async checkMembership () {
    this.setData({ checking: true, checkFailed: false })
    try {
      const result = await callApi('bootstrap')
      if (!result.me) {
        // 无圈用户 → onboarding（spec 6.1）
        wx.reLaunch({ url: '/pages/onboarding/onboarding' })
        return
      }
      getApp().globalData.bootstrap = result
      this.setData({ me: result.me, checking: false })
    } catch (err) {
      // bootstrap 失败不阻断：留在本页给重试入口
      this.setData({ checking: false, checkFailed: true })
    }
  },

  async onTestCloud () {
    if (this.data.testing) return
    this.setData({ testing: true, cloudResult: '调用中…' })
    try {
      const res = await wx.cloud.callFunction({ name: 'hello' })
      const { message, openid } = res.result
      this.setData({
        cloudResult: `${message}（openid: ${openid ? openid.slice(0, 6) + '…' : '无'}）`
      })
    } catch (err) {
      this.setData({ cloudResult: `调用失败：${err.errMsg || err.message}` })
    } finally {
      this.setData({ testing: false })
    }
  }
})
