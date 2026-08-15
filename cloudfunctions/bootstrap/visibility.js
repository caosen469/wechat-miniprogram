// 可见性过滤公共函数（spec 4.6）——所有读/写路径云函数统一复用的规则入口。
// 注意：云函数各自独立打包部署，共享代码只能随包复制——每个云函数各持一份
// 完全一致的副本，副本清单与一致性由 test/visibility.test.js 锁定；
// 新增云函数时把本文件一并复制过去，改动任何一份必须同步其余。

// spec 4.6：请求者 R 查记录，可见当且仅当三档之一成立
function visibleTo (record, requesterOpenid) {
  if (!record || typeof requesterOpenid !== 'string') return false
  if (record.visibility === 'family') return true
  if (record.visibility === 'pair') {
    return Array.isArray(record.pairIds) && record.pairIds.includes(requesterOpenid)
  }
  if (record.visibility === 'private') return record.authorId === requesterOpenid
  return false
}

// spec 4.2：退出/被移除成员的记录保留但对他人不可见——读路径在 visibleTo 之上
// 再核作者是否仍为 active 成员（activeOpenids：当前 active 成员 openid 的数组或 Set）
function isVisible (record, requesterOpenid, activeOpenids) {
  const actives = activeOpenids instanceof Set ? activeOpenids : new Set(activeOpenids || [])
  return visibleTo(record, requesterOpenid) && actives.has(record.authorId)
}

module.exports = { visibleTo, isVisible }
