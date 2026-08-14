Page({
  data: {
    cloudResult: '',
    testing: false
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
