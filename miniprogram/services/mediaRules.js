// 媒体约束（spec 4.5 / T12 修订）：图片 ≤9 张、视频 ≤3 段且每段 ≤60s、图与视频可混搭（合计 ≤12）。
// 纯函数：发布页在 wx.chooseMedia 返回后调用，把新批次并入现有列表并即时拦截超限项；
// 云函数 publishRecord 服务端复核同一套约束（约束值见 cloudfunctions/publishRecord/index.js）。
const LIMITS = {
  IMAGE_MAX: 9,
  VIDEO_MAX: 3,
  VIDEO_DURATION_MAX: 60,
  TOTAL_MAX: 12
}

// 把 incoming（[{path, type: 'image'|'video', duration?}]）并入 existing，
// 超限项直接丢弃。返回 { list, dropped }，dropped 用于提示被拦了多少：
//   { images: 图片数超限被拦, videos: 视频段数超限被拦, longVideos: 超 60s 被拦 }
// 视频缺 duration（时长未知）不放行，按超时长拦截。
function mergeMedia (existing, incoming) {
  const list = [...existing]
  const dropped = { images: 0, videos: 0, longVideos: 0 }
  let images = existing.filter(m => m.type === 'image').length
  let videos = existing.filter(m => m.type === 'video').length

  for (const item of incoming) {
    if (list.length >= LIMITS.TOTAL_MAX) {
      if (item.type === 'image') dropped.images++
      else if (item.type === 'video') dropped.videos++
      continue
    }
    if (item.type === 'image') {
      if (images >= LIMITS.IMAGE_MAX) {
        dropped.images++
        continue
      }
      images++
      list.push(item)
    } else if (item.type === 'video') {
      if (typeof item.duration !== 'number' || item.duration > LIMITS.VIDEO_DURATION_MAX) {
        dropped.longVideos++
        continue
      }
      if (videos >= LIMITS.VIDEO_MAX) {
        dropped.videos++
        continue
      }
      videos++
      list.push(item)
    }
  }
  return { list, dropped }
}

module.exports = { LIMITS, mergeMedia }
