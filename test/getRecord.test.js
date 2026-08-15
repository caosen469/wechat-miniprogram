// T16：getRecord 简版详情（spec 5.1、4.6 可见性过滤）。
// 可见者才返回详情（含作者 join、地点 join、到访序号）；不存在/不可见一律 NOT_VISIBLE。
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const getRecord = require('../cloudfunctions/getRecord/index')

const members = [
  { _id: 'm-a', openid: 'openid-a', nickname: '小曹', avatarUrl: 'cloud://ava-a.jpg', status: 'active' },
  { _id: 'm-b', openid: 'openid-b', nickname: '小美', avatarUrl: 'cloud://ava-b.jpg', status: 'active' },
  { _id: 'm-d', openid: 'openid-d', nickname: '第三者', avatarUrl: 'cloud://ava-d.jpg', status: 'active' },
  { _id: 'm-c', openid: 'openid-c', nickname: '旧人', avatarUrl: 'cloud://ava-c.jpg', status: 'left' }
]

const hoursAgo = h => new Date(Date.now() - h * 3600000)

const record = (over = {}) => ({
  placeId: 'p-1',
  authorId: 'openid-b',
  participantIds: [],
  media: [
    { fileID: 'cloud://r1.jpg', type: 'image' },
    { fileID: 'cloud://r2.jpg', type: 'image' }
  ],
  text: '好吃',
  audio: null,
  rating: 4,
  visibility: 'family',
  pairIds: null,
  happenedAt: hoursAgo(1),
  collectionId: null,
  createdAt: hoursAgo(1),
  updatedAt: hoursAgo(1),
  ...over
})

const places = [
  { _id: 'p-1', poiId: 'POI-1', name: '外婆家', type: 'restaurant', coverFileID: 'cloud://r1.jpg' }
]

const seed = (records = [], openid = 'openid-a') => ({
  collections: { members, places, records },
  openid
})

describe('getRecord（简版详情）', () => {
  test('非 active 成员：NOT_IN_CIRCLE', async () => {
    sdk.__reset(seed([], 'openid-x'))
    const result = await getRecord.main({ recordId: 'r-1' })
    expect(result).toEqual({ code: 'NOT_IN_CIRCLE', message: expect.any(String) })
  })

  test('family 记录：返回详情，作者昵称头像与地点由服务端 join', async () => {
    sdk.__reset(seed([record({ _id: 'r-1' })]))
    const result = await getRecord.main({ recordId: 'r-1' })
    expect(result.code).toBeUndefined()
    expect(result.record._id).toBe('r-1')
    expect(result.record.media).toHaveLength(2)
    expect(result.record.text).toBe('好吃')
    expect(result.record.rating).toBe(4)
    expect(result.author).toEqual({ openid: 'openid-b', nickname: '小美', avatarUrl: 'cloud://ava-b.jpg' })
    expect(result.place).toEqual({ name: '外婆家', type: 'restaurant' })
    expect(result.visitNo).toBe(1)
  })

  test('到访序号：同地点按时间倒序取序（最新一条 = 第 3 次到访）', async () => {
    sdk.__reset(seed([
      record({ _id: 'r-1st', createdAt: hoursAgo(72) }),
      record({ _id: 'r-2nd', createdAt: hoursAgo(48) }),
      record({ _id: 'r-3rd', createdAt: hoursAgo(1) }),
      record({ _id: 'r-other-place', placeId: 'p-2', createdAt: hoursAgo(2) }) // 别的地点不计入
    ]))
    const result = await getRecord.main({ recordId: 'r-3rd' })
    expect(result.visitNo).toBe(3)

    sdk.__reset(seed([
      record({ _id: 'r-1st', createdAt: hoursAgo(72) }),
      record({ _id: 'r-2nd', createdAt: hoursAgo(48) }),
      record({ _id: 'r-3rd', createdAt: hoursAgo(1) })
    ]))
    const middle = await getRecord.main({ recordId: 'r-2nd' })
    expect(middle.visitNo).toBe(2)
  })

  test('记录不存在：NOT_VISIBLE（不泄露存在性）', async () => {
    sdk.__reset(seed([record({ _id: 'r-1' })]))
    const result = await getRecord.main({ recordId: 'no-such-record' })
    expect(result).toEqual({ code: 'NOT_VISIBLE', message: expect.any(String) })
  })

  test('pair 记录：pairIds 内可见，圈外 active 成员 NOT_VISIBLE', async () => {
    const records = [record({
      _id: 'r-pair', visibility: 'pair', pairIds: ['openid-a', 'openid-b'], authorId: 'openid-b'
    })]
    sdk.__reset(seed(records, 'openid-a'))
    const inPair = await getRecord.main({ recordId: 'r-pair' })
    expect(inPair.code).toBeUndefined()

    sdk.__reset(seed(records, 'openid-d'))
    const outsider = await getRecord.main({ recordId: 'r-pair' })
    expect(outsider.code).toBe('NOT_VISIBLE')
  })

  test('private 记录：作者可见，他人 NOT_VISIBLE', async () => {
    const records = [record({ _id: 'r-priv', visibility: 'private', authorId: 'openid-b' })]
    sdk.__reset(seed(records, 'openid-b'))
    const mine = await getRecord.main({ recordId: 'r-priv' })
    expect(mine.code).toBeUndefined()

    sdk.__reset(seed(records, 'openid-a'))
    const others = await getRecord.main({ recordId: 'r-priv' })
    expect(others.code).toBe('NOT_VISIBLE')
  })

  test('退出/被移除成员的记录：对他人 NOT_VISIBLE（spec 4.2）', async () => {
    sdk.__reset(seed([record({ _id: 'r-left', authorId: 'openid-c', visibility: 'family' })]))
    const result = await getRecord.main({ recordId: 'r-left' })
    expect(result.code).toBe('NOT_VISIBLE')
  })

  test('地点已不存在：place 为 null 不崩', async () => {
    sdk.__reset(seed([record({ _id: 'r-1', placeId: 'p-gone' })]))
    const result = await getRecord.main({ recordId: 'r-1' })
    expect(result.place).toBeNull()
  })

  test('记录被 pair 中另一人看到时到访序号只统计该请求者可见的记录', async () => {
    sdk.__reset(seed([
      record({ _id: 'r-pair-old', createdAt: hoursAgo(48), visibility: 'pair', pairIds: ['openid-a', 'openid-b'] }),
      record({ _id: 'r-family-old', createdAt: hoursAgo(24) }), // openid-a 可见
      record({ _id: 'r-pair-new', createdAt: hoursAgo(1), visibility: 'pair', pairIds: ['openid-a', 'openid-b'] })
    ]))
    const result = await getRecord.main({ recordId: 'r-pair-new' })
    // openid-a 三条都可见 → 第 3 次
    expect(result.visitNo).toBe(3)

    // 换 openid-d（第三者）：只可见 family 一条，但目标记录本身不可见 → NOT_VISIBLE
    sdk.__reset(seed([
      record({ _id: 'r-pair-old', createdAt: hoursAgo(48), visibility: 'pair', pairIds: ['openid-a', 'openid-b'] }),
      record({ _id: 'r-family-old', createdAt: hoursAgo(24) }),
      record({ _id: 'r-pair-new', createdAt: hoursAgo(1), visibility: 'pair', pairIds: ['openid-a', 'openid-b'] })
    ], 'openid-d'))
    const outsider = await getRecord.main({ recordId: 'r-pair-new' })
    expect(outsider.code).toBe('NOT_VISIBLE')
  })
})
