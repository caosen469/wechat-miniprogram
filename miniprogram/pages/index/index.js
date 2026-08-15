// 首页·简版足迹流水（spec 6.2 简版形态，T16）：记录时间倒序流水。
// 非最终形态——T19 升级为地点为一等公民的足迹列表（封面拼图/均分/次数/地图段控）。
// 每次进入本页刷新（发布返回后新记录立即可见）；右下角常驻打卡按钮跳发布页。
const { callApi } = require('../../services/api')
const { formatTime } = require('../../services/formatTime')
const { gradeOf, starsOf } = require('../../services/rating')

Page({
  data: {
    checking: true, // 冷启动身份检查中
    checkFailed: false,
    checkError: '',
    me: null,
    records: [], // listFeed 返回的记录流水（含 author/place join）
    loadingFeed: false,
    feedError: ''
  },

  async onShow () {
    // 冷启动身份检查每个页面实例只做一次（从 onboarding reLaunch 回来是全新实例）；
    // 已检查过则只刷新流水——发布页返回后新记录立即可见
    if (this.bootstrapped) {
      this.loadFeed()
      return
    }
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
      await this.loadFeed()
    } catch (err) {
      // bootstrap 失败不阻断：留在本页给重试入口，并展示真实错误便于排查
      this.setData({
        checking: false,
        checkFailed: true,
        checkError: err.errMsg || err.message || String(err)
      })
    }
  },

  async loadFeed () {
    if (this.data.loadingFeed) return
    this.setData({ loadingFeed: true, feedError: '' })
    try {
      const result = await callApi('listFeed')
      const records = (result.records || []).map(r => {
        const cover = (r.media || []).find(m => m.type === 'image')
        return {
          ...r,
          coverFileID: cover ? cover.fileID : '',
          stars: starsOf(r.rating),
          grade: gradeOf(r.rating),
          // 展示到访时间（补记后即补记时间，与列表排序一致）；老数据缺字段时回退 createdAt
          timeText: formatTime(r.happenedAt || r.createdAt)
        }
      })
      this.setData({ records, loadingFeed: false })
    } catch (err) {
      // 非静默类错误给一行可重试的提示（NOT_VISIBLE 语义不适用于列表本身）
      this.setData({ loadingFeed: false, feedError: err.message || '加载失败' })
    }
  },

  onOpenRecord (e) {
    wx.navigateTo({ url: `/pages/detail/detail?recordId=${e.currentTarget.dataset.id}` })
  },

  // 右下角打卡按钮 → 发布页（spec 6.2）
  onTapPublish () {
    wx.navigateTo({ url: '/pages/publish/publish' })
  }
})
