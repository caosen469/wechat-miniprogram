// T19：listPlaces 足迹列表聚合（spec 5.1、6.2、4.4 派生值不落库）。
// 每个地点聚合其全部「可见」记录：均分 / 到访次数 / 情绪档位分布 /
// 封面（最新有图记录的首图，最多 4 张拼图）；排序按最近到访时间倒序。
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const listPlaces = require('../cloudfunctions/listPlaces/index')

const members = [
  { _id: 'm-a', openid: 'openid-a', nickname: '小曹', avatarUrl: 'cloud://ava-a.jpg', status: 'active' },
  { _id: 'm-b', openid: 'openid-b', nickname: '小美', avatarUrl: 'cloud://ava-b.jpg', status: 'active' },
  { _id: 'm-c', openid: 'openid-c', nickname: '旧人', avatarUrl: 'cloud://ava-c.jpg', status: 'left' }
]

const daysAgo = d => new Date(Date.now() - d * 86400000)

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
  happenedAt: daysAgo(1),
  collectionId: null,
  createdAt: daysAgo(1),
  updatedAt: daysAgo(1),
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

const placeById = result => Object.fromEntries(result.places.map(p => [p._id, p]))

describe('listPlaces（足迹列表聚合）', () => {
  test('非 active 成员：NOT_IN_CIRCLE', async () => {
    sdk.__reset({ ...seed(), openid: 'openid-x' })
    const result = await listPlaces.main({})
    expect(result).toEqual({ code: 'NOT_IN_CIRCLE', message: expect.any(String) })
  })

  test('同店 3 次打卡：visitCount=3，均分=三条记录均值，档位分布按各条评分计数', async () => {
    sdk.__reset(seed([
      record({ _id: 'r-1', rating: 5, happenedAt: daysAgo(10), media: [{ fileID: 'cloud://old.jpg', type: 'image' }] }),
      record({ _id: 'r-2', rating: 4, happenedAt: daysAgo(5) }),
      record({ _id: 'r-3', rating: 3, happenedAt: daysAgo(1) })
    ]))
    const result = await listPlaces.main({})
    expect(result.code).toBeUndefined()
    const place = placeById(result)['p-1']
    expect(place.visitCount).toBe(3)
    expect(place.avgRating).toBe(4)
    expect(place.tierCounts).toEqual({ good: 2, mid: 1, bad: 0 })
    expect(place.name).toBe('外婆家')
    expect(place.type).toBe('restaurant')
  })

  test('不可见记录不计入聚合：pair / private 档与退出成员的记录均排除', async () => {
    sdk.__reset(seed([
      record({ _id: 'r-family', rating: 5, authorId: 'openid-b', visibility: 'family' }),
      record({
        _id: 'r-pair', rating: 1, authorId: 'openid-b', visibility: 'pair',
        pairIds: ['openid-b', 'openid-c'] // openid-a 不在 pairIds 内
      }),
      record({ _id: 'r-private', rating: 1, authorId: 'openid-b', visibility: 'private' }),
      record({ _id: 'r-left', rating: 1, authorId: 'openid-c', visibility: 'family' })
    ]))
    const result = await listPlaces.main({}) // openid-a 视角
    const place = placeById(result)['p-1']
    expect(place.visitCount).toBe(1)
    expect(place.avgRating).toBe(5)
    expect(place.tierCounts).toEqual({ good: 1, mid: 0, bad: 0 })
  })

  test('封面 = 最新有图记录的首图在前，最多 4 张；补记旧时间不排到前面', async () => {
    sdk.__reset(seed([
      record({ _id: 'r-old', happenedAt: daysAgo(30), media: [{ fileID: 'cloud://old.jpg', type: 'image' }] }),
      record({ _id: 'r-new', happenedAt: daysAgo(1), media: [{ fileID: 'cloud://new.jpg', type: 'image' }, { fileID: 'cloud://new2.jpg', type: 'image' }] }),
      // 补记：发布晚但到访时间早 → 不抢封面
      record({ _id: 'r-mid', happenedAt: daysAgo(10), createdAt: daysAgo(0.1), media: [{ fileID: 'cloud://mid.jpg', type: 'image' }] }),
      // 无图记录：跳过，不产生封面也不挡住后面的图
      record({ _id: 'r-noimg', happenedAt: daysAgo(2), media: [] }),
      record({ _id: 'r-noimg2', happenedAt: daysAgo(3), media: [{ fileID: 'cloud://v.mp4', type: 'video', duration: 10 }] })
    ]))
    const result = await listPlaces.main({})
    const place = placeById(result)['p-1']
    // 按到访时间倒序取各条首图，无图/纯视频的跳过
    expect(place.covers).toEqual(['cloud://new.jpg', 'cloud://mid.jpg', 'cloud://old.jpg'])
  })

  test('只有一条记录时单图；有 5 条有图记录时封面截到 4 张', async () => {
    sdk.__reset(seed([record({ _id: 'r-only' })]))
    const single = await listPlaces.main({})
    expect(placeById(single)['p-1'].covers).toEqual(['cloud://r1.jpg'])

    sdk.__reset(seed(
      Array.from({ length: 5 }, (_, i) =>
        record({ _id: `r-${i}`, happenedAt: daysAgo(i + 1), media: [{ fileID: `cloud://c${i}.jpg`, type: 'image' }] }))
    ))
    const five = await listPlaces.main({})
    expect(placeById(five)['p-1'].covers)
      .toEqual(['cloud://c0.jpg', 'cloud://c1.jpg', 'cloud://c2.jpg', 'cloud://c3.jpg'])
  })

  test('多个地点按最近到访时间倒序；没有任何可见记录的地点不出现', async () => {
    sdk.__reset(seed([
      record({ _id: 'r-p1', placeId: 'p-1', happenedAt: daysAgo(10) }),
      record({ _id: 'r-p2', placeId: 'p-2', happenedAt: daysAgo(1) })
    ]))
    const result = await listPlaces.main({})
    expect(result.places.map(p => p._id)).toEqual(['p-2', 'p-1'])

    sdk.__reset(seed([record({ _id: 'r-p1', placeId: 'p-1' })]))
    const only = await listPlaces.main({})
    expect(only.places.map(p => p._id)).toEqual(['p-1'])
  })

  test('记录引用的地点已不存在（理论上不会发生）：跳过不崩', async () => {
    sdk.__reset(seed([record({ _id: 'r-gone', placeId: 'p-gone' })]))
    const result = await listPlaces.main({})
    expect(result.places).toHaveLength(0)
  })

  test('records 集合尚不存在（没人发布过）：返回空数组不崩', async () => {
    sdk.__reset({
      collections: {
        members,
        places
      }
    })
    const result = await listPlaces.main({})
    expect(result).toEqual({ places: [] })
  })
})
