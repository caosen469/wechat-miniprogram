// T18：updateRecord / deleteRecord（spec 5.1）——能看见就能编辑/删除（spec 4.6 过滤）。
// updateRecord：visibility 改 pair 时以「改动时」的 circles.pairIds 重固化快照；
// deleteRecord：删文档 + cloud.deleteFile 删媒体（含音频）+ 刷新地点封面。
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const updateRecord = require('../cloudfunctions/updateRecord/index')
const deleteRecord = require('../cloudfunctions/deleteRecord/index')

const members = [
  { _id: 'm-a', openid: 'openid-a', nickname: '我', role: 'owner', status: 'active' },
  { _id: 'm-b', openid: 'openid-b', nickname: '女友', role: 'member', status: 'active' },
  { _id: 'm-c', openid: 'openid-c', nickname: '妈妈', role: 'member', status: 'active' },
  { _id: 'm-x', openid: 'openid-x', nickname: '旧搭档', role: 'member', status: 'removed' }
]

function seedRecord (id, over = {}) {
  return {
    _id: id,
    placeId: 'p-1',
    authorId: 'openid-b',
    participantIds: [],
    media: [{ fileID: `cloud://${id}-1.jpg`, type: 'image' }],
    text: '原文',
    audio: null,
    rating: 3,
    visibility: 'family',
    happenedAt: new Date('2026-08-10T12:00:00+08:00'),
    collectionId: null,
    createdAt: new Date('2026-08-10T12:00:00+08:00'),
    updatedAt: new Date('2026-08-10T12:00:00+08:00'),
    ...over
  }
}

function reset (openid = 'openid-a', { records = [seedRecord('r-1')] } = {}) {
  sdk.__reset({
    openid,
    collections: {
      circles: [{ ownerId: 'openid-a', pairIds: ['openid-a', 'openid-b'], createdAt: new Date() }],
      members: members.map(m => ({ ...m })),
      places: [{
        _id: 'p-1', poiId: 'POI-1', name: '外婆家', type: 'restaurant',
        location: null, coverFileID: 'cloud://r-1-1.jpg', createdBy: 'openid-a', createdAt: new Date()
      }],
      records: records.map(r => ({ ...r }))
    }
  })
}

const getRecord = () => sdk.__state.collections.records.find(r => r._id === 'r-1')

describe('updateRecord（能看见就能编辑）', () => {
  test('改别人的 family 记录（文字/星级/可见范围）：保存成功且 updatedAt 刷新', async () => {
    reset('openid-a')
    const result = await updateRecord.main({
      recordId: 'r-1', text: '帮她改的', rating: 5, visibility: 'private'
    })
    expect(result.code).toBeUndefined()
    const record = getRecord()
    expect(record.text).toBe('帮她改的')
    expect(record.rating).toBe(5)
    expect(record.visibility).toBe('private')
    expect(record.updatedAt.getTime()).toBeGreaterThan(record.createdAt.getTime())
  })

  test('pair 记录的搭档能编辑（看得见就能编辑）', async () => {
    reset('openid-a', { records: [seedRecord('r-1', {
      visibility: 'pair', pairIds: ['openid-a', 'openid-b']
    })] })
    const result = await updateRecord.main({ recordId: 'r-1', text: '改' })
    expect(result.code).toBeUndefined()
    expect(getRecord().text).toBe('改')
  })

  test('看不见的记录：NOT_VISIBLE（别人的 private）', async () => {
    reset('openid-a', { records: [seedRecord('r-1', { visibility: 'private' })] })
    const result = await updateRecord.main({ recordId: 'r-1', text: '偷改' })
    expect(result.code).toBe('NOT_VISIBLE')
    expect(getRecord().text).toBe('原文')
  })

  test('旧 pair 快照：新搭档看不到也改不了', async () => {
    reset('openid-b', { records: [seedRecord('r-1', {
      visibility: 'pair', pairIds: ['openid-a', 'openid-x']
    })] })
    const result = await updateRecord.main({ recordId: 'r-1', text: '偷改' })
    expect(result.code).toBe('NOT_VISIBLE')
  })

  test('非 active 成员：NOT_IN_CIRCLE', async () => {
    reset('openid-x')
    const result = await updateRecord.main({ recordId: 'r-1', text: '改' })
    expect(result.code).toBe('NOT_IN_CIRCLE')
  })

  test('recordId 不存在：NOT_VISIBLE', async () => {
    reset('openid-a')
    const result = await updateRecord.main({ recordId: 'no-such', text: '改' })
    expect(result.code).toBe('NOT_VISIBLE')
  })

  test('可见范围改 pair：以改动时的 circles.pairIds 重固化快照', async () => {
    reset('openid-a')
    const result = await updateRecord.main({ recordId: 'r-1', visibility: 'pair' })
    expect(result.code).toBeUndefined()
    expect(getRecord().pairIds).toEqual(['openid-a', 'openid-b'])
  })

  test('可见范围从 pair 改走：pairIds 快照清除', async () => {
    reset('openid-a', { records: [seedRecord('r-1', {
      visibility: 'pair', pairIds: ['openid-a', 'openid-x']
    })] })
    const result = await updateRecord.main({ recordId: 'r-1', visibility: 'family' })
    expect(result.code).toBeUndefined()
    expect(getRecord().visibility).toBe('family')
    expect(getRecord().pairIds).toBeUndefined()
  })

  test('改 pair 但圈主未指定另一半：VALIDATION_FAILED 且原值不动', async () => {
    reset('openid-a')
    sdk.__state.collections.circles[0].pairIds = []
    const result = await updateRecord.main({ recordId: 'r-1', visibility: 'pair' })
    expect(result.code).toBe('VALIDATION_FAILED')
    expect(getRecord().visibility).toBe('family')
  })

  test('改参与者：须为 active 成员且不含作者', async () => {
    reset('openid-a')
    const result = await updateRecord.main({ recordId: 'r-1', participantIds: ['openid-a', 'openid-c'] })
    expect(result.code).toBeUndefined()
    expect(getRecord().participantIds).toEqual(['openid-a', 'openid-c'])
    // 作者是 openid-b，这里 openid-a 是参与者，合法
  })

  test('改参与者含已移除成员：VALIDATION_FAILED', async () => {
    reset('openid-a')
    const result = await updateRecord.main({ recordId: 'r-1', participantIds: ['openid-x'] })
    expect(result.code).toBe('VALIDATION_FAILED')
    expect(getRecord().participantIds).toEqual([])
  })

  test('改补记时间：happenedAt 更新且拒绝未来', async () => {
    reset('openid-a')
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000)
    const ok = await updateRecord.main({ recordId: 'r-1', happenedAt: yesterday.toISOString() })
    expect(ok.code).toBeUndefined()
    expect(getRecord().happenedAt.getTime()).toBe(yesterday.getTime())

    const future = new Date(Date.now() + 24 * 3600 * 1000)
    const bad = await updateRecord.main({ recordId: 'r-1', happenedAt: future.toISOString() })
    expect(bad.code).toBe('VALIDATION_FAILED')
    expect(getRecord().happenedAt.getTime()).toBe(yesterday.getTime())
  })

  test.each([
    ['文字超 500 字', { text: '哈'.repeat(501) }],
    ['星级为 6', { rating: 6 }],
    ['可见范围非法', { visibility: 'friends' }]
  ])('%s：VALIDATION_FAILED 且不落库', async (_name, patch) => {
    reset('openid-a')
    const result = await updateRecord.main({ recordId: 'r-1', ...patch })
    expect(result.code).toBe('VALIDATION_FAILED')
    const record = getRecord()
    expect(record.text).toBe('原文')
    expect(record.rating).toBe(3)
    expect(record.visibility).toBe('family')
  })

  test('改媒体：新约束复核通过才落库', async () => {
    reset('openid-a')
    const result = await updateRecord.main({
      recordId: 'r-1',
      media: [{ fileID: 'cloud://new.jpg', type: 'image' }]
    })
    expect(result.code).toBeUndefined()
    expect(getRecord().media).toEqual([{ fileID: 'cloud://new.jpg', type: 'image' }])
  })

  test('改媒体：地点封面随最新有图记录刷新，被替换的旧文件从云存储删除', async () => {
    reset('openid-a')
    const result = await updateRecord.main({
      recordId: 'r-1',
      media: [{ fileID: 'cloud://new.jpg', type: 'image' }]
    })
    expect(result.code).toBeUndefined()
    // r-1 是该地点唯一（最新）记录，封面跟到新首图
    expect(sdk.__state.collections.places[0].coverFileID).toBe('cloud://new.jpg')
    // 旧首图不再被引用，一并删除（否则成孤儿文件）
    expect(sdk.__state.deletedFiles).toEqual(['cloud://r-1-1.jpg'])
  })

  test('非二人组成员把记录改成 pair：VALIDATION_FAILED（不能把自己锁在记录外）', async () => {
    reset('openid-c')
    const result = await updateRecord.main({ recordId: 'r-1', visibility: 'pair' })
    expect(result.code).toBe('VALIDATION_FAILED')
    expect(getRecord().visibility).toBe('family')
  })
})

describe('deleteRecord（能看见就能删除 + 媒体文件清理）', () => {
  test('删别人的 family 记录：文档删除、媒体文件从云存储删除', async () => {
    reset('openid-a')
    const result = await deleteRecord.main({ recordId: 'r-1' })
    expect(result.code).toBeUndefined()
    expect(sdk.__state.collections.records).toHaveLength(0)
    expect(sdk.__state.deletedFiles).toEqual(['cloud://r-1-1.jpg'])
  })

  test('含音频与多图：全部 fileID 一并删除', async () => {
    reset('openid-a', { records: [seedRecord('r-1', {
      media: [
        { fileID: 'cloud://a1.jpg', type: 'image' },
        { fileID: 'cloud://a2.jpg', type: 'image' },
        { fileID: 'cloud://v.mp4', type: 'video', duration: 10 }
      ],
      audio: { fileID: 'cloud://voice.mp3', duration: 20 }
    })] })
    const result = await deleteRecord.main({ recordId: 'r-1' })
    expect(result.code).toBeUndefined()
    expect(sdk.__state.deletedFiles.sort()).toEqual(
      ['cloud://a1.jpg', 'cloud://a2.jpg', 'cloud://v.mp4', 'cloud://voice.mp3'].sort()
    )
  })

  test('删后刷新地点封面：回落到剩余记录的首图（真机反馈：还有剩余打卡就不删地点）', async () => {
    reset('openid-a', { records: [
      seedRecord('r-1', { happenedAt: new Date('2026-08-12T12:00:00+08:00') }),
      seedRecord('r-2', {
        media: [{ fileID: 'cloud://r2-1.jpg', type: 'image' }],
        happenedAt: new Date('2026-08-11T12:00:00+08:00')
      })
    ] })
    const result = await deleteRecord.main({ recordId: 'r-1' })
    expect(result.code).toBeUndefined()
    // 剩余 r-2：地点保留，封面跟到剩余最新有图记录
    expect(sdk.__state.collections.places).toHaveLength(1)
    expect(sdk.__state.collections.places[0].coverFileID).toBe('cloud://r2-1.jpg')

    // 再删最后一条：地点已无任何记录，places 文档一并删除
    const last = await deleteRecord.main({ recordId: 'r-2' })
    expect(last.code).toBeUndefined()
    expect(sdk.__state.collections.places).toHaveLength(0)
  })

  test('删最新的无图记录：封面保留自更早的有图记录（不被清掉）', async () => {
    reset('openid-a', { records: [
      // A 今天、无图；C 前天、有图 c.jpg（封面的实际来源）
      seedRecord('r-a', { media: [{ fileID: 'cloud://v.mp4', type: 'video', duration: 10 }], happenedAt: new Date('2026-08-14T12:00:00+08:00') }),
      seedRecord('r-c', { media: [{ fileID: 'cloud://c.jpg', type: 'image' }], happenedAt: new Date('2026-08-12T12:00:00+08:00') })
    ] })
    expect(sdk.__state.collections.places[0].coverFileID).toBe('cloud://r-1-1.jpg') // seed 初始封面
    const result = await deleteRecord.main({ recordId: 'r-a' })
    expect(result.code).toBeUndefined()
    // 剩余最新有图记录是 r-c：封面指向 c.jpg，而不是清空
    expect(sdk.__state.collections.places[0].coverFileID).toBe('cloud://c.jpg')
  })

  test('删 pair 记录（自己是快照成员）：允许', async () => {
    reset('openid-a', { records: [seedRecord('r-1', {
      visibility: 'pair', pairIds: ['openid-a', 'openid-b']
    })] })
    const result = await deleteRecord.main({ recordId: 'r-1' })
    expect(result.code).toBeUndefined()
  })

  test('看不见的记录：NOT_VISIBLE 且文档不动', async () => {
    reset('openid-a', { records: [seedRecord('r-1', { visibility: 'private' })] })
    const result = await deleteRecord.main({ recordId: 'r-1' })
    expect(result.code).toBe('NOT_VISIBLE')
    expect(sdk.__state.collections.records).toHaveLength(1)
    expect(sdk.__state.deletedFiles).toEqual([])
  })

  test('非 active 成员：NOT_IN_CIRCLE', async () => {
    reset('openid-x')
    const result = await deleteRecord.main({ recordId: 'r-1' })
    expect(result.code).toBe('NOT_IN_CIRCLE')
  })

  test('recordId 不存在：NOT_VISIBLE', async () => {
    reset('openid-a')
    const result = await deleteRecord.main({ recordId: 'no-such' })
    expect(result.code).toBe('NOT_VISIBLE')
  })
})
