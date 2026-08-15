// 云函数调用封装：统一把云函数的 {code, message} 错误码结构（spec 5.2）转成异常。
// 业务代码只需 try/catch，通过 err.code 区分错误码。
async function callApi (name, data = {}) {
  const res = await wx.cloud.callFunction({ name, data })
  const result = res.result
  if (result && typeof result.code === 'string') {
    const err = new Error(result.message || result.code)
    err.code = result.code
    throw err
  }
  return result
}

module.exports = { callApi }
