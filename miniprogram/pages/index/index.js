// 首页·足迹列表（spec 6.2 定稿形态，T19）：地点为一等公民。
// 每张地点卡片 = listPlaces 聚合的封面拼图（1 图或 4 图拼图）+ 地点名 + 类型
// + 均分 ★ + 到访次数 + 情绪档位徽章（按均分映射）；点卡片进地点页。
// 每次进入本页刷新（发布返回后新聚合立即可见）；右下角常驻打卡按钮跳发布页。
//
// T21 浏览侧收尾三件套（spec 6.2 / 8.2）：
//   ① 顶部段控「列表 | 地图」：同一份地点聚合数据两种视图，地图一店一 marker；
//   ② 空状态最小引导（T6 决议：一句话 + 打卡按钮，不做示例内容）；
//   ③ 新回忆红点条：unreadCount > 0 时显示，点击展开最新未读记录并 markRead。
const { callApi } = require('../../services/api')
const { gradeOf, tierKeyOf, starsOf } = require('../../services/rating')
const { typeLabelOf } = require('../../services/placeTypes')
const { formatTime } = require('../../services/formatTime')

// 红点条展开一次拉满 listFeed 单页上限；超出部分以「更早的还有 N 条」提示
const UNREAD_PAGE = 50

Page({
  data: {
    checking: true, // 冷启动身份检查中
    checkFailed: false,
    checkError: '',
    me: null,
    places: [], // listPlaces 聚合的地点卡片
    loadingPlaces: false,
    placesError: '',
    viewMode: 'list', // 段控：'list' | 'map'（spec 6.2）
    markers: [], // <map> markers：id 必须是数字（placeId 字符串 → 稠密下标映射）
    mapPoints: [], // include-points 只认 {latitude, longitude} 纯点数组
    unreadCount: 0, // bootstrap.unreadCount（spec 8.2：红点条唯一数据源）
    unreadOpen: false, // 红点条展开态：展开后列表保留展示，再点收起
    unreadRecords: [],
    unreadMore: 0, // 未读超出单页上限时被截掉的条数（条数诚实性）
    unreadLoading: false,
    unreadError: ''
  },

  onShow () {
    // 冷启动身份检查每个页面实例只做一次（从 onboarding reLaunch 回来是全新实例）；
    // 已检查过则只刷新——聚合立即更新、未读数对齐最新水位（双机场景）
    if (this.bootstrapped) {
      this.loadPlaces()
      this.refreshUnread()
      return
    }
    this.bootstrapped = true
    this.checkMembership()
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

  // 回页轻刷新未读数（双机场景：回到首页能看到对方新发的记录数）。
  // 失败静默：红点保留旧值，下个 onShow 再试。
  async refreshUnread () {
    if (!this.data.me) return
    try {
      this.applyBootstrap(await callApi('bootstrap'))
    } catch (err) { /* 静默 */ }
  },

  // bootstrap 结果落地（冷启动与轻刷新共用）：写 globalData、更新 me/unreadCount；
  // 不在圈（me 为 null）则 reLaunch 到 onboarding。返回是否仍在圈。
  applyBootstrap (result) {
    if (!result || !result.me) {
      wx.reLaunch({ url: '/pages/onboarding/onboarding' })
      return false
    }
    getApp().globalData.bootstrap = result
    // 竞态防护：markRead 刚推进本地水位时，在途的旧 bootstrap 响应（markRead 前
    // 计算）不得把已消的红点复活。用时间戳数值比较，兼容 Date 与 ISO 字符串两种形态
    const prev = this.data.me
    const prevTs = prev && prev.lastReadAt ? new Date(prev.lastReadAt).getTime() : 0
    const nextTs = result.me.lastReadAt ? new Date(result.me.lastReadAt).getTime() : 0
    if (prevTs && nextTs && nextTs < prevTs) {
      return true
    }
    this.setData({ me: result.me, unreadCount: result.unreadCount || 0 })
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
        // include-points 只认 {latitude, longitude} 点，别把 marker 整对象塞进去
        mapPoints: markers.map(m => ({ latitude: m.latitude, longitude: m.longitude })),
        loadingPlaces: false
      })
    } catch (err) {
      this.setData({ loadingPlaces: false, placesError: err.message || '加载失败' })
    }
  },

  // 一店一 marker（spec 6.2）：<map> 的 marker id 必须是数字，placeId 字符串
  // 按下标映射。location 为 Geo.Point，coordinates = [经度, 纬度]。
  // id 用 markers 自身的稠密下标（不是 places 下标）：缺坐标的地点被跳过时
  // 点击也不会错位，onCalloutTap 按 markers[id] 回查即可对上。
  // customCallout 内容在 wxml 的 <cover-view slot="callout" marker-id> 里渲染
  // （原生层置顶可点），display BYCLICK：点 marker 才弹气泡。
  buildMarkers (places) {
    const markers = []
    places.forEach(p => {
      const loc = p.location
      if (!loc || !Array.isArray(loc.coordinates) || loc.coordinates.length < 2) return
      const longitude = Number(loc.coordinates[0])
      const latitude = Number(loc.coordinates[1])
      if (isNaN(longitude) || isNaN(latitude)) return
      markers.push({
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
    if (mode !== 'map' && mode !== 'list') return
    if (mode !== this.data.viewMode) this.setData({ viewMode: mode })
  },

  // 点 marker 气泡 → 地点页（spec 6.3）：气泡点击走 map 的 callouttap 事件
  // （cover-view 自身的 tap 在部分真机不派发），e.detail.markerId 即 marker 数字 id。
  // 名称先带上，加载后再校准导航栏标题
  onCalloutTap (e) {
    const marker = this.data.markers[e.detail.markerId]
    if (!marker) return
    wx.navigateTo({
      url: `/pages/place/place?placeId=${marker.placeId}&name=${encodeURIComponent(marker.name || '')}`
    })
  },

  // 点地点卡片 → 地点页（spec 6.3）
  onOpenPlace (e) {
    const { id, name } = e.currentTarget.dataset
    wx.navigateTo({
      url: `/pages/place/place?placeId=${id}&name=${encodeURIComponent(name || '')}`
    })
  },

  // 红点条（spec 6.2 / 8.2）：点击展开最新未读记录并 markRead；已展开则收起。
  // 还有未读（含上次 markRead 失败保留的红点）就重新拉取——缓存的旧列表不能
  // 挡住新到的记录；已读过再展开只是回看，不重复请求
  async onTapUnread () {
    if (this.data.unreadOpen) {
      this.setData({ unreadOpen: false })
      return
    }
    this.setData({ unreadOpen: true })
    if (this.data.unreadCount > 0 || this.data.unreadError ||
        this.data.unreadRecords.length === 0) {
      await this.openUnread()
    }
  },

  // 展开未读列表：listFeed after 游标取水位之后的记录（可见性由服务端过滤，
  // 未读口径还排除自己发的——与 bootstrap.unreadCount 一致，计数=列表）
  async openUnread () {
    if (this.data.unreadLoading) return // 防快速收起/展开导致并发重复请求
    const me = this.data.me
    const watermark = me && (me.lastReadAt || me.joinedAt)
    if (!watermark) {
      // 历史数据缺水位的兜底：给错误态与重试入口，别落进「没有新的回忆」假象
      this.setData({ unreadError: '缺少已读水位，暂时无法展开' })
      return
    }
    this.setData({ unreadLoading: true, unreadError: '' })
    try {
      const result = await callApi('listFeed', { after: watermark, limit: UNREAD_PAGE })
      const unread = (result.records || [])
        .filter(r => r.authorId !== me.openid)
        .map(r => ({
          _id: r._id,
          thumb: ((r.media || []).find(m => m && m.type === 'image' && m.fileID) || {}).fileID || '',
          text: r.text || '',
          authorName: r.author ? r.author.nickname : '',
          timeText: formatTime(r.happenedAt || r.createdAt)
        }))
      this.setData({
        unreadRecords: unread,
        unreadMore: Math.max(0, this.data.unreadCount - unread.length),
        unreadLoading: false
      })
      this.advanceWatermark()
    } catch (err) {
      this.setData({ unreadLoading: false, unreadError: err.message || '加载失败' })
    }
  },

  // 水位推进与展开解耦：markRead 失败不阻塞展示、不误报「加载失败」，
  // 红点保留下次再点；成功则用服务端返回的时间推进本地水位（云函数侧时钟，
  // 不信任设备时间），防在途旧 bootstrap 响应复活红点
  async advanceWatermark () {
    try {
      const result = await callApi('markRead')
      this.setData({
        unreadCount: 0,
        me: { ...this.data.me, lastReadAt: result.lastReadAt }
      })
    } catch (err) { /* 静默：红点保留 */ }
  },

  // 未读记录点进详情
  onOpenUnreadRecord (e) {
    wx.navigateTo({ url: `/pages/detail/detail?recordId=${e.currentTarget.dataset.id}` })
  },

  // 右下角打卡按钮 → 发布页（spec 6.2）
  onTapPublish () {
    wx.navigateTo({ url: '/pages/publish/publish' })
  }
})
