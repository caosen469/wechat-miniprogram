// getPlaceDetail —— 地点详情（spec 5.1、6.3）：{place, records[]}。
// T19 地点页（统计条 + 记录列表）依赖：records 时间倒序、可见性过滤、
// 作者/参与者昵称头像服务端 join。
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const getPlaceDetail = require('../cloudfunctions/getPlaceDetail/index')

const members = [
  { _id: 'm-a', openid: 'openid-a', nickname: '小曹', avatarUrl: 'cloud://ava-a.jpg', status: 'active' },
  { _id: 'm-b', openid: 'openid-b', nickname: '小美', avatarUrl: 'cloud://ava-b.jpg', status: 'active' },
  { _id: 'm-c', openid: 'openid-c', nickname: '旧人', avatarUrl: 'cloud://ava-c.jpg', status: 'left' }
]

const hoursAgo = h => new Date(Date.now() - h * 3600000)

const record = (over = {}) => ({
  placeId: 'p-1',
  authorId: 'openid-b',
  participantIds: [],
  media: [{ fileID: 'cloud://r1.jpg', type: 'image' }],
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

const seed = (records = []) => ({
  collections: {
    members,
    places,
    records
  }
})

describe('getPlaceDetail（地点详情）', () => {
  test('非 active 成员：NOT_IN_CIRCLE', async () => {
    sdk.__reset({ ...seed(), openid: 'openid-x' })
    const result = await getPlaceDetail.main({ placeId: 'p-1' })
    expect(result).toEqual({ code: 'NOT_IN_CIRCLE', message: expect.any(String) })
  })

  test('缺少 placeId 或地点不存在：VALIDATION_FAILED', async () => {
    sdk.__reset(seed())
    const missing = await getPlaceDetail.main({})
    expect(missing.code).toBe('VALIDATION_FAILED')

    sdk.__reset(seed())
    const gone = await getPlaceDetail.main({ placeId: 'p-gone' })
    expect(gone.code).toBe('VALIDATION_FAILED')
  })

  test('只返回该地点的记录，时间倒序（happenedAt 优先、createdAt 决胜），join 作者昵称头像', async () => {
    sdk.__reset(seed([
      record({ _id: 'r-old', placeId: 'p-1', happenedAt: hoursAgo(48), createdAt: hoursAgo(48) }),
      record({ _id: 'r-new', placeId: 'p-1', happenedAt: hoursAgo(1), createdAt: hoursAgo(1) }),
      // 补记：发布晚于 r-new，到访时间早于它 → 排中间
      record({ _id: 'r-mid', placeId: 'p-1', happenedAt: hoursAgo(24), createdAt: hoursAgo(0.5) }),
      record({ _id: 'r-other', placeId: 'p-2', happenedAt: hoursAgo(0.1) })
    ]))
    const result = await getPlaceDetail.main({ placeId: 'p-1' })
    expect(result.code).toBeUndefined()
    expect(result.place._id).toBe('p-1')
    expect(result.records.map(r => r._id)).toEqual(['r-new', 'r-mid', 'r-old'])
    expect(result.records[0].author).toEqual({
      openid: 'openid-b', nickname: '小美', avatarUrl: 'cloud://ava-b.jpg'
    })
  })

  test('可见性过滤：pair 档圈外人不可见、private 档仅作者可见、退出成员的记录不可见', async () => {
    sdk.__reset(seed([
      record({ _id: 'r-family', visibility: 'family' }),
      record({
        _id: 'r-pair', visibility: 'pair',
        pairIds: ['openid-b', 'openid-c'] // openid-a 不在 pairIds 内
      }),
      record({ _id: 'r-private', visibility: 'private', authorId: 'openid-b' }),
      record({ _id: 'r-left', authorId: 'openid-c', visibility: 'family' })
    ]))
    const result = await getPlaceDetail.main({ placeId: 'p-1' }) // openid-a 视角
    expect(result.records.map(r => r._id)).toEqual(['r-family'])
  })

  test('该地点一条可见记录都没有：返回空 records 不崩', async () => {
    sdk.__reset(seed([record({ _id: 'r-priv', visibility: 'private', authorId: 'openid-b' })]))
    const result = await getPlaceDetail.main({ placeId: 'p-1' })
    expect(result.records).toEqual([])
  })
})
