// 可见性过滤公共函数（spec 4.6）——所有读路径（listFeed / getRecord / 之后的
// updateRecord / deleteRecord / 通知过滤）统一复用的规则入口。
// 注意：云函数各自独立打包部署，共享代码只能随包复制——本文件在 listFeed 与
// getRecord 各持一份副本，两份必须保持一致（test/visibility.test.js 锁定）；
// 新增读路径云函数时把本文件一并复制过去。

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
