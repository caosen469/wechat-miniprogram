// T16：可见性过滤公共函数（spec 4.6）——两个读路径云函数各持一份部署副本
// （云函数独立打包部署，共享代码只能随包复制）。本测试锁定副本行为完全一致：
// 改了其中一份必须同步另一份，否则这里红。
// （visibility 是纯函数，不依赖 wx-server-sdk，无需 mock。）

const listFeedCopy = require('../cloudfunctions/listFeed/visibility')
const getRecordCopy = require('../cloudfunctions/getRecord/visibility')

const openid = 'openid-a'
const base = { authorId: 'openid-b', pairIds: null, visibility: 'family' }

// (名称, 记录, 期望可见) 矩阵：两份副本必须给出相同且符合 spec 4.6 的答案
const matrix = [
  ['family 档', { visibility: 'family' }, true],
  ['pair 档且在 pairIds', { visibility: 'pair', pairIds: ['openid-a', 'openid-b'] }, true],
  ['pair 档不在 pairIds', { visibility: 'pair', pairIds: ['openid-b', 'openid-c'] }, false],
  ['pair 档 pairIds 缺失', { visibility: 'pair', pairIds: null }, false],
  ['private 档本人', { visibility: 'private', authorId: 'openid-a' }, true],
  ['private 档他人', { visibility: 'private' }, false],
  ['未知档位', { visibility: 'public' }, false],
  ['记录为 null', null, false]
]

describe.each([
  ['listFeed 副本', listFeedCopy],
  ['getRecord 副本', getRecordCopy]
])('visibleTo（%s）', (_name, vis) => {
  test.each(matrix)('%s：%s', (_label, over, expected) => {
    const record = over === null ? null : { ...base, ...over }
    expect(vis.visibleTo(record, openid)).toBe(expected)
  })

  test('isVisible：作者已退出/被移除时不可见（spec 4.2）', () => {
    expect(vis.isVisible({ ...base, visibility: 'family' }, openid, ['openid-a', 'openid-b'])).toBe(true)
    expect(vis.isVisible({ ...base, visibility: 'family' }, openid, ['openid-a'])).toBe(false)
  })
})

test('两份副本的导出接口一致', () => {
  expect(Object.keys(listFeedCopy).sort()).toEqual(Object.keys(getRecordCopy).sort())
})
