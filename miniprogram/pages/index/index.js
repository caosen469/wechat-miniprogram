// 首页·浏览侧收尾三件套（spec 6.2 定稿形态，T21）：
// 1) 段控「列表 | 地图」——列表 = 地点卡片（T19：地点为一等公民）；地图 =
//    内置 <map> 一店一 marker（placeId 字符串 → 数字 id 映射，customCallout
//    显示名称/均分/次数，点 marker 出气泡、点气泡进地点页）。
// 2) 空状态 = 最小引导（一句话 + 打卡按钮，不做示例内容，T6 决议）。
// 3) 新回忆红点条——bootstrap.unreadCount > 0 显示「N 条新回忆」，点击展开
//    最新未读记录（listFeed after=水位；口径与 unreadCount 一致：可见 + 非本人
//    所发）并调 markRead 更新水位，红点消失（spec 8.2）。
const { callApi } = require('../../services/api')
const { gradeOf, tierKeyOf, starsOf } = require('../../services/rating')
const { typeLabelOf } = require('../../services/placeTypes')
const { formatTime } = require('../../services/formatTime')
const { onChange, pendingCount, list, discardFailed } = require('../../services/uploadQueue')

// 地图兜底中心：所有地点都缺坐标时也不会崩（正常由 include-points 自适应视野）
const DEFAULT_CENTER = { latitude: 39.908823, longitude: 116.39747 }

Page({
  data: {
    checking: true, // 冷启动身份检查中
    checkFailed: false,
    checkError: '',
    me: null,
    places: [], // listPlaces 聚合的地点卡片
    loadingPlaces: false,
    placesError: '',
    viewMode: 'list', // 段控：'list' | 'map'
    markers: [], // <map> markers：id 为数字（placeId → 下标映射），callout 数据随身带
    mapPoints: [], // include-points 用的纯 {latitude, longitude} 点数组
    mapCenter: DEFAULT_CENTER,
    unreadCount: 0, // bootstrap.unreadCount（spec 8.2：红点条唯一数据源）
    unreadOpen: false, // 红点条是否展开（展开后显示最新未读记录）
    unreadRecords: [],
    unreadMore: 0, // 未读数超出 listFeed 单页上限时被截掉的数量（条数诚实性）
    unreadLoading: false,
    unreadError: '',
    pendingCount: 0 // 弱网队列未同步数（spec 7.2：首页「N 条待同步」状态条）
  },

  onLoad () {
    // 订阅弱网队列变更：补传完成/入队时状态条实时刷新（不依赖 onShow 轮询）
    this.unsubQueue = onChange(count => this.setData({ pendingCount: count }))
  },

  onUnload () {
    if (this.unsubQueue) {
      this.unsubQueue()
      this.unsubQueue = null
    }
  },

  async onShow () {
    // 冷启动身份检查每个页面实例只做一次（从 onboarding reLaunch 回来是全新实例）；
    // 已检查过则只轻刷新：红点未读数（另一台手机新发记录后再次进入立即出现）+ 地点聚合
    if (this.bootstrapped) {
      this.refreshUnread()
      this.loadPlaces()
      return
    }
    this.bootstrapped = true
    this.syncPending()
    await this.checkMembership()
  },

  // 状态条计数与队列对账（每次进入首页读一次；队列变更由 onChange 实时推）
  syncPending () {
    this.setData({ pendingCount: pendingCount() })
  },

  async checkMembership () {
    this.setData({ checking: true, checkFailed: false })
    try {
      const result = await callApi('bootstrap')
      // 无圈用户 → onboarding（spec 6.1）
      if (!this.applyBootstrap(result)) return
      this.setData({ checking: false })
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

  // 轻刷新红点：bootstrap 是 unreadCount 的唯一数据源（spec 8.2）。
  // 被移除等极端情况（me 变 null）回 onboarding；刷新失败静默，保留上次值下次再试
  async refreshUnread () {
    try {
      this.applyBootstrap(await callApi('bootstrap'))
    } catch (err) {
      // 静默：红点保留旧值，下个 onShow 再试
    }
  },

  // bootstrap 结果落地（冷启动与轻刷新共用）：写 globalData、更新 me/unreadCount；
  // 不在圈（me 为 null）则 reLaunch 到 onboarding。返回是否仍在圈。
  applyBootstrap (result) {
    if (!result || !result.me) {
      wx.reLaunch({ url: '/pages/onboarding/onboarding' })
      return false
    }
    getApp().globalData.bootstrap = result
    // 竞态防护：openUnread 刚 markRead 时本地水位比在途的旧 bootstrap 响应更新
    // （旧响应在 markRead 前计算）；它的 unreadCount 不得把已消的红点复活。
    // 两者都是 ISO 字符串（UTC），可直接字典序比较。
    const localWatermark = this.data.me && this.data.me.lastReadAt
    const stale = !!(localWatermark && result.me.lastReadAt && result.me.lastReadAt < localWatermark)
    this.setData({
      me: result.me,
      unreadCount: stale ? this.data.unreadCount : (result.unreadCount || 0)
    })
    return true
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
      const markers = this.buildMarkers(places)
      this.setData({
        places,
        markers,
        // include-points 只认 {latitude, longitude} 的点，别把 marker 整对象塞进去
        mapPoints: markers.map(m => ({ latitude: m.latitude, longitude: m.longitude })),
        mapCenter: markers.length
          ? { latitude: markers[0].latitude, longitude: markers[0].longitude }
          : DEFAULT_CENTER,
        loadingPlaces: false
      })
    } catch (err) {
      this.setData({ loadingPlaces: false, placesError: err.message || '加载失败' })
    }
  },

  // 一店一 marker（spec 6.2）：<map> 的 marker id 必须是数字，placeId 字符串
  // 按下标映射（spec 阶段 3 易卡点）。location 为 Geo.Point，coordinates=[经度, 纬度]。
  // customCallout 用 BYCLICK：点 marker 才弹气泡；气泡内容在 wxml 的
  // <cover-view slot="callout" marker-id> 里渲染（原生层置顶、可点）。
  buildMarkers (places) {
    const markers = []
    places.forEach(p => {
      const loc = p.location
      if (!loc || !Array.isArray(loc.coordinates) || loc.coordinates.length < 2) return
      const longitude = Number(loc.coordinates[0])
      const latitude = Number(loc.coordinates[1])
      if (isNaN(longitude) || isNaN(latitude)) return
      markers.push({
        // id 用 markers 自身的稠密下标（不是 places 下标）：缺坐标的地点被跳过时
        // 也不会错位，onCalloutTap 按 markers[id] 回查即可对上
        id: markers.length,
        placeId: p._id,
        name: p.name,
        longitude,
        latitude,
        stars: p.stars,
        avgText: p.avgText,
        visitCount: p.visitCount,
        customCallout: { display: 'BYCLICK' }
      })
    })
    return markers
  },

  // 段控切换（spec 6.2）：列表 / 地图共用同一份地点数据，只是视图不同
  onSwitchView (e) {
    const mode = e.currentTarget.dataset.mode
    if (mode === this.data.viewMode) return
    this.setData({ viewMode: mode })
  },

  // 点地点卡片 → 地点页（spec 6.3）：名称先带上，加载后再校准导航栏标题
  onOpenPlace (e) {
    const { id, name } = e.currentTarget.dataset
    wx.navigateTo({
      url: `/pages/place/place?placeId=${id}&name=${encodeURIComponent(name || '')}`
    })
  },

  // 点 marker 气泡（customCallout）→ 地点页：marker id 是数字，经映射回 placeId
  onCalloutTap (e) {
    const marker = this.data.markers[e.currentTarget.dataset.markerId]
    if (!marker) return
    wx.navigateTo({
      url: `/pages/place/place?placeId=${marker.placeId}&name=${encodeURIComponent(marker.name || '')}`
    })
  },

  // 右下角打卡按钮 → 发布页（spec 6.2）
  onTapPublish () {
    wx.navigateTo({ url: '/pages/publish/publish' })
  },

  // 弱网队列状态条（spec 7.2）：不弹错轰炸，点击后给说明；
  // 终态失败的 job 提供「放弃」出口，避免状态条永久卡死
  onTapPending () {
    const jobs = list()
    const pending = jobs.filter(j => j.status === 'pending').length
    const failed = jobs.filter(j => j.status === 'failed')
    const content = [
      pending > 0 ? `${pending} 条正在等待联网，恢复后自动补传` : '',
      ...failed.map(j => `发布失败：${j.error}`)
    ].filter(Boolean).join('；') || '没有待同步的内容'
    wx.showModal({
      title: `${this.data.pendingCount} 条回忆待同步`,
      content,
      showCancel: failed.length > 0,
      cancelText: '放弃',
      confirmText: '知道了',
      success: r => {
        if (r.cancel && failed.length > 0) discardFailed()
      }
    })
  },

  // 红点条：展开/收起。展开时拉最新未读记录并 markRead 更新水位（红点消失，
  // 记录仍保留展示；收起后下次 onShow 的 bootstrap 确认 unreadCount=0）
  onTapUnread () {
    if (this.data.unreadOpen) {
      this.setData({ unreadOpen: false })
      return
    }
    this.openUnread()
  },

  async openUnread () {
    if (this.data.unreadLoading) return
    const me = this.data.me
    // 水位：与 bootstrap 同一回退（首次 markRead 前回退到 joinedAt，spec 4.2）
    const watermark = me && (me.lastReadAt || me.joinedAt)
    if (!watermark) return
    this.setData({ unreadLoading: true, unreadError: '' })
    try {
      // 与 unreadCount 同口径：createdAt > 水位、可见（listFeed 已按 spec 4.6
      // 过滤）、非本人所发（自己发的不给自己红点，客户端再滤一层保持一致）
      const result = await callApi('listFeed', { after: watermark, limit: 50 })
      const records = (result.records || [])
        .filter(r => r.authorId !== me.openid)
        .map(r => {
          const image = (r.media || []).find(m => m && m.type === 'image' && m.fileID)
          return {
            ...r,
            thumb: image ? image.fileID : '',
            authorName: r.author ? r.author.nickname : '',
            timeText: formatTime(r.happenedAt || r.createdAt)
          }
        })
      // 条数诚实性：listFeed 单页上限 50，未读数超出时展开只显示最新一批
      const total = this.data.unreadCount
      this.setData({
        unreadOpen: true,
        unreadRecords: records,
        unreadMore: records.length < total ? total - records.length : 0,
        unreadLoading: false
      })
    } catch (err) {
      this.setData({ unreadOpen: true, unreadLoading: false, unreadError: err.message || '加载失败' })
      return
    }
    // 记录已展示；水位推进单独处理：markRead 失败不阻塞展示，红点保留下次再点
    try {
      await callApi('markRead')
      // 红点消失。服务端 markRead 已落库，本地同步水位与计数，
      // 下次 onShow 的 bootstrap 以新水位确认 unreadCount=0
      this.setData({
        unreadCount: 0,
        'me.lastReadAt': new Date().toISOString()
      })
    } catch (err) {
      // 静默：红点保留，用户下次点击再试
    }
  },

  // 点未读记录 → 记录详情（spec 6.4 记录详情）
  onOpenUnreadRecord (e) {
    wx.navigateTo({ url: `/pages/detail/detail?recordId=${e.currentTarget.dataset.id}` })
  }
})
