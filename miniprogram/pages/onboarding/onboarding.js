// 建圈 onboarding（spec 6.1）：无圈用户落此页，走「创建家庭圈」成为圈主。
// 昵称头像用微信「头像昵称填写能力」自填：
//   open-type="chooseAvatar" 按钮 + input type="nickname"（spec 2.3 / 6.6）。
// 邀请码入圈入口留占位，后续工单补。
const { callApi } = require('../../services/api')

const randId = () => Math.random().toString(36).slice(2, 10)

Page({
  data: {
    avatarUrl: '', // chooseAvatar 返回的临时文件路径
    nickname: '',
    submitting: false
  },

  onChooseAvatar (e) {
    this.setData({ avatarUrl: e.detail.avatarUrl })
  },

  onNicknameInput (e) {
    this.setData({ nickname: e.detail.value })
  },

  async onCreateCircle () {
    if (this.data.submitting) return
    const nickname = this.data.nickname.trim()
    if (!this.data.avatarUrl) {
      wx.showToast({ title: '请先选择头像', icon: 'none' })
      return
    }
    if (!nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '创建中…', mask: true })
    try {
      // 头像直传云存储拿 fileID（媒体不经云函数中转，spec 2.2）；
      // cloudPath 带时间戳+随机串保证唯一（幂等约定见 spec 7.2）
      const upload = await wx.cloud.uploadFile({
        cloudPath: `avatars/${Date.now()}-${randId()}.png`,
        filePath: this.data.avatarUrl
      })
      await callApi('createCircle', { nickname, avatarFileID: upload.fileID })
      wx.hideLoading()
      wx.reLaunch({ url: '/pages/index/index' })
    } catch (err) {
      wx.hideLoading()
      const msg = {
        CIRCLE_EXISTS: '家庭圈已存在，请向圈主索取邀请码',
        ALREADY_IN_CIRCLE: '你已在家庭圈中'
      }[err.code] || err.message || '创建失败，请重试'
      wx.showToast({ title: msg, icon: 'none' })
      this.setData({ submitting: false })
    }
  }
})
