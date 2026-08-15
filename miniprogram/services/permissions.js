// T25：权限被拒的统一判定与「去设置开启」引导（spec 10.2）。
// isAuthDenied 纯函数；guideToSetting 依赖 wx，仅在小程序端 catch 分支调用。
//
// 微信各平台的拒绝 errMsg 写法不一（iOS/Android/工具端冒号与拼写都有差异），
// 这里按「auth deny / auth denied / authorize no response」关键词匹配，
// 与「cancel」「普通 fail」区分：取消静默，普通失败走各自的错误提示。

const DENIED_RE = /auth\s*den(y|ied)|authorize/i

const errMsgOf = (err) => {
  if (!err) return ''
  if (typeof err === 'string') return err
  return err.errMsg || err.message || ''
}

// 是否为「用户曾拒绝授权」类失败（true 时应引导去设置开启）
const isAuthDenied = (err) => DENIED_RE.test(errMsgOf(err))

// 「去设置开启」引导弹层：确认后跳小程序设置页（spec 10.2 降级引导）
const guideToSetting = (title, content) => {
  wx.showModal({
    title,
    content,
    confirmText: '去设置',
    success: (r) => {
      if (r.confirm) wx.openSetting({})
    }
  })
}

module.exports = { isAuthDenied, guideToSetting }
