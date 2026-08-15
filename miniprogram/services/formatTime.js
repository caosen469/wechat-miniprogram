// 时间格式化：云函数返回的 datetime 经 callFunction 序列化为字符串
function formatTime (input) {
  const d = input instanceof Date ? input : new Date(input)
  if (isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

module.exports = { formatTime }
