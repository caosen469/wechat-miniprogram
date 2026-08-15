// 记录详情·相册式完整版（spec 6.4，T20）：大图横滑翻页（图与视频混排）+
// 固定地点上下文（地点名/类型/「第 N 次到访」）+ 星级与情绪档位徽章 + 吐槽文字 +
// 语音条（播放三角 + 波形 + 时长，点击播放/停止）+ 元信息（作者/时间/参与者/
// 「仅我俩」标识）+ 右上角「···」编辑/删除（复用 T18 能力：能看见就能编辑/删除）。
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
    media: [], // [{fileID, type, src, isVideo}]：图片 src=cloud://fileID 直显，视频需临时链接
    audio: null, // {duration, src}：src 为临时链接（<audio> 播放需 https）
    audioPlaying: false,
    deleting: false
  },

  onLoad (options) {
    this.recordId = options.recordId || ''
    this.load()
  },

  // 仅从编辑页返回时刷新（onEdit 置 needRefresh）；
  // 无条件重载会让切后台回前台也闪「加载中」、掐断播放中的语音
  onShow () {
    if (this.recordId && this.hasLoaded && this.needRefresh) {
      this.needRefresh = false
      this.load()
    }
  },

  onUnload () {
    if (this.audioCtx) {
      this.audioCtx.destroy()
      this.audioCtx = null
    }
  },

  async load () {
    this.setData({ loading: true, loadError: '' })
    try {
      const result = await callApi('getRecord', { recordId: this.recordId })
      this.hasLoaded = true
      this.stopAudio()
      const rawAudio = result.record.audio
      const audio = rawAudio && rawAudio.fileID
        ? { fileID: rawAudio.fileID, duration: rawAudio.duration, src: '' }
        : null
      // 视频 + 语音的临时链接一次批量取（各发一次是两次串行往返）
      const urlByFileID = await this.fetchTempURLs(result.record.media || [], audio)
      const media = (result.record.media || []).map(m => ({
        ...m,
        isVideo: m.type === 'video',
        src: m.type === 'video' ? (urlByFileID[m.fileID] || '') : m.fileID
      }))
      if (audio) audio.src = urlByFileID[audio.fileID] || ''
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
        media,
        audio
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

  // 图片 <image> 支持 cloud:// 直显；<video>/<audio> 需 https 临时链接（阶段 1 易卡点）。
  // 失败按缺文件处理（条子/占位仍在，点击时可重试），不阻断详情
  async fetchTempURLs (media, audio) {
    const fileIDs = [
      ...media.filter(m => m.type === 'video').map(m => m.fileID),
      ...(audio ? [audio.fileID] : [])
    ]
    if (fileIDs.length === 0) return {}
    try {
      const res = await wx.cloud.getTempFileURL({ fileList: fileIDs })
      const urlByFileID = {}
      for (const f of res.fileList || []) {
        if (f.tempFileURL) urlByFileID[f.fileID] = f.tempFileURL
      }
      return urlByFileID
    } catch (e) {
      return {}
    }
  },

  // 语音临时链接失效时只重取音频本身，不整页重载
  async refreshAudioSrc () {
    const audio = this.data.audio
    if (!audio) return
    const urlByFileID = await this.fetchTempURLs([], audio)
    if (urlByFileID[audio.fileID]) {
      this.setData({ audio: { ...audio, src: urlByFileID[audio.fileID] } })
    }
  },

  onPreviewImage (e) {
    const current = e.currentTarget.dataset.src
    const urls = this.data.media.filter(m => !m.isVideo).map(m => m.src)
    wx.previewImage({ current, urls })
  },

  // ---- 语音条（spec 6.4：点击播放/停止）----
  async onAudioToggle () {
    if (this.data.audioPlaying) {
      this.stopAudio()
      return
    }
    const audio = this.data.audio
    if (!audio) return
    if (!audio.src) {
      wx.showToast({ title: '语音加载失败，正在重试', icon: 'none' })
      await this.refreshAudioSrc() // 临时链接可能过期，只重取音频链接
      return
    }
    if (!this.audioCtx) {
      this.audioCtx = wx.createInnerAudioContext()
      this.audioCtx.onEnded(() => this.setData({ audioPlaying: false }))
      this.audioCtx.onError(() => {
        this.setData({ audioPlaying: false })
        wx.showToast({ title: '播放失败', icon: 'none' })
      })
    }
    this.audioCtx.stop()
    this.audioCtx.src = audio.src
    this.audioCtx.play()
    this.setData({ audioPlaying: true })
  },

  stopAudio () {
    if (this.audioCtx) this.audioCtx.stop()
    if (this.data.audioPlaying) this.setData({ audioPlaying: false })
  },

  onRetry () {
    this.load()
  },

  // ---- 右上角「···」：编辑 / 删除（spec 6.4，复用 T18 能力）----
  onTapMore () {
    wx.showActionSheet({
      itemList: ['编辑', '删除'],
      success: (res) => {
        if (res.tapIndex === 0) this.onEdit()
        else if (res.tapIndex === 1) this.onDelete()
      },
      fail: () => { /* 用户取消，静默 */ }
    })
  },

  // 编辑复用发布页（带 recordId 进入为编辑模式，地点只读）；
  // 返回本页时需要刷新（onShow 按 needRefresh 定向触发）
  onEdit () {
    this.needRefresh = true
    wx.navigateTo({ url: `/pages/publish/publish?recordId=${this.recordId}` })
  },

  // 删除（T18：能看见就能删除；二次确认；媒体/语音文件由云函数一并删）
  onDelete () {
    if (this.data.deleting) return
    wx.showModal({
      title: '删除记录',
      content: '删除后照片、视频和语音也会一并清除，无法恢复',
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
