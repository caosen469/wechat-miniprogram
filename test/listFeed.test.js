// T16：listFeed 简版足迹流水（spec 5.1、4.6 可见性过滤）。
// 时间倒序、服务端 join 作者昵称头像（前端无二次请求）、placeId/before/limit。
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const listFeed = require('../cloudfunctions/listFeed/index')

const members = [
  { _id: 'm-a', openid: 'openid-a', nickname: '小曹', avatarUrl: 'cloud://ava-a.jpg', status: 'active' },
  { _id: 'm-b', openid: 'openid-b', nickname: '小美', avatarUrl: 'cloud://ava-b.jpg', status: 'active' },
  { _id: 'm-c', openid: 'openid-c', nickname: '旧人', avatarUrl: 'cloud://ava-c.jpg', status: 'left' }
]

const hoursAgo = h => new Date(Date.now() - h * 3600000)

// spec 4.5 字段表的记录构造器（简化版固定值 + 可覆盖）
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
  { _id: 'p-1', poiId: 'POI-1', name: '外婆家', type: 'restaurant', coverFileID: 'cloud://r1.jpg' },
  { _id: 'p-2', poiId: null, name: '家里楼下', type: 'other', coverFileID: null }
]

const seed = (records = []) => ({
  collections: {
    members,
    places,
    records
  }
})

describe('listFeed（简版足迹流水）', () => {
  test('非 active 成员：NOT_IN_CIRCLE', async () => {
    sdk.__reset(seed())
    sdk.__reset({ ...seed(), openid: 'openid-x' })
    const result = await listFeed.main({})
    expect(result).toEqual({ code: 'NOT_IN_CIRCLE', message: expect.any(String) })
  })

  test('按时间倒序返回（happenedAt 优先、createdAt 决胜），作者昵称头像由服务端 join（前端无二次请求）', async () => {
    sdk.__reset(seed([
      record({ _id: 'r-old', createdAt: hoursAgo(48), happenedAt: hoursAgo(48), text: '两天前' }),
      record({ _id: 'r-new', createdAt: hoursAgo(1), happenedAt: hoursAgo(1), text: '刚发' }),
      // 补记：发布晚于 r-new，但到访时间早于它 → 排在 r-new 之后（T18 语义）
      record({ _id: 'r-mid', createdAt: hoursAgo(0.5), happenedAt: hoursAgo(24), text: '补记昨天' })
    ]))
    const result = await listFeed.main({})
    expect(result.code).toBeUndefined()
    expect(result.records.map(r => r._id)).toEqual(['r-new', 'r-mid', 'r-old'])
    // join 的作者信息直接可渲染
    expect(result.records[0].author).toEqual({ openid: 'openid-b', nickname: '小美', avatarUrl: 'cloud://ava-b.jpg' })
  })

  test('placeId 过滤：只返回该地点的记录，并 join 地点名称与类型', async () => {
    sdk.__reset(seed([
      record({ _id: 'r-1', placeId: 'p-1' }),
      record({ _id: 'r-2', placeId: 'p-2', text: '楼下遛弯' })
    ]))
    const result = await listFeed.main({ placeId: 'p-2' })
    expect(result.records.map(r => r._id)).toEqual(['r-2'])
    expect(result.records[0].place).toEqual({ name: '家里楼下', type: 'other' })
  })

  test('地点已不存在（理论上不会发生）：place 为 null 不崩', async () => {
    sdk.__reset(seed([record({ placeId: 'p-gone' })]))
    const result = await listFeed.main({})
    expect(result.records[0].place).toBeNull()
  })

  test('before 游标：只返回 happenedAt 不晚于 before 的记录（ISO 字符串也接受）', async () => {
    sdk.__reset(seed([
      record({ _id: 'r-new', createdAt: hoursAgo(1), happenedAt: hoursAgo(1) }),
      record({ _id: 'r-old', createdAt: hoursAgo(48), happenedAt: hoursAgo(48) })
    ]))
    const asDate = await listFeed.main({ before: hoursAgo(10) })
    expect(asDate.records.map(r => r._id)).toEqual(['r-old'])

    sdk.__reset(seed([
      record({ _id: 'r-new', createdAt: hoursAgo(1), happenedAt: hoursAgo(1) }),
      record({ _id: 'r-old', createdAt: hoursAgo(48), happenedAt: hoursAgo(48) })
    ]))
    const asString = await listFeed.main({ before: hoursAgo(10).toISOString() })
    expect(asString.records.map(r => r._id)).toEqual(['r-old'])
  })

  test('limit 截断（默认 20，上限 50）', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      record({ _id: `r-${i}`, createdAt: hoursAgo(i + 1) }))
    sdk.__reset(seed(many))

    const byDefault = await listFeed.main({})
    expect(byDefault.records).toHaveLength(20)

    const byParam = await listFeed.main({ limit: 5 })
    expect(byParam.records).toHaveLength(5)
    expect(byParam.records.map(r => r._id)).toEqual(['r-0', 'r-1', 'r-2', 'r-3', 'r-4'])

    const clamped = await listFeed.main({ limit: 99 })
    expect(clamped.records).toHaveLength(25)
  })

  describe('可见性过滤（spec 4.6，公共 visibleTo 函数）', () => {
    const pairRecord = [record({
      _id: 'r-pair',
      visibility: 'pair',
      pairIds: ['openid-a', 'openid-b'],
      authorId: 'openid-b'
    })]
    const thirdMember = {
      _id: 'm-d', openid: 'openid-d', nickname: '第三者', status: 'active'
    }

    test('family 档：圈内任何 active 成员可见（他人发的也可见）', async () => {
      sdk.__reset(seed([record({ _id: 'r-1', visibility: 'family', authorId: 'openid-b' })]))
      const result = await listFeed.main({})
      expect(result.records.map(r => r._id)).toEqual(['r-1'])
    })

    test('pair 档：仅 pairIds 内两人可见，圈外 active 成员不可见', async () => {
      sdk.__reset(seed(pairRecord))
      const inPair = await listFeed.main({}) // openid-a ∈ pairIds
      expect(inPair.records.map(r => r._id)).toEqual(['r-pair'])

      sdk.__reset({
        collections: {
          members: [...members, thirdMember],
          places,
          records: pairRecord
        },
        openid: 'openid-d'
      })
      const outsider = await listFeed.main({})
      expect(outsider.records).toHaveLength(0)
    })

    test('private 档：仅作者本人可见', async () => {
      const records = [record({ _id: 'r-priv', visibility: 'private', authorId: 'openid-b' })]
      // 作者视角
      sdk.__reset({ ...seed(records), openid: 'openid-b' })
      const mine = await listFeed.main({})
      expect(mine.records.map(r => r._id)).toEqual(['r-priv'])

      // 他人视角（openid-a 也是 active 成员）
      sdk.__reset(seed(records))
      const others = await listFeed.main({})
      expect(others.records).toHaveLength(0)
    })
  })

  test('退出/被移除成员的记录：保留在库但对他人不可见（spec 4.2）', async () => {
    sdk.__reset(seed([
      record({ _id: 'r-left', authorId: 'openid-c', visibility: 'family' }),
      record({ _id: 'r-active', authorId: 'openid-b', visibility: 'family' })
    ]))
    const result = await listFeed.main({})
    expect(result.records.map(r => r._id)).toEqual(['r-active'])
  })

  test('records 集合尚不存在（没人发布过）：返回空数组不崩', async () => {
    sdk.__reset({
      collections: {
        members,
        places
      }
    })
    const result = await listFeed.main({})
    expect(result).toEqual({ records: [] })
  })
})
