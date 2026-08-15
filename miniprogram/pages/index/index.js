// 首页·足迹列表（spec 6.2 定稿形态，T19）：地点为一等公民。
// 每张地点卡片 = listPlaces 聚合的封面拼图（1 图或 4 图拼图）+ 地点名 + 类型
// + 均分 ★ + 到访次数 + 情绪档位徽章（按均分映射）；点卡片进地点页。
// 每次进入本页刷新（发布返回后新聚合立即可见）；右下角常驻打卡按钮跳发布页。
const { callApi } = require('../../services/api')
const { gradeOf, tierKeyOf, starsOf } = require('../../services/rating')
const { typeLabelOf } = require('../../services/placeTypes')

Page({
  data: {
    checking: true, // 冷启动身份检查中
    checkFailed: false,
    checkError: '',
    me: null,
    places: [], // listPlaces 聚合的地点卡片
    loadingPlaces: false,
    placesError: ''
  },

  async onShow () {
    // 冷启动身份检查每个页面实例只做一次（从 onboarding reLaunch 回来是全新实例）；
    // 已检查过则只刷新聚合——发布/编辑/删除返回后数字与封面立即更新
    if (this.bootstrapped) {
      this.loadPlaces()
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
      await this.loadPlaces()
    } catch (err) {
      // bootstrap 失败不阻断：留在本页给重试入口，并展示真实错误便于排查
      this.setData({
        checking: false,
        checkFailed: true,
        checkError: err.errMsg || err.message || String(err)
      })
    }
  },

  async loadPlaces () {
    if (this.data.loadingPlaces) return
    this.setData({ loadingPlaces: true, placesError: '' })
    try {
      const result = await callApi('listPlaces')
      const places = (result.places || []).map(p => {
        // 均分 → 情绪档位：先四舍五入到整数星，再走评分的三档映射（spec 3）
        const rounded = Math.round(p.avgRating)
        return {
          ...p,
          typeLabel: typeLabelOf(p.type),
          // 均分展示：星串按四舍五入的整数星，数值保留 1 位小数
          stars: starsOf(rounded),
          avgText: p.avgRating.toFixed(1),
          grade: gradeOf(rounded),
          gradeKey: tierKeyOf(rounded)
        }
      })
      this.setData({ places, loadingPlaces: false })
    } catch (err) {
      this.setData({ loadingPlaces: false, placesError: err.message || '加载失败' })
    }
  },

  // 点地点卡片 → 地点页（spec 6.3）：名称先带上，加载后再校准导航栏标题
  onOpenPlace (e) {
    const { id, name } = e.currentTarget.dataset
    wx.navigateTo({
      url: `/pages/place/place?placeId=${id}&name=${encodeURIComponent(name || '')}`
    })
  },

  // 右下角打卡按钮 → 发布页（spec 6.2）
  onTapPublish () {
    wx.navigateTo({ url: '/pages/publish/publish' })
  }
})
