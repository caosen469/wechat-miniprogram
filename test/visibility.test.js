// T18：4.6 节可见性过滤落到每一个读函数（listFeed / getRecord / getPlaceDetail）
// 请求者 R 可见当且仅当：R.status=='active' 且
//   visibility=='family' | (pair 且 R∈pairIds) | (private 且 R==authorId)
// pairIds 是创建时快照：圈主重指另一半后，新搭档看不到旧 pair 记录。
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const listFeed = require('../cloudfunctions/listFeed/index')
const getRecord = require('../cloudfunctions/getRecord/index')
const getPlaceDetail = require('../cloudfunctions/getPlaceDetail/index')

const day = 24 * 3600 * 1000
const now = new Date('2026-08-15T12:00:00+08:00').getTime()

const members = [
  { _id: 'm-a', openid: 'openid-a', nickname: '我', avatarUrl: 'cloud://a.png', role: 'owner', status: 'active' },
  { _id: 'm-b', openid: 'openid-b', nickname: '女友', avatarUrl: 'cloud://b.png', role: 'member', status: 'active' },
  { _id: 'm-c', openid: 'openid-c', nickname: '妈妈', avatarUrl: 'cloud://c.png', role: 'member', status: 'active' },
  // 旧搭档：已被移除，status 过滤生效于全部读路径
  { _id: 'm-x', openid: 'openid-x', nickname: '旧搭档', avatarUrl: 'cloud://x.png', role: 'member', status: 'removed' }
]

function record (id, over = {}) {
  return {
    _id: id,
    placeId: 'p-1',
    authorId: 'openid-b',
    participantIds: [],
    media: [],
    text: '',
    audio: null,
    rating: 4,
    visibility: 'family',
    happenedAt: new Date(now),
    collectionId: null,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ...over
  }
}

// 覆盖矩阵的固定记录集：
//   r-fam      family，女友发 → 所有人可见
//   r-pair     pair 快照 [a,b]（当前搭档）→ 仅 a/b 可见
//   r-pair-old pair 快照 [a,x]（旧搭档，已被移除）→ 仅 a 可见（b 看不到 = 重指语义）
//   r-priv     private，女友发 → 仅女友可见
const records = () => [
  record('r-fam', { authorId: 'openid-b', visibility: 'family', participantIds: ['openid-a', 'openid-c'] }),
  record('r-pair', { authorId: 'openid-b', visibility: 'pair', pairIds: ['openid-a', 'openid-b'] }),
  record('r-pair-old', { authorId: 'openid-a', visibility: 'pair', pairIds: ['openid-a', 'openid-x'] }),
  record('r-priv', { authorId: 'openid-b', visibility: 'private' })
]

function reset (openid = 'openid-a', { withRecords = true } = {}) {
  sdk.__reset({
    openid,
    collections: {
      circles: [{ ownerId: 'openid-a', pairIds: ['openid-a', 'openid-b'], createdAt: new Date() }],
      members: members.map(m => ({ ...m })),
      places: [{ _id: 'p-1', poiId: 'POI-1', name: '外婆家', type: 'restaurant', location: null, coverFileID: null, createdBy: 'openid-a', createdAt: new Date() }],
      records: withRecords ? records().map(r => ({ ...r })) : []
    }
  })
}

describe.each([
  ['listFeed', (event) => listFeed.main(event), (result) => result.records],
  ['getPlaceDetail', (event) => getPlaceDetail.main({ placeId: 'p-1', ...event }), (result) => result.place && result.records]
])('%s：可见性过滤（spec 4.6）', (name, call, pick) => {
  test('圈主 a：family + 两条 pair（含旧搭档快照），看不到女友的 private', async () => {
    reset('openid-a')
    const visible = pick(await call({})) || []
    expect(visible.map(r => r._id).sort()).toEqual(['r-fam', 'r-pair', 'r-pair-old'])
  })

  test('搭档 b：family + 当前 pair；看不到旧搭档 pair（重指语义）与别人的 private', async () => {
    reset('openid-b')
    const visible = pick(await call({})) || []
    expect(visible.map(r => r._id).sort()).toEqual(['r-fam', 'r-pair', 'r-priv'])
  })

  test('普通成员 c：只有 family', async () => {
    reset('openid-c')
    const visible = pick(await call({})) || []
    expect(visible.map(r => r._id)).toEqual(['r-fam'])
  })

  test('被移除成员 x：NOT_IN_CIRCLE（status 过滤）', async () => {
    reset('openid-x')
    const result = await call({})
    expect(result.code).toBe('NOT_IN_CIRCLE')
  })

  test('不在圈：NOT_IN_CIRCLE', async () => {
    reset('openid-stranger')
    const result = await call({})
    expect(result.code).toBe('NOT_IN_CIRCLE')
  })
})

describe('listFeed', () => {
  test('按 happenedAt 时间倒序（补记昨天排在今天之后）', async () => {
    reset('openid-a')
    sdk.__state.collections.records.push(
      record('r-backfill', { happenedAt: new Date(now - day), createdAt: new Date(now) })
    )
    const result = await listFeed.main({})
    // a 可见：r-fam / r-pair / r-pair-old + 补记（r-priv 是女友的仅自己档，看不到）
    expect(result.records).toHaveLength(4)
    // 整体按 happenedAt 倒序；补记（happenedAt 昨天且时间戳最小）必排最末
    const times = result.records.map(r => r.happenedAt.getTime())
    expect(times).toEqual([...times].sort((a, b) => b - a))
    expect(result.records[3]._id).toBe('r-backfill')
  })

  test('服务端 join 作者/参与者昵称头像，前端无二次请求（spec 5.1）', async () => {
    reset('openid-a')
    const result = await listFeed.main({})
    const fam = result.records.find(r => r._id === 'r-fam')
    expect(fam.author).toEqual({ openid: 'openid-b', nickname: '女友', avatarUrl: 'cloud://b.png' })
    expect(fam.participants.map(p => p.nickname)).toEqual(['我', '妈妈'])
    // 参与者含已移除成员时仍展示其昵称头像（记录保留，ADR 0002）
    const pairOld = result.records.find(r => r._id === 'r-pair-old')
    expect(pairOld.author.nickname).toBe('我')
  })

  test('placeId 过滤：只返回该地点的可见记录', async () => {
    reset('openid-a')
    sdk.__state.collections.records.push(
      record('r-other-place', { placeId: 'p-2' })
    )
    const result = await listFeed.main({ placeId: 'p-1' })
    expect(result.records.every(r => r.placeId === 'p-1')).toBe(true)
    expect(result.records.map(r => r._id)).not.toContain('r-other-place')
  })

  test('before 游标：只返回 happenedAt 早于游标的记录（翻页）', async () => {
    reset('openid-a')
    const cursor = new Date(now - 1000)
    const result = await listFeed.main({ before: cursor.toISOString() })
    // 播种记录 happenedAt 全等于 now，早于游标的没有
    expect(result.records).toEqual([])
    sdk.__state.collections.records.push(
      record('r-earlier', { happenedAt: new Date(now - 2 * day) })
    )
    const second = await listFeed.main({ before: cursor.toISOString() })
    expect(second.records.map(r => r._id)).toEqual(['r-earlier'])
  })

  test('before 游标与记录同分钟：不会被跳过（≤ 语义，前端按 _id 去重）', async () => {
    reset('openid-a')
    // 两条补记到同一分钟的记录
    const sameMinute = new Date(now - 3 * day)
    sdk.__state.collections.records.push(
      record('r-tie-1', { happenedAt: sameMinute }),
      record('r-tie-2', { happenedAt: sameMinute })
    )
    const result = await listFeed.main({ before: sameMinute.toISOString() })
    const ids = result.records.map(r => r._id)
    expect(ids).toContain('r-tie-1')
    expect(ids).toContain('r-tie-2')
  })
})

describe('getRecord', () => {
  test.each([
    ['family 记录普通成员可看', 'openid-c', 'r-fam', true],
    ['pair 记录搭档可看', 'openid-b', 'r-pair', true],
    ['pair 记录非搭档不可看', 'openid-c', 'r-pair', false],
    ['旧搭档快照新搭档不可看', 'openid-b', 'r-pair-old', false],
    ['private 仅作者可看', 'openid-b', 'r-priv', true],
    ['private 他人不可看', 'openid-a', 'r-priv', false]
  ])('%s：%s', async (_name, openid, recordId, ok) => {
    reset(openid)
    const result = await getRecord.main({ recordId })
    if (ok) {
      expect(result.code).toBeUndefined()
      expect(result.record._id).toBe(recordId)
      expect(result.record.author.nickname).toBeTruthy()
    } else {
      expect(result.code).toBe('NOT_VISIBLE')
    }
  })

  test('recordId 不存在：NOT_VISIBLE（前端静默处理）', async () => {
    reset('openid-a')
    const result = await getRecord.main({ recordId: 'no-such' })
    expect(result.code).toBe('NOT_VISIBLE')
  })

  test('非 active 成员：NOT_IN_CIRCLE', async () => {
    reset('openid-x')
    const result = await getRecord.main({ recordId: 'r-fam' })
    expect(result.code).toBe('NOT_IN_CIRCLE')
  })
})

describe('getPlaceDetail', () => {
  test('返回 {place, records}，records 可见性过滤且时间倒序', async () => {
    reset('openid-c')
    const result = await getPlaceDetail.main({ placeId: 'p-1' })
    expect(result.code).toBeUndefined()
    expect(result.place._id).toBe('p-1')
    expect(result.place.name).toBe('外婆家')
    expect(result.records.map(r => r._id)).toEqual(['r-fam'])
    expect(result.records[0].author.nickname).toBe('女友')
  })

  test('地点不存在：VALIDATION_FAILED', async () => {
    reset('openid-a')
    const result = await getPlaceDetail.main({ placeId: 'no-such' })
    expect(result.code).toBe('VALIDATION_FAILED')
  })

  test('非 active 成员：NOT_IN_CIRCLE', async () => {
    reset('openid-x')
    const result = await getPlaceDetail.main({ placeId: 'p-1' })
    expect(result.code).toBe('NOT_IN_CIRCLE')
  })
})
