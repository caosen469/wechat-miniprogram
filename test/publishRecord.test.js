// T15：publishRecord 发布记录（spec 5.1、4.4/4.5 字段表）
// T18 扩展：可见范围三档（pair 固化 circles.pairIds 创建时快照）、参与者多选、补记时间。
// 新地点按 poiId 查重归并（手动地点 poiId=null 不归并）。
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const publishRecord = require('../cloudfunctions/publishRecord/index')

const me = { openid: 'openid-a', nickname: '我', status: 'active' }
const partner = { _id: 'm-b', openid: 'openid-b', nickname: '女友', status: 'active' }
const removed = { _id: 'm-x', openid: 'openid-x', nickname: '旧成员', status: 'removed' }
const mediaOk = [
  { fileID: 'cloud://r1.jpg', type: 'image' },
  { fileID: 'cloud://r2.mp4', type: 'video', duration: 30 }
]
const newPlace = (over = {}) => ({
  poiId: 'POI-1',
  name: '外婆家（湖滨银泰店）',
  type: 'restaurant',
  location: { latitude: 30.25, longitude: 120.17 },
  ...over
})

const seed = (over = {}) => ({
  collections: {
    circles: [{ ownerId: 'openid-a', pairIds: ['openid-a', 'openid-b'], createdAt: new Date() }],
    members: [
      { _id: 'm-a', ...me },
      { ...partner },
      { ...removed }
    ],
    places: [],
    records: []
  },
  ...over
})

// 播种默认数据后调用云函数。同一用例内多次 publish 连续发布（不重置状态，
// 用于测归并/继承）；beforeEach 置 needReset 让每个用例从全新环境开始。
let needReset = true

async function publish (event = {}) {
  if (needReset) {
    sdk.__reset(seed())
    needReset = false
  }
  return publishRecord.main({
    media: mediaOk,
    text: '还行',
    rating: 4,
    newPlace: newPlace(),
    ...event
  })
}

beforeEach(() => {
  needReset = true
})

describe('publishRecord（发布记录）', () => {
  test('全新环境 places/records 集合尚不存在：自动补建后发布成功', async () => {
    // 回归：曾因集合缺失在 add 时抛错，前端表现为 cloud.callFunction:fail
    sdk.__reset({
      collections: {
        circles: [{ ownerId: 'openid-a', pairIds: [], createdAt: new Date() }],
        members: [{ _id: 'm-a', ...me }]
      }
    })
    needReset = false

    const result = await publishRecord.main({
      media: mediaOk, text: '首打卡', rating: 5, newPlace: newPlace()
    })

    expect(result.code).toBeUndefined()
    expect(result.recordId).toBeTruthy()
    expect(sdk.__state.collections.places).toHaveLength(1)
    expect(sdk.__state.collections.records).toHaveLength(1)
  })

  test('新地点首打卡：建 places + records 文档，字段符合 spec 4.4/4.5', async () => {
    const result = await publish()

    expect(result.code).toBeUndefined()
    expect(result.recordId).toBeTruthy()

    const places = sdk.__state.collections.places
    expect(places).toHaveLength(1)
    expect(places[0].poiId).toBe('POI-1')
    expect(places[0].name).toBe('外婆家（湖滨银泰店）')
    expect(places[0].type).toBe('restaurant')
    expect(places[0].location.coordinates).toEqual([120.17, 30.25]) // Geo.Point(longitude, latitude)
    expect(places[0].coverFileID).toBe('cloud://r1.jpg') // 最新记录首图即封面
    expect(places[0].createdBy).toBe('openid-a')
    expect(places[0].createdAt).toBeInstanceOf(Date)

    const records = sdk.__state.collections.records
    expect(records).toHaveLength(1)
    expect(records[0].placeId).toBe(places[0]._id)
    expect(records[0].authorId).toBe('openid-a')
    expect(records[0].media).toEqual(mediaOk)
    expect(records[0].text).toBe('还行')
    expect(records[0].rating).toBe(4)
    expect(records[0].visibility).toBe('family')
    expect(records[0].participantIds).toEqual([])
    expect(records[0].audio).toBeNull()
    expect(records[0].collectionId).toBeNull()
    expect(records[0].happenedAt).toBeInstanceOf(Date)
    expect(records[0].createdAt).toBeInstanceOf(Date)
  })

  test('同 poiId 再打卡：归并到同一 places 文档，类型继承不覆盖', async () => {
    const first = await publish()
    const placeIdBefore = sdk.__state.collections.places[0]._id
    // 第二次走 placeId（POI 命中已有地点时前端复用）
    const second = await publish({ newPlace: undefined, placeId: placeIdBefore, rating: 2 })

    expect(second.code).toBeUndefined()
    expect(sdk.__state.collections.places).toHaveLength(1)
    expect(sdk.__state.collections.records).toHaveLength(2)
    expect(sdk.__state.collections.records.every(r => r.placeId === placeIdBefore)).toBe(true)
    // 到访继承地点类型
    expect(sdk.__state.collections.places[0].type).toBe('restaurant')
  })

  test('newPlace 与已有地点同 poiId：归并，不建新地点、不覆盖类型', async () => {
    await publish()
    const second = await publish({
      newPlace: newPlace({ type: 'attraction' }), // POI 反查回来的类型与首打卡不同
      rating: 5
    })
    expect(second.code).toBeUndefined()
    expect(sdk.__state.collections.places).toHaveLength(1)
    expect(sdk.__state.collections.places[0].type).toBe('restaurant') // 首打卡选定后继承
    expect(sdk.__state.collections.records).toHaveLength(2)
  })

  test('手动新地点（poiId=null）：不与任何 POI 地点归并，每次新建', async () => {
    await publish() // POI-1 已建
    const manual = await publish({
      newPlace: newPlace({ poiId: null, name: '家里楼下', type: 'other', location: null }),
      rating: 3
    })
    expect(manual.code).toBeUndefined()
    expect(sdk.__state.collections.places).toHaveLength(2)
    expect(sdk.__state.collections.places[1].poiId).toBeNull()
    expect(sdk.__state.collections.places[1].location).toBeNull()
  })

  test('无图片的记录不覆盖地点已有封面', async () => {
    const first = await publish()
    const placeId = sdk.__state.collections.places[0]._id
    await publish({
      placeId: placeId,
      media: [{ fileID: 'cloud://v.mp4', type: 'video', duration: 10 }],
      rating: 5
    })
    expect(sdk.__state.collections.places[0].coverFileID).toBe('cloud://r1.jpg')
  })

  test('补记的旧时间记录不覆盖更新的封面（封面=最新有图记录首图，spec 4.4）', async () => {
    await publish() // 今天的记录，封面 r1.jpg
    const placeId = sdk.__state.collections.places[0]._id
    await publish({
      placeId: placeId,
      media: [{ fileID: 'cloud://old.jpg', type: 'image' }],
      rating: 3,
      happenedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString() // 补记昨天
    })
    expect(sdk.__state.collections.places[0].coverFileID).toBe('cloud://r1.jpg')
  })

  test('非 active 成员 / 不在圈：NOT_IN_CIRCLE', async () => {
    sdk.__reset(seed({ collections: {
      circles: [], members: [{ _id: 'm-a', openid: 'openid-a', status: 'left' }]
    } }))
    const result = await publishRecord.main({ media: mediaOk, rating: 4, newPlace: newPlace() })
    expect(result.code).toBe('NOT_IN_CIRCLE')
  })

  describe('媒体约束（服务端复核，spec 4.5）', () => {
    const cases = [
      ['图片超过 9 张', Array.from({ length: 10 }, (_, i) => ({ fileID: `cloud://i${i}.jpg`, type: 'image' }))],
      ['视频超过 3 段', Array.from({ length: 4 }, (_, i) => ({ fileID: `cloud://v${i}.mp4`, type: 'video', duration: 10 }))],
      ['单段视频超 60s', [
        ...Array.from({ length: 8 }, (_, i) => ({ fileID: `cloud://i${i}.jpg`, type: 'image' })),
        { fileID: 'cloud://v.mp4', type: 'video', duration: 61 }
      ]],
      ['合计超过 12 个', [
        ...Array.from({ length: 9 }, (_, i) => ({ fileID: `cloud://i${i}.jpg`, type: 'image' })),
        ...Array.from({ length: 4 }, (_, i) => ({ fileID: `cloud://v${i}.mp4`, type: 'video', duration: 10 }))
      ]],
      ['视频缺时长', [{ fileID: 'cloud://v.mp4', type: 'video' }]],
      ['media 含非法 type', [{ fileID: 'cloud://x', type: 'gif' }]],
      ['media 含空 fileID', [{ fileID: '', type: 'image' }]]
    ]
    test.each(cases)('%s：VALIDATION_FAILED 且不落库', async (_name, media) => {
      const result = await publish({ media })
      expect(result.code).toBe('VALIDATION_FAILED')
      expect(result.message).toBeTruthy()
      expect(sdk.__state.collections.records).toHaveLength(0)
      expect(sdk.__state.collections.places).toHaveLength(0)
    })

    test('media 可为空数组（未配媒体也可发布，原型允许）', async () => {
      const result = await publish({ media: [] })
      expect(result.code).toBeUndefined()
      expect(sdk.__state.collections.records).toHaveLength(1)
      expect(sdk.__state.collections.records[0].media).toEqual([])
      // 无图片不覆盖地点封面
      expect(sdk.__state.collections.places[0].coverFileID).toBeNull()
    })

    test('media 非数组：VALIDATION_FAILED', async () => {
      const result = await publish({ media: undefined })
      expect(result.code).toBe('VALIDATION_FAILED')
    })
  })

  test.each([
    ['文字超过 500 字', { text: '哈'.repeat(501) }],
    ['星级为 0', { rating: 0 }],
    ['星级为 6', { rating: 6 }],
    ['星级非整数', { rating: 4.5 }],
    ['星级缺失', { rating: undefined }]
  ])('%s：VALIDATION_FAILED', async (_name, event) => {
    const result = await publish(event)
    expect(result.code).toBe('VALIDATION_FAILED')
  })

  test.each([
    ['既无 placeId 也无 newPlace', { placeId: undefined, newPlace: undefined }],
    ['newPlace 缺名称', { newPlace: newPlace({ name: '  ' }) }],
    ['newPlace 类型非法', { newPlace: newPlace({ type: 'park' }) }],
    ['newPlace 缺类型', { newPlace: newPlace({ type: undefined }) }],
    ['placeId 指向不存在的地点', { newPlace: undefined, placeId: 'no-such-place' }]
  ])('%s：VALIDATION_FAILED', async (_name, event) => {
    const result = await publish(event)
    expect(result.code).toBe('VALIDATION_FAILED')
  })

  describe('可见范围三档（T18，spec 4.5/4.6）', () => {
    test('默认 family：pairIds 不落', async () => {
      await publish()
      const record = sdk.__state.collections.records[0]
      expect(record.visibility).toBe('family')
      expect(record.pairIds).toBeUndefined()
    })

    test('private：仅自己可见档正常落库，pairIds 不落', async () => {
      const result = await publish({ visibility: 'private' })
      expect(result.code).toBeUndefined()
      const record = sdk.__state.collections.records[0]
      expect(record.visibility).toBe('private')
      expect(record.pairIds).toBeUndefined()
    })

    test('pair：固化 circles.pairIds 创建时快照', async () => {
      const result = await publish({ visibility: 'pair' })
      expect(result.code).toBeUndefined()
      const record = sdk.__state.collections.records[0]
      expect(record.visibility).toBe('pair')
      expect(record.pairIds).toEqual(['openid-a', 'openid-b']) // 快照值，非引用
    })

    test('pair 但圈主未指定另一半：VALIDATION_FAILED 且不落库', async () => {
      sdk.__reset(seed({ collections: {
        circles: [{ ownerId: 'openid-a', pairIds: [], createdAt: new Date() }],
        members: [{ _id: 'm-a', ...me }],
        places: [],
        records: []
      } }))
      needReset = false
      const result = await publishRecord.main({
        media: mediaOk, rating: 4, newPlace: newPlace(), visibility: 'pair'
      })
      expect(result.code).toBe('VALIDATION_FAILED')
      expect(sdk.__state.collections.records).toHaveLength(0)
    })

    test.each([
      ['visibility 非法值', { visibility: 'friends' }],
      ['visibility 非字符串', { visibility: 1 }]
    ])('%s：VALIDATION_FAILED', async (_name, event) => {
      const result = await publish(event)
      expect(result.code).toBe('VALIDATION_FAILED')
      expect(sdk.__state.collections.records).toHaveLength(0)
    })

    test('非二人组成员发 pair：VALIDATION_FAILED（否则作者自己都看不见）', async () => {
      const seeded = seed()
      seeded.collections.members.push(
        { _id: 'm-c', openid: 'openid-c', nickname: '妈妈', status: 'active' }
      )
      sdk.__reset({ ...seeded, openid: 'openid-c' })
      needReset = false
      const result = await publishRecord.main({
        media: mediaOk, rating: 4, newPlace: newPlace(), visibility: 'pair'
      })
      expect(result.code).toBe('VALIDATION_FAILED')
      expect(sdk.__state.collections.records).toHaveLength(0)
    })
  })

  describe('参与者多选（T18，spec 4.5）', () => {
    test('多选 active 成员：原样落库', async () => {
      // 补一个成员凑多人（push 要在 publish 内部的 reset 之后，故手动播种）
      sdk.__reset(seed())
      sdk.__state.collections.members.push(
        { _id: 'm-c', openid: 'openid-c', nickname: '妈妈', status: 'active' }
      )
      needReset = false
      const result = await publishRecord.main({
        media: mediaOk, text: '还行', rating: 4, newPlace: newPlace(),
        participantIds: ['openid-b', 'openid-c']
      })
      expect(result.code).toBeUndefined()
      expect(sdk.__state.collections.records[0].participantIds).toEqual(['openid-b', 'openid-c'])
    })

    test('可跳过（不传为空数组）', async () => {
      const result = await publish()
      expect(result.code).toBeUndefined()
      expect(sdk.__state.collections.records[0].participantIds).toEqual([])
    })

    test.each([
      ['含非成员 openid', { participantIds: ['openid-b', 'no-such'] }],
      ['含已移除成员', { participantIds: ['openid-x'] }],
      ['含作者自己（作者隐含，不需重复）', { participantIds: ['openid-a'] }],
      ['非数组', { participantIds: 'openid-b' }]
    ])('%s：VALIDATION_FAILED 且不落库', async (_name, event) => {
      const result = await publish(event)
      expect(result.code).toBe('VALIDATION_FAILED')
      expect(sdk.__state.collections.records).toHaveLength(0)
    })
  })

  describe('补记时间（T18，spec 4.5 happenedAt）', () => {
    test('不传默认现在', async () => {
      const before = Date.now()
      await publish()
      const record = sdk.__state.collections.records[0]
      expect(record.happenedAt).toBeInstanceOf(Date)
      expect(record.happenedAt.getTime()).toBeGreaterThanOrEqual(before)
    })

    test('补记昨天：happenedAt 落传入值（ISO 字符串也接受）', async () => {
      const yesterday = new Date(Date.now() - 24 * 3600 * 1000)
      const result = await publish({ happenedAt: yesterday.toISOString() })
      expect(result.code).toBeUndefined()
      const record = sdk.__state.collections.records[0]
      expect(record.happenedAt).toBeInstanceOf(Date)
      expect(record.happenedAt.getTime()).toBe(yesterday.getTime())
    })

    test.each([
      ['未来时间', { happenedAt: new Date(Date.now() + 3600 * 1000).toISOString() }],
      ['非法日期字符串', { happenedAt: 'not-a-date' }],
      ['非字符串非数字', { happenedAt: { foo: 1 } }]
    ])('%s：VALIDATION_FAILED', async (_name, event) => {
      const result = await publish(event)
      expect(result.code).toBe('VALIDATION_FAILED')
    })
  })
})
