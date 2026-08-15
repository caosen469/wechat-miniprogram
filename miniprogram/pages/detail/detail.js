// 记录详情·简化版（spec 6.4 简版形态，T16 + T18）：大图 + 文字 + 星级 +
// 地点上下文 + 参与者（服务端 join）+ 删除（能看见就能删除，二次确认）。
// 非最终形态——T20 升级为相册式完整版（图视频混排翻页 + 语音条 + 编辑）。
// NOT_VISIBLE 静默处理（spec 5.2：列表里可能已被删，不弹错），直接返回。
const { callApi } = require('../../services/api')
const { typeLabelOf } = require('../../services/placeTypes')
const { formatTime } = require('../../services/formatTime')
const { gradeOf, starsOf } = require('../../services/rating')

Page({
  data: {
    loading: true,
    loadError: '',
    record: null,
    author: null,
    place: null,
    visitNo: 0,
    participants: [], // 同行者昵称头像（getRecord 服务端 join）
    deleting: false,
    media: [] // [{fileID, type, src, isVideo}]：图片 src=cloud://fileID 直显，视频需临时链接
  },

  onLoad (options) {
    this.recordId = options.recordId || ''
    this.load()
  },

  async load () {
    this.setData({ loading: true, loadError: '' })
    try {
      const result = await callApi('getRecord', { recordId: this.recordId })
      const media = await this.resolveMedia(result.record.media || [])
      this.setData({
        loading: false,
        record: {
          ...result.record,
          stars: starsOf(result.record.rating),
          grade: gradeOf(result.record.rating),
          // 到访时间（补记后即补记时间）；老数据缺字段时回退 createdAt
          timeText: formatTime(result.record.happenedAt || result.record.createdAt)
        },
        author: result.author,
        place: result.place
          ? { ...result.place, typeLabel: typeLabelOf(result.place.type) }
          : null,
        visitNo: result.visitNo,
        participants: result.record.participants || [],
        media
      })
    } catch (err) {
      if (err.code === 'NOT_VISIBLE') {
        // 静默返回（spec 5.2）：无上一页时退回首页
        wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) })
        return
      }
      this.setData({ loading: false, loadError: err.message || '加载失败' })
    }
  },

  // 图片 <image> 支持 cloud:// 直显；<video> 需 https 临时链接（spec 阶段 1 易卡点）
  async resolveMedia (media) {
    const videos = media.filter(m => m.type === 'video')
    const urlByFileID = {}
    if (videos.length > 0) {
      try {
        const res = await wx.cloud.getTempFileURL({
          fileList: videos.map(v => v.fileID)
        })
        for (const f of res.fileList || []) {
          if (f.tempFileURL) urlByFileID[f.fileID] = f.tempFileURL
        }
      } catch (e) { /* 临时链接失败按缺视频处理，不阻断详情 */ }
    }
    return media.map(m => ({
      ...m,
      isVideo: m.type === 'video',
      src: m.type === 'video' ? (urlByFileID[m.fileID] || '') : m.fileID
    }))
  },

  onPreviewImage (e) {
    const current = e.currentTarget.dataset.src
    const urls = this.data.media.filter(m => !m.isVideo).map(m => m.src)
    wx.previewImage({ current, urls })
  },

  onRetry () {
    this.load()
  },

  // 删除（T18：能看见就能删除；二次确认；媒体文件由云函数一并删）
  onDelete () {
    if (this.data.deleting) return
    wx.showModal({
      title: '删除记录',
      content: '删除后照片和视频也会一并清除，无法恢复',
      confirmText: '删除',
      confirmColor: '#e64340',
      success: async (res) => {
        if (!res.confirm) return
        this.setData({ deleting: true })
        try {
          await callApi('deleteRecord', { recordId: this.recordId })
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) }), 600)
        } catch (err) {
          if (err.code === 'NOT_VISIBLE') {
            // 已被他人删除：静默返回（spec 5.2）
            wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) })
            return
          }
          wx.showToast({ title: err.message || '删除失败', icon: 'none' })
          this.setData({ deleting: false })
        }
      }
    })
  }
})
