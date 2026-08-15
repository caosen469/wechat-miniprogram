// 建圈/入圈 onboarding（spec 6.1）：无圈用户落此页。
// 两个入口：创建家庭圈（第一个用户，成为圈主）/ 输入邀请码入圈。
// 昵称头像用微信「头像昵称填写能力」自填：
//   open-type="chooseAvatar" 按钮 + input type="nickname"（spec 2.3 / 6.6）。
const { callApi } = require('../../services/api')

const randId = () => Math.random().toString(36).slice(2, 10)

Page({
  data: {
    mode: 'create', // 'create' 建圈 | 'join' 凭码入圈
    avatarUrl: '', // chooseAvatar 返回的临时文件路径
    nickname: '',
    inviteCode: '',
    submitting: false
  },

  onSwitchMode (e) {
    // 昵称头像在两种模式间共用，切模式不丢
    this.setData({ mode: e.currentTarget.dataset.mode })
  },

  onChooseAvatar (e) {
    this.setData({ avatarUrl: e.detail.avatarUrl })
  },

  onNicknameInput (e) {
    this.setData({ nickname: e.detail.value })
  },

  onInviteCodeInput (e) {
    this.setData({ inviteCode: e.detail.value.toUpperCase() })
  },

  validateCommon () {
    const nickname = this.data.nickname.trim()
    if (!this.data.avatarUrl) {
      wx.showToast({ title: '请先选择头像', icon: 'none' })
      return null
    }
    if (!nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' })
      return null
    }
    return nickname
  },

  // 头像直传云存储拿 fileID（媒体不经云函数中转，spec 2.2）；
  // cloudPath 带时间戳+随机串保证唯一（幂等约定见 spec 7.2）
  async uploadAvatar () {
    const upload = await wx.cloud.uploadFile({
      cloudPath: `avatars/${Date.now()}-${randId()}.png`,
      filePath: this.data.avatarUrl
    })
    return upload.fileID
  },

  async onCreateCircle () {
    if (this.data.submitting) return
    const nickname = this.validateCommon()
    if (!nickname) return

    this.setData({ submitting: true })
    wx.showLoading({ title: '创建中…', mask: true })
    try {
      const avatarFileID = await this.uploadAvatar()
      await callApi('createCircle', { nickname, avatarFileID })
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
  },

  async onJoinCircle () {
    if (this.data.submitting) return
    const nickname = this.validateCommon()
    if (!nickname) return
    const code = this.data.inviteCode.trim()
    if (code.length !== 6) {
      wx.showToast({ title: '请输入 6 位邀请码', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '加入中…', mask: true })
    try {
      const avatarFileID = await this.uploadAvatar()
      await callApi('joinCircle', { code, nickname, avatarFileID })
      wx.hideLoading()
      wx.reLaunch({ url: '/pages/index/index' })
    } catch (err) {
      wx.hideLoading()
      const msg = {
        INVITE_INVALID: '邀请码无效或已过期，请向圈主索取新码',
        CIRCLE_FULL: '家庭成员已满（12 人）',
        ALREADY_IN_CIRCLE: '你已在家庭圈中'
      }[err.code] || err.message || '加入失败，请重试'
      wx.showToast({ title: msg, icon: 'none' })
      this.setData({ submitting: false })
    }
  }
})
