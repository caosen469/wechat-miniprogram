// 设置页（tab 2「我的」，spec 6.6）：我的资料、成员列表与状态、
// 圈主专属操作（邀请码/移除成员）、退出家庭圈（圈主无此项，注明不可退出）。
// 「指定另一半」留待 T18。数据每次 onShow 调 bootstrap 拉最新（成员/状态常变）。
const { callApi } = require('../../services/api')

const randId = () => Math.random().toString(36).slice(2, 10)

const STATUS_LABELS = {
  owner: '圈主',
  member: '成员',
  left: '已退出',
  removed: '已被移除'
}

Page({
  data: {
    loading: true,
    loadFailed: false,
    me: null,
    isOwner: false,
    members: [], // { _id, nickname, avatarUrl, roleLabel }
    // 编辑资料
    editing: false,
    editAvatarUrl: '',
    editNickname: '',
    savingProfile: false,
    // 圈主：邀请码
    inviteCode: null, // { code, expiresAt }
    generating: false,
    // 危险操作
    leaving: false
  },

  onShow () {
    this.loadBootstrap()
  },

  async loadBootstrap () {
    this.setData({ loading: true, loadFailed: false })
    try {
      const result = await callApi('bootstrap')
      if (!result.me) {
        // 身份被移除/退出后回到 onboarding（spec 6.1）
        wx.reLaunch({ url: '/pages/onboarding/onboarding' })
        return
      }
      getApp().globalData.bootstrap = result
      this.applyBootstrap(result)
    } catch (err) {
      this.setData({ loadFailed: true, loading: false })
    }
  },

  applyBootstrap (result) {
    this.setData({
      loading: false,
      me: result.me,
      isOwner: result.me.role === 'owner',
      members: (result.members || []).map(m => ({
        _id: m._id,
        nickname: m.nickname,
        avatarUrl: m.avatarUrl,
        openid: m.openid,
        status: m.status,
        role: m.role,
        // 已退出/被移除的显示状态，active 的显示角色
        roleLabel: m.status === 'active' ? STATUS_LABELS[m.role] : STATUS_LABELS[m.status]
      }))
    })
  },

  // ---- 我的资料（updateProfile） ----

  onStartEdit () {
    this.setData({
      editing: true,
      editAvatarUrl: '',
      editNickname: this.data.me.nickname
    })
  },

  onEditChooseAvatar (e) {
    this.setData({ editAvatarUrl: e.detail.avatarUrl })
  },

  onEditNicknameInput (e) {
    this.setData({ editNickname: e.detail.value })
  },

  onCancelEdit () {
    this.setData({ editing: false })
  },

  async onSaveProfile () {
    if (this.data.savingProfile) return
    const nickname = this.data.editNickname.trim()
    if (!nickname) {
      wx.showToast({ title: '昵称不能为空', icon: 'none' })
      return
    }

    this.setData({ savingProfile: true })
    wx.showLoading({ title: '保存中…', mask: true })
    try {
      const payload = { nickname }
      if (this.data.editAvatarUrl) {
        // 换了头像才上传（头像直传云存储，媒体不经云函数中转，spec 2.2）
        const upload = await wx.cloud.uploadFile({
          cloudPath: `avatars/${Date.now()}-${randId()}.png`,
          filePath: this.data.editAvatarUrl
        })
        payload.avatarFileID = upload.fileID
      }
      await callApi('updateProfile', payload)
      wx.hideLoading()
      wx.showToast({ title: '已保存', icon: 'success' })
      this.setData({ editing: false })
      this.loadBootstrap()
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '保存失败', icon: 'none' })
    } finally {
      this.setData({ savingProfile: false })
    }
  },

  // ---- 圈主：邀请码（createInviteCode / revokeInviteCode） ----

  async onGenerateInviteCode () {
    if (this.data.generating) return
    this.setData({ generating: true })
    try {
      const result = await callApi('createInviteCode')
      const invite = result.inviteCode
      this.setData({
        inviteCode: {
          code: invite.code,
          expiresText: this.formatExpiresAt(invite.expiresAt)
        }
      })
    } catch (err) {
      wx.showToast({ title: err.message || '生成失败', icon: 'none' })
    } finally {
      this.setData({ generating: false })
    }
  },

  onCopyInviteCode () {
    wx.setClipboardData({
      data: this.data.inviteCode.code,
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    })
  },

  onRevokeInviteCode () {
    const code = this.data.inviteCode.code
    wx.showModal({
      title: '作废邀请码',
      content: `作废后 ${code} 将无法用于入圈`,
      confirmText: '作废',
      confirmColor: '#e64340',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await callApi('revokeInviteCode', { code })
          this.setData({ inviteCode: null })
          wx.showToast({ title: '已作废', icon: 'success' })
        } catch (err) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' })
        }
      }
    })
  },

  formatExpiresAt (expiresAt) {
    // 云函数返回的 Date 经序列化是 ISO 字符串
    const d = new Date(expiresAt)
    const pad = n => String(n).padStart(2, '0')
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} 失效`
  },

  // ---- 圈主：移除成员（removeMember） ----

  onRemoveMember (e) {
    const { id, name } = e.currentTarget.dataset
    wx.showModal({
      title: '移除成员',
      content: `移除后「${name}」将看不到家庭圈内容，其历史记录保留`,
      confirmText: '移除',
      confirmColor: '#e64340',
      success: async (res) => {
        if (!res.confirm) return
        try {
          await callApi('removeMember', { memberId: id })
          wx.showToast({ title: '已移除', icon: 'success' })
          this.loadBootstrap()
        } catch (err) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' })
        }
      }
    })
  },

  // ---- 退出家庭圈（leaveCircle，圈主无此项） ----

  onLeaveCircle () {
    if (this.data.leaving) return
    wx.showModal({
      title: '退出家庭圈',
      content: '退出后将看不到家庭圈的记录，历史记录会保留',
      confirmText: '退出',
      confirmColor: '#e64340',
      success: async (res) => {
        if (!res.confirm) return
        this.setData({ leaving: true })
        try {
          await callApi('leaveCircle')
          wx.reLaunch({ url: '/pages/onboarding/onboarding' })
        } catch (err) {
          wx.showToast({ title: err.message || '操作失败', icon: 'none' })
          this.setData({ leaving: false })
        }
      }
    })
  }
})
