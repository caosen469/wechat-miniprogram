// 地点页（spec 6.3，T19）：顶部统计条（总次数 / 平均分 / 三档位小计数，
// 三档计数之和 = 总次数——都在 getPlaceDetail 返回的可见记录上现算）+
// 该地点全部记录时间倒序（补记的时间参与排序）、首图缩略卡，点进详情。
const { callApi } = require('../../services/api')
const { formatTime } = require('../../services/formatTime')
const { gradeOf, tierKeyOf, starsOf } = require('../../services/rating')
const { typeLabelOf } = require('../../services/placeTypes')

// 三档位小计数（spec 3）：宝藏 4–5★、还行 3★、踩雷 1–2★（阈值与 services/rating.js 统一）
function statsOf (records) {
  const counts = { good: 0, mid: 0, bad: 0 }
  let sum = 0
  for (const r of records) {
    sum += r.rating || 0
    counts[tierKeyOf(r.rating || 0)]++
  }
  const avg = records.length ? Math.round((sum / records.length) * 10) / 10 : 0
  return { counts, avg }
}

Page({
  data: {
    placeId: '',
    place: null,
    records: [], // getPlaceDetail 返回（时间倒序、可见性过滤、作者已 join）
    stats: null, // {counts: {good, mid, bad}, avg}
    loading: false,
    loadError: ''
  },

  onLoad (options) {
    // 首页带过来的名称先顶着，加载后校准（进入即有标题，不闪空白）
    if (options.name) {
      wx.setNavigationBarTitle({ title: decodeURIComponent(options.name) })
    }
    this.setData({ placeId: options.placeId || '' })
  },

  onShow () {
    // 首次由 onLoad 之后的 onShow 触发加载；之后每次从详情页编辑/删除返回都刷新
    if (this.loaded) {
      this.loadDetail()
      return
    }
    this.loaded = true
    this.loadDetail()
  },

  async loadDetail () {
    if (!this.data.placeId) {
      this.setData({ loadError: '缺少地点' })
      return
    }
    if (this.data.loading) return
    this.setData({ loading: true, loadError: '' })
    try {
      const result = await callApi('getPlaceDetail', { placeId: this.data.placeId })
      const place = {
        ...result.place,
        typeLabel: typeLabelOf(result.place.type)
      }
      const records = (result.records || []).map(r => {
        const cover = (r.media || []).find(m => m.type === 'image')
        return {
          ...r,
          coverFileID: cover ? cover.fileID : '',
          stars: starsOf(r.rating),
          grade: gradeOf(r.rating),
          timeText: formatTime(r.happenedAt || r.createdAt)
        }
      })
      wx.setNavigationBarTitle({ title: place.name })
      this.setData({ place, records, stats: statsOf(records), loading: false })
    } catch (err) {
      this.setData({ loading: false, loadError: err.message || '加载失败' })
    }
  },

  // 点缩略卡 → 记录详情（spec 6.3）
  onOpenRecord (e) {
    wx.navigateTo({ url: `/pages/detail/detail?recordId=${e.currentTarget.dataset.id}` })
  }
})
