// T25：权限被拒检测（spec 10.2：相机/相册/麦克风/定位被拒要有「去设置开启」引导，
// 不白屏不死路）。纯函数，不依赖 wx；errMsg 判定供发布页各 catch 分支复用。
const { isAuthDenied } = require('../miniprogram/services/permissions')

describe('isAuthDenied（权限被拒的 errMsg 判定）', () => {
  test.each([
    // 微信各平台 errMsg 写法不一：iOS/Android/开发者工具的拒绝形态
    ['chooseMedia:fail auth deny', true],
    ['chooseMedia:fail:auth deny', true],
    ['chooseMedia:fail auth denied', true],
    ['getLocation:fail auth deny', true],
    ['choosePoi:fail auth deny', true],
    ['chooseMedia:fail authorize no response', true],
    ['getLocation:fail:authorize no response', true]
  ])('%s → %s', (msg, expected) => {
    expect(isAuthDenied(msg)).toBe(expected)
  })

  test.each([
    // 取消与普通失败不算被拒：取消静默，普通失败走各自的错误提示
    ['chooseMedia:fail cancel', false],
    ['choosePoi:fail cancel', false],
    ['getLocation:fail:timeout', false],
    ['chooseMedia:fail', false]
  ])('%s → %s', (msg, expected) => {
    expect(isAuthDenied(msg)).toBe(expected)
  })

  test('接受 Error 对象与空值', () => {
    expect(isAuthDenied(new Error('chooseMedia:fail auth deny'))).toBe(true)
    expect(isAuthDenied(undefined)).toBe(false)
    expect(isAuthDenied(null)).toBe(false)
  })
})
