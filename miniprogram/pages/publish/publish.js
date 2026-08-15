// 发布页（spec 6.5 变体 C「拍摄优先」，T15 + T18 + T20）：
// 九宫格媒体打头 + ≤500 字吐槽 + 5 星点选（必填）+ 语音条内联
// （wx.getRecorderManager 录 ≤60s，可试听/重录/删）
// + 地点内联轻选三通道（POI 搜索 / 当前位置反查 / 手动新地点）
// + 折叠区「＋更多」默认收起（参与者多选 / 可见范围 / 补记时间）
// + 底栏发布 + 可见范围快捷入口（三选一弹层，防「仅我俩」手滑）。
// 编辑模式（T20）：带 recordId 进入，getRecord 预填后走 updateRecord，
// 地点只读不改（spec 5.1 updateRecord 可改字段不含 place）。
// 草稿与弱网队列不做（T22/T23）：发布时直传云存储。
const { callApi } = require('../../services/api')
const { mergeMedia, LIMITS } = require('../../services/mediaRules')
const { tencentMapKey } = require('../../config/index')
const { TYPE_OPTIONS, typeLabelOf } = require('../../services/placeTypes')
const { gradeOf } = require('../../services/rating')

// 可见范围三档（spec 4.6；pair 需圈主已指定另一半，未指定时禁选）
const VISIBILITY_OPTIONS = [
  { value: 'family', label: '家庭圈', icon: '🏠', desc: '圈里所有人可见' },
  { value: 'pair', label: '仅我俩', icon: '💞', desc: '只有你和另一半可见' },
  { value: 'private', label: '仅自己', icon: '🔒', desc: '只有你自己可见' }
]

const randId = () => Math.random().toString(36).slice(2, 10)

// 临时文件扩展名 → 云存储路径扩展名（视频统一 mp4，图片统一 jpg）
const extOf = item => (item.type === 'video' ? 'mp4' : 'jpg')

const pad = n => String(n).padStart(2, '0')

Page({
  data: {
    media: [], // [{path, type: 'image'|'video', duration?}]
    text: '',
    textMax: 500,
    rating: 0,
    grade: '',
    place: null, // {poiId: string|null, name, type, location: {latitude, longitude}|null, typeLabel}
    totalMax: LIMITS.TOTAL_MAX,
    typeOptions: TYPE_OPTIONS,
    sheet: '', // '' | 'type'（POI 选定后选类型）| 'manual'（手动新地点）| 'vis'（可见范围三选一）
    pendingPlace: null, // POI 通道选定、待选类型的地点
    pendingName: '',
    pendingType: 'restaurant',
    manualName: '',
    manualType: 'restaurant',
    submitting: false,
    // ---- 折叠区「＋更多」（默认收起，spec 6.5）----
    moreOpen: false,
    visibility: 'family',
    visibilityLabel: '家庭圈',
    visibilityIcon: '🏠',
    visibilityOptions: VISIBILITY_OPTIONS,
    pairDesignated: false, // 圈主已指定另一半
    pairReady: false, // 且自己就是二人组成员，才可选「仅我俩」
    participantOptions: [], // 在圈成员（不含自己）{openid, nickname, avatarUrl, on}
    // 补记时间：默认现在；timeCustom 为真时用 customDate/customTime（本地时间）
    timeCustom: false,
    customDate: '',
    customTime: '',
    // ---- 语音条内联（T20，spec 6.5）----
    audio: null, // {fileID?（编辑模式已有云端语音）, path?（新录的本地临时文件）, duration}
    recording: false,
    recordSecs: 0,
    audioPlaying: false,
    // ---- 编辑模式（T20）：详情页「···」→ 编辑 复用本页 ----
    editRecordId: '',
    editLoading: false,
    editFailed: false
  },

  onLoad (options) {
    // 编辑模式：带 recordId 进入（详情页「···」→ 编辑），预填后走 updateRecord
    if (options && options.recordId) {
      this.setData({ editRecordId: options.recordId, editLoading: true, editFailed: false })
      wx.setNavigationBarTitle({ title: '编辑回忆' })
      this.loadEdit(options.recordId)
    }

    // 成员/另一半状态来自 bootstrap（index onShow 已拉过则直接用，避免二次请求）
    const boot = getApp().globalData.bootstrap
    if (boot && boot.circle) {
      this.applyBootstrap(boot)
    } else {
      // 冷启动直入本页等边界：兜底拉一次
      callApi('bootstrap').then(this.applyBootstrap.bind(this)).catch(() => {})
    }
  },

  onUnload () {
    // 离开页面时停掉录音与试听，避免后台继续占用麦克风/扬声器。
    // destroyed 置前：onStop 回调里不再对已卸载页面 setData
    this.destroyed = true
    if (this.recorder && this.data.recording) this.recorder.stop()
    this.clearRecordTimer()
    if (this.audioCtx) {
      this.audioCtx.stop()
      this.audioCtx.destroy()
      this.audioCtx = null
    }
  },

  // ---- 编辑模式：getRecord 预填（spec 6.4「···」→ 编辑 复用发布页）----
  onRetryEdit () {
    this.setData({ editLoading: true, editFailed: false })
    this.loadEdit(this.data.editRecordId)
  },

  async loadEdit (recordId) {
    try {
      const result = await callApi('getRecord', { recordId })
      if (this.destroyed) return
      const record = result.record
      const visOption = VISIBILITY_OPTIONS.find(o => o.value === record.visibility) ||
        VISIBILITY_OPTIONS[0]
      // 到访时间预填为记录的 happenedAt（本地时区拆 date/time）；
      // 记下原值：保存时未改动则不传 happenedAt，免得触发多余的封面重算
      const d = new Date(record.happenedAt || record.createdAt)
      this.editHappenedAtTs = d.getTime()
      // 参与者预填：applyBootstrap 可能先于本请求返回（编辑所需的 pids 先存，
      // bootstrap 到达后应用；若 options 已就绪则立即应用）
      this.editPids = record.participantIds || []
      this.setData({
        editLoading: false,
        text: record.text || '',
        rating: record.rating,
        grade: gradeOf(record.rating),
        visibility: visOption.value,
        visibilityLabel: visOption.label,
        visibilityIcon: visOption.icon,
        media: (record.media || []).map(m => ({
          path: m.fileID, // cloud:// 直显（图片）；视频格显示占位
          fileID: m.fileID, // 已在云端：提交时不重传，仅保留/删除
          type: m.type,
          duration: m.duration
        })),
        audio: record.audio ? { fileID: record.audio.fileID, duration: record.audio.duration } : null,
        place: result.place
          ? { ...result.place, typeLabel: typeLabelOf(result.place.type) } // 只读展示，不可改
          : null,
        timeCustom: true,
        customDate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
        customTime: `${pad(d.getHours())}:${pad(d.getMinutes())}`
      })
      this.applyEditParticipants()
    } catch (err) {
      if (this.destroyed) return
      // 加载失败置 editFailed：保存按钮禁用 + 表单收回，防止用全默认字段
      // 保存而清空记录/把 pair 降级为全圈可见（review #1）
      this.setData({ editLoading: false, editFailed: true })
      if (err.code === 'NOT_VISIBLE') {
        wx.navigateBack({ fail: () => wx.switchTab({ url: '/pages/index/index' }) })
        return
      }
      wx.showToast({ title: err.message || '加载失败', icon: 'none' })
    }
  },

  // 把编辑记录的参与者标记到成员选项上（bootstrap 与 getRecord 谁后到谁触发）
  applyEditParticipants () {
    if (!this.editPids || this.data.participantOptions.length === 0) return
    this.setData({
      participantOptions: this.data.participantOptions.map(p => ({
        ...p,
        on: this.editPids.includes(p.openid)
      }))
    })
  },

  applyBootstrap (boot) {
    const me = boot.me
    const pairIds = (boot.circle.pairIds || [])
    this.setData({
      // 「仅我俩」只面向二人组成员：不在 pairIds 里的成员发了也看不见（spec 4.6）
      pairDesignated: pairIds.length === 2,
      pairReady: pairIds.length === 2 && pairIds.includes(me.openid),
      participantOptions: (boot.members || [])
        .filter(m => m.status === 'active' && m.openid !== me.openid)
        .map(m => ({ openid: m.openid, nickname: m.nickname, avatarUrl: m.avatarUrl, on: false }))
    })
    this.applyEditParticipants()
  },

  // ---- 折叠区「＋更多」 ----

  onToggleMore () {
    this.setData({ moreOpen: !this.data.moreOpen })
  },

  // 三选一弹层（底栏快捷入口与折叠区共用，spec 6.5：弹层防「仅我俩」手滑）
  onOpenVisibility () {
    this.setData({ sheet: 'vis' })
  },

  onPickVisibility (e) {
    const value = e.currentTarget.dataset.value
    if (value === 'pair' && !this.data.pairReady) {
      wx.showToast({
        title: this.data.pairDesignated ? '「仅我俩」只面向圈主指定的二人组' : '圈主还没指定另一半',
        icon: 'none'
      })
      return
    }
    const option = VISIBILITY_OPTIONS.find(o => o.value === value)
    this.setData({
      visibility: value,
      visibilityLabel: option.label,
      visibilityIcon: option.icon,
      sheet: ''
    })
  },

  // 参与者多选（可跳过，spec 4.5）
  onToggleParticipant (e) {
    const openid = e.currentTarget.dataset.openid
    this.setData({
      participantOptions: this.data.participantOptions.map(p => ({
        ...p,
        on: p.openid === openid ? !p.on : p.on
      }))
    })
  },

  // 补记时间（默认现在，可改）：点「现在」切到自定义，默认今天/当前时间
  onEnableCustomTime () {
    const d = new Date()
    this.setData({
      timeCustom: true,
      customDate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      customTime: `${pad(d.getHours())}:${pad(d.getMinutes())}`
    })
  },

  onPickCustomDate (e) {
    this.setData({ customDate: e.detail.value, timeCustom: true })
  },

  onPickCustomTime (e) {
    this.setData({ customTime: e.detail.value, timeCustom: true })
  },

  onResetTime () {
    this.setData({ timeCustom: false, customDate: '', customTime: '' })
  },

  // ---- 媒体 ----
  async onAddMedia () {
    const remaining = LIMITS.TOTAL_MAX - this.data.media.length
    if (remaining <= 0) {
      wx.showToast({ title: `最多 ${LIMITS.TOTAL_MAX} 个图片/视频`, icon: 'none' })
      return
    }
    try {
      const res = await wx.chooseMedia({
        count: remaining,
        mediaType: ['image', 'video'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'] // 起步压缩、够用即可（grilling 决议）
      })
      const incoming = res.tempFiles.map(f => ({
        path: f.tempFilePath,
        type: f.fileType,
        duration: f.fileType === 'video' ? f.duration : undefined
      }))
      const { list, dropped } = mergeMedia(this.data.media, incoming)
      this.setData({ media: list })
      // 超限即时提示并拦截（spec 6.5）：提示被拦了什么，已放行的照常并入
      const parts = []
      if (dropped.images) parts.push(`${dropped.images} 张图片`)
      if (dropped.videos) parts.push(`${dropped.videos} 段视频`)
      if (dropped.longVideos) parts.push(`${dropped.longVideos} 段超 60s 视频`)
      if (parts.length > 0) {
        wx.showToast({ title: `已拦截：${parts.join('、')}`, icon: 'none', duration: 2500 })
      }
    } catch (e) {
      // 用户取消选择，静默
    }
  },

  onRemoveMedia (e) {
    const index = e.currentTarget.dataset.index
    const media = this.data.media.filter((_, i) => i !== index)
    this.setData({ media })
  },

  onTextInput (e) {
    const text = (e.detail.value || '').slice(0, this.data.textMax)
    this.setData({ text })
    return text // 限制输入框回显长度
  },

  onSetRating (e) {
    const rating = Number(e.currentTarget.dataset.n)
    this.setData({ rating, grade: gradeOf(rating) })
  },

  // ---- 语音条内联（T20，spec 6.5：≤60s，可试听/重录/删）----

  ensureRecorder () {
    if (this.recorder) return this.recorder
    const recorder = wx.getRecorderManager()
    recorder.onStart(() => {
      if (this.destroyed) return
      this.recordSecs = 0
      this.setData({ recording: true, recordSecs: 0 })
      this.clearRecordTimer()
      this.recordTimer = setInterval(() => {
        if (this.destroyed) {
          this.clearRecordTimer()
          return
        }
        this.recordSecs += 1
        this.setData({ recordSecs: this.recordSecs })
      }, 1000)
    })
    // 手动停止与 60s 自动停止都走这里（duration 上限即 spec 的 ≤60s）
    recorder.onStop((res) => {
      this.clearRecordTimer()
      if (this.destroyed) return // onUnload 主动停录音：不再 setData
      this.setData({ recording: false })
      // res.duration 为毫秒；1 秒内手停时计时器还没走字，以系统时长为准
      const secs = Math.max(1, Math.round((res.duration || this.recordSecs * 1000) / 1000))
      if (res && res.tempFilePath) {
        this.setData({
          audio: { path: res.tempFilePath, duration: Math.min(secs, LIMITS.VIDEO_DURATION_MAX) },
          audioPlaying: false
        })
      }
    })
    recorder.onError(() => {
      this.clearRecordTimer()
      if (this.destroyed) return
      this.setData({ recording: false })
      wx.showToast({ title: '录音失败，请检查麦克风授权', icon: 'none' })
    })
    this.recorder = recorder
    return recorder
  },

  clearRecordTimer () {
    if (this.recordTimer) {
      clearInterval(this.recordTimer)
      this.recordTimer = null
    }
  },

  // 麦克风授权前置：未决定时弹授权框；曾拒绝过则引导去设置里手动开
  // （recorderManager.start 在无授权时会静默失败，必须显式处理）
  ensureRecordScope () {
    return new Promise((resolve, reject) => {
      wx.getSetting({
        success: (res) => {
          if (res.authSetting['scope.record'] === false) {
            wx.showModal({
              title: '需要麦克风权限',
              content: '录音前请在设置中允许「麦克风」权限',
              confirmText: '去设置',
              success: (r) => {
                if (r.confirm) wx.openSetting({})
              }
            })
            reject(new Error('record scope denied'))
            return
          }
          wx.authorize({ scope: 'scope.record', success: resolve, fail: reject })
        },
        fail: reject
      })
    })
  },

  async onRecordStart () {
    if (this.data.recording) return
    this.stopAudioPreview()
    try {
      await this.ensureRecordScope()
    } catch (e) {
      return // 已弹过引导/用户拒绝授权，静默返回
    }
    this.ensureRecorder().start({
      duration: LIMITS.VIDEO_DURATION_MAX * 1000, // 到时自动停（onStop 统一收口）
      format: 'aac',
      sampleRate: 44100,
      // 码率必须显式给：44100 采样下默认 48000 会因「须在 64000–320000」被拒
      encodeBitRate: 64000, // 语音够用（真机预览反馈）
      numberOfChannels: 1
    })
  },

  onRecordStop () {
    if (!this.data.recording) return
    this.ensureRecorder().stop()
  },

  // 试听：本地临时文件直放；编辑模式带回来的云端语音需先换临时链接
  async onAudioPreview () {
    if (this.data.recording) return
    if (this.data.audioPlaying) {
      this.stopAudioPreview()
      return
    }
    const audio = this.data.audio
    if (!audio) return
    let src = audio.path
    if (!src && audio.fileID) {
      try {
        const res = await wx.cloud.getTempFileURL({ fileList: [audio.fileID] })
        const f = (res.fileList || [])[0]
        src = f && f.tempFileURL
      } catch (e) { /* 落到下面的失败提示 */ }
    }
    if (!src) {
      wx.showToast({ title: '语音加载失败，请重试', icon: 'none' })
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
    this.audioCtx.src = src
    this.audioCtx.play()
    this.setData({ audioPlaying: true })
  },

  stopAudioPreview () {
    if (this.audioCtx) this.audioCtx.stop()
    if (this.data.audioPlaying) this.setData({ audioPlaying: false })
  },

  onAudioRerecord () {
    this.stopAudioPreview()
    this.onRecordStart()
  },

  onAudioDelete () {
    this.stopAudioPreview()
    this.setData({ audio: null })
  },

  // ---- 地点三通道 ----
  async onPlaceTap () {
    // 编辑模式地点只读：spec 5.1 updateRecord 可改字段不含 place
    if (this.data.editRecordId) return
    try {
      const res = await wx.showActionSheet({
        itemList: ['搜索地点', '用当前位置打卡', '手动输入新地点']
      })
      if (res.tapIndex === 0) await this.chooseByPoi()
      else if (res.tapIndex === 1) await this.chooseByLocation()
      else this.openManualSheet()
    } catch (e) {
      // 用户取消 actionSheet，静默
    }
  },

  // 通道 1：POI 搜索（spec 6.5：优先取返回的 poi id 作为归并键）
  async chooseByPoi () {
    try {
      const res = await wx.choosePoi({ type: 1 })
      if (!res || !res.name) return
      // id 可能为空串（选点模糊时没有 POI id）：无 id 则不参与自动归并，等同手动地点
      this.setData({
        pendingPlace: {
          poiId: res.id || null,
          name: res.name,
          location: res.location || null
        },
        pendingName: res.name,
        pendingType: 'restaurant',
        sheet: 'type'
      })
    } catch (e) {
      // 用户取消选点静默；真实失败要可见（权限/环境问题会表现成「卡住」）
      const msg = (e && e.errMsg) || String(e)
      if (!msg.includes('cancel')) {
        console.warn('choosePoi fail:', msg)
        wx.showToast({ title: '选点失败：' + msg, icon: 'none', duration: 3000 })
      }
    }
  },

  // 通道 2：当前位置 + 腾讯位置服务逆地址反查最近 POI（spec 6.5）
  async chooseByLocation () {
    if (!tencentMapKey) {
      wx.showToast({ title: '未配置地图 key，请用搜索或手动输入', icon: 'none' })
      return
    }
    let location
    try {
      const loc = await wx.getLocation({ type: 'gcj02' })
      location = loc
    } catch (e) {
      wx.showToast({ title: '定位失败，请检查定位授权', icon: 'none' })
      return
    }
    wx.showLoading({ title: '定位中…', mask: true })
    try {
      const res = await new Promise((resolve, reject) => {
        wx.request({
          url: 'https://apis.map.qq.com/ws/geocoder/v1/',
          data: {
            location: `${location.latitude},${location.longitude}`,
            key: tencentMapKey,
            get_poi: 1 // 返回周边 POI 列表，取第一个即最近
          },
          success: resolve,
          fail: reject
        })
      })
      const pois = res.data && res.data.result && res.data.result.pois
      if (res.statusCode === 200 && res.data.status === 0 && pois && pois.length > 0) {
        const poi = pois[0]
        this.setData({
          pendingPlace: {
            poiId: poi.id || null,
            name: poi.title,
            location: { latitude: poi.location.lat, longitude: poi.location.lng }
          },
          pendingName: poi.title,
          pendingType: 'restaurant',
          sheet: 'type'
        })
      } else {
        wx.showToast({ title: '附近没找到地点，试试搜索或手动输入', icon: 'none' })
      }
    } catch (e) {
      wx.showToast({ title: '逆地址查询失败，请稍后再试', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  // 通道 3：手动新地点（spec 6.5：不参与自动归并，ADR 0001）
  openManualSheet () {
    this.setData({ sheet: 'manual', manualName: '', manualType: 'restaurant' })
  },

  onManualNameInput (e) {
    this.setData({ manualName: e.detail.value })
  },

  onPickPendingType (e) {
    this.setData({ pendingType: e.currentTarget.dataset.value })
  },

  onPickManualType (e) {
    this.setData({ manualType: e.currentTarget.dataset.value })
  },

  // 统一落地点：附 typeLabel 供展示；提交时只挑 poiId/name/type/location（onPublish）
  applyPlace (place) {
    this.setData({ place: { ...place, typeLabel: typeLabelOf(place.type) } })
  },

  // POI 通道确认类型：新地点首次打卡时选定，后续到访由服务端归并继承（spec 4.4）
  onConfirmPendingPlace () {
    this.applyPlace({ ...this.data.pendingPlace, type: this.data.pendingType })
    this.setData({ sheet: '', pendingPlace: null })
  },

  onConfirmManualPlace () {
    const name = this.data.manualName.trim()
    if (!name) {
      wx.showToast({ title: '给这个地方起个名吧', icon: 'none' })
      return
    }
    this.applyPlace({ poiId: null, name, type: this.data.manualType, location: null })
    this.setData({ sheet: '' })
  },

  onClearPlace () {
    this.setData({ place: null })
  },

  onCloseSheet () {
    this.setData({ sheet: '', pendingPlace: null })
  },

  onSheetTap () {
    // 只为 catchtap 阻止冒泡到遮罩，无行为
  },

  // ---- 发布 / 保存 ----
  // 补记时间 → 时间戳（本地时间构造；不传 = 现在，由服务端定）
  happenedAtTimestamp () {
    if (!this.data.timeCustom) return undefined
    const [y, m, d] = this.data.customDate.split('-').map(Number)
    const [hh, mm] = (this.data.customTime || '00:00').split(':').map(Number)
    const ts = new Date(y, m - 1, d, hh, mm).getTime()
    if (isNaN(ts) || ts > Date.now()) {
      return null // 非法/未来时间，交给调用方拦截
    }
    return ts
  },

  // 语音上传：新录的本地文件传云存储得 {fileID, duration}；
  // 编辑模式沿用的旧语音原样返回；无语音返回 null
  async uploadAudio (base) {
    const audio = this.data.audio
    if (!audio) return null
    if (audio.fileID && !audio.path) return audio // 未改动，保留
    const upload = await wx.cloud.uploadFile({
      cloudPath: `records/${base}-voice-${randId()}.aac`,
      filePath: audio.path
    })
    return { fileID: upload.fileID, duration: audio.duration }
  },

  async onPublish () {
    if (this.data.submitting) return
    const editing = !!this.data.editRecordId
    // 编辑数据没加载成功（或还在加载）不许保存：防止用全默认字段
    // 清空记录、把 pair/private 降级成全圈可见（review 数据丢失项）
    if (editing && (this.data.editLoading || this.data.editFailed)) {
      wx.showToast({ title: this.data.editFailed ? '内容还没加载出来，先重试' : '加载中…', icon: 'none' })
      return
    }
    if (this.data.rating === 0) {
      wx.showToast({ title: '给这次体验打个分吧', icon: 'none' })
      return
    }
    if (!editing && !this.data.place) {
      wx.showToast({ title: '请选择打卡地点', icon: 'none' })
      return
    }
    const happenedAt = this.happenedAtTimestamp()
    if (happenedAt === null) {
      wx.showToast({ title: '补记时间不能是未来', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: editing ? '保存中…' : '发布中…', mask: true })
    try {
      // 媒体直传云存储拿 fileID（spec 2.2，不经云函数中转）；
      // cloudPath 带时间戳+随机串保证唯一（幂等约定见 spec 7.2）；
      // 编辑模式下已有 fileID 的条目不重传（仅保留/删除）
      const base = Date.now()
      const media = []
      for (let i = 0; i < this.data.media.length; i++) {
        const item = this.data.media[i]
        if (item.fileID) {
          media.push({
            fileID: item.fileID,
            type: item.type,
            ...(item.type === 'video' ? { duration: item.duration } : {})
          })
          continue
        }
        const upload = await wx.cloud.uploadFile({
          cloudPath: `records/${base}-${i}-${randId()}.${extOf(item)}`,
          filePath: item.path
        })
        media.push({
          fileID: upload.fileID,
          type: item.type,
          ...(item.type === 'video' ? { duration: item.duration } : {})
        })
      }

      const audio = await this.uploadAudio(base)
      // 参与者：编辑模式下若成员列表还没到（bootstrap 竞态/失败），
      // 用记录原值兜底，避免静默清空原参与者
      const participantIds = this.data.participantOptions.length > 0
        ? this.data.participantOptions.filter(p => p.on).map(p => p.openid)
        : (this.editPids || [])
      // 到访时间：编辑时未改动不传（免得触发多余的封面重算）；新建不传=现在
      const happenedAtUnchanged = editing && this.editHappenedAtTs !== undefined &&
        happenedAt === this.editHappenedAtTs
      const fields = {
        media,
        audio,
        text: this.data.text.trim(),
        rating: this.data.rating,
        visibility: this.data.visibility,
        participantIds,
        ...(happenedAt !== undefined && !happenedAtUnchanged ? { happenedAt } : {})
      }

      if (editing) {
        // 编辑：地点不可改（不传 placeId/newPlace），被删/被换的旧媒体与旧语音
        // 由 updateRecord 从云存储清理（孤儿文件规则同 media）
        await callApi('updateRecord', { recordId: this.data.editRecordId, ...fields })
        wx.hideLoading()
        wx.showToast({ title: '已保存', icon: 'success' })
      } else {
        // place 以 newPlace 提交：同 poiId 的地点由服务端查重归并（spec 5.1）
        const place = this.data.place
        const result = await callApi('publishRecord', {
          newPlace: {
            poiId: place.poiId,
            name: place.name,
            type: place.type,
            location: place.location
          },
          ...fields
        })
        wx.hideLoading()
        wx.showToast({ title: '已发布', icon: 'success' })
        return result
      }
      setTimeout(() => wx.navigateBack(), 600)
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || (this.data.editRecordId ? '保存失败，请重试' : '发布失败，请重试'), icon: 'none', duration: 2500 })
      this.setData({ submitting: false })
    }
  }
})
