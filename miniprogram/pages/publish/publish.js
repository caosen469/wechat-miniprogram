// 发布页（spec 6.5 变体 C「拍摄优先」，T15 + T18）：
// 九宫格媒体打头 + ≤500 字吐槽 + 5 星点选（必填）
// + 地点内联轻选三通道（POI 搜索 / 当前位置反查 / 手动新地点）
// + 折叠区「＋更多」默认收起（参与者多选 / 可见范围 / 补记时间）
// + 底栏发布 + 可见范围快捷入口（三选一弹层，防「仅我俩」手滑）。
// 语音不做（T20）；草稿与弱网队列不做（T22/T23）：发布时直传云存储。
const { callApi } = require('../../services/api')
const { mergeMedia, LIMITS } = require('../../services/mediaRules')
const { tencentMapKey } = require('../../config/index')

// 地点类型（spec 4.4），与云函数 PLACE_TYPES 对应
const TYPE_OPTIONS = [
  { value: 'restaurant', label: '餐厅' },
  { value: 'attraction', label: '景点' },
  { value: 'accommodation', label: '住宿' },
  { value: 'other', label: '其他' }
]

// 可见范围三档（spec 4.6；pair 需圈主已指定另一半，未指定时禁选）
const VISIBILITY_OPTIONS = [
  { value: 'family', label: '家庭圈', icon: '🏠', desc: '圈里所有人可见' },
  { value: 'pair', label: '仅我俩', icon: '💞', desc: '只有你和另一半可见' },
  { value: 'private', label: '仅自己', icon: '🔒', desc: '只有你自己可见' }
]

const randId = () => Math.random().toString(36).slice(2, 10)

// 星级 → 情绪档位（spec 3：由评分映射，不单独录入）
const gradeOf = rating =>
  rating >= 4 ? '宝藏' : rating === 3 ? '还行' : rating > 0 ? '踩雷' : ''

const typeLabelOf = value =>
  (TYPE_OPTIONS.find(t => t.value === value) || {}).label || ''

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
    customTime: ''
  },

  onLoad () {
    // 成员/另一半状态来自 bootstrap（index onShow 已拉过则直接用，避免二次请求）
    const boot = getApp().globalData.bootstrap
    if (boot && boot.circle) {
      this.applyBootstrap(boot)
    } else {
      // 冷启动直入本页等边界：兜底拉一次
      callApi('bootstrap').then(this.applyBootstrap.bind(this)).catch(() => {})
    }
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

  // ---- 地点三通道 ----
  async onPlaceTap () {
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
      // 用户取消选点，静默
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

  // ---- 发布 ----
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

  async onPublish () {
    if (this.data.submitting) return
    if (this.data.rating === 0) {
      wx.showToast({ title: '给这次体验打个分吧', icon: 'none' })
      return
    }
    if (!this.data.place) {
      wx.showToast({ title: '请选择打卡地点', icon: 'none' })
      return
    }
    const happenedAt = this.happenedAtTimestamp()
    if (happenedAt === null) {
      wx.showToast({ title: '补记时间不能是未来', icon: 'none' })
      return
    }

    this.setData({ submitting: true })
    wx.showLoading({ title: '发布中…', mask: true })
    try {
      // 媒体直传云存储拿 fileID（spec 2.2，不经云函数中转）；
      // cloudPath 带时间戳+随机串保证唯一（幂等约定见 spec 7.2）
      const base = Date.now()
      const media = []
      for (let i = 0; i < this.data.media.length; i++) {
        const item = this.data.media[i]
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

      // place 以 newPlace 提交：同 poiId 的地点由服务端查重归并（spec 5.1 publishRecord）
      const place = this.data.place
      const result = await callApi('publishRecord', {
        newPlace: {
          poiId: place.poiId,
          name: place.name,
          type: place.type,
          location: place.location
        },
        media,
        text: this.data.text.trim(),
        rating: this.data.rating,
        visibility: this.data.visibility,
        participantIds: this.data.participantOptions.filter(p => p.on).map(p => p.openid),
        ...(happenedAt !== undefined ? { happenedAt } : {})
      })

      wx.hideLoading()
      wx.showToast({ title: '已发布', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
      return result
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: err.message || '发布失败，请重试', icon: 'none', duration: 2500 })
      this.setData({ submitting: false })
    }
  }
})
