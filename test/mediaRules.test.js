// T15：发布页媒体约束（spec 4.5 / T12 修订）——图 ≤9、视频 ≤3 且每段 ≤60s、合计 ≤12。
// 纯函数，不依赖 wx，供发布页在 wx.chooseMedia 返回后即时过滤并提示。
const { mergeMedia, LIMITS } = require('../miniprogram/services/mediaRules')

const img = i => ({ path: `img-${i}.jpg`, type: 'image' })
const vid = (i, duration) => ({ path: `vid-${i}.mp4`, type: 'video', duration })

describe('mergeMedia（媒体约束并入）', () => {
  test('常量约束与 spec 4.5 一致', () => {
    expect(LIMITS).toEqual({ IMAGE_MAX: 9, VIDEO_MAX: 3, VIDEO_DURATION_MAX: 60, TOTAL_MAX: 12 })
  })

  test('空列表并入常规批次：全部接收', () => {
    const { list, dropped } = mergeMedia([], [img(1), img(2), vid(1, 30)])
    expect(list).toHaveLength(3)
    expect(dropped).toEqual({ images: 0, videos: 0, longVideos: 0 })
  })

  test('图片超过 9 张：只并到 9 张，dropped.images 计数被拦数量', () => {
    const { list, dropped } = mergeMedia([], Array.from({ length: 12 }, (_, i) => img(i)))
    expect(list).toHaveLength(9)
    expect(dropped.images).toBe(3)
  })

  test('视频超过 3 段：只并到 3 段', () => {
    const { list, dropped } = mergeMedia([], [vid(1, 10), vid(2, 20), vid(3, 30), vid(4, 40)])
    expect(list).toHaveLength(3)
    expect(dropped.videos).toBe(1)
  })

  test('单段视频超 60s：该段被拦，dropped.longVideos 计数', () => {
    const { list, dropped } = mergeMedia([], [img(1), vid(1, 61)])
    expect(list).toEqual([img(1)])
    expect(dropped.longVideos).toBe(1)
  })

  test('恰好 60s 的视频放行', () => {
    const { list, dropped } = mergeMedia([], [vid(1, 60)])
    expect(list).toHaveLength(1)
    expect(dropped.longVideos).toBe(0)
  })

  test('图 + 视频混搭合计 ≤12：合计超限时后面的被拦', () => {
    const batch = [
      ...Array.from({ length: 9 }, (_, i) => img(i)),
      vid(1, 10), vid(2, 20), vid(3, 30),
      img(9) // 第 13 个，超出合计上限
    ]
    const { list, dropped } = mergeMedia([], batch)
    expect(list).toHaveLength(12)
    expect(list.filter(m => m.type === 'image')).toHaveLength(9)
    expect(dropped.images).toBe(1)
  })

  test('已有 9 图再选：新图全部被拦，视频仍可并', () => {
    const existing = Array.from({ length: 9 }, (_, i) => img(i))
    const { list, dropped } = mergeMedia(existing, [img(9), vid(1, 15)])
    expect(list).toHaveLength(10)
    expect(list.filter(m => m.type === 'video')).toHaveLength(1)
    expect(dropped.images).toBe(1)
  })

  test('缺 duration 的视频按超时长拦截（时长未知不放行）', () => {
    const { list, dropped } = mergeMedia([], [{ path: 'v.mp4', type: 'video' }])
    expect(list).toHaveLength(0)
    expect(dropped.longVideos).toBe(1)
  })
})
