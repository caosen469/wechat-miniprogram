// T14：bootstrap 冷启动鉴权底座（spec 5.1、4.1/4.2 字段表、4.6 可见性过滤）
// T21：unreadCount 改为全量拉取 + 公共 visibility 过滤（与 listFeed/listPlaces
// 同口径：spec 4.6 三档 + 4.2 退出成员不可见 + 非本人所发，测试用真实记录驱动
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

// mock 的数据状态在调用时才读取，require 一次即可跨用例复用
const bootstrap = require('../cloudfunctions/bootstrap/index')

const watermark = new Date('2026-08-10T00:00:00Z')
const after = new Date('2026-08-12T00:00:00Z') // 水位之后 = 未读
const before = new Date('2026-08-08T00:00:00Z') // 水位之前 = 已读

const me = {
  _id: 'm1', openid: 'openid-a', nickname: '我', status: 'active',
  joinedAt: before, lastReadAt: watermark
}
const partner = { _id: 'm2', openid: 'openid-b', nickname: '她', status: 'active', joinedAt: before }
const removed = { _id: 'm3', openid: 'openid-x', nickname: '旧人', status: 'removed', joinedAt: before }

// 简化记录：bootstrap 只关心 authorId / visibility / pairIds / createdAt
const record = (over = {}) => ({
  authorId: 'openid-b',
  visibility: 'family',
  pairIds: null,
  createdAt: after,
  ...over
})

// 播种一份「me 已 lastReadAt、搭档在圈、旧人被移除」的基础集合
const baseCollections = (records = []) => ({
  circles: [{ _id: 'c1', ownerId: 'openid-a', pairIds: ['openid-a', 'openid-b'], createdAt: before }],
  members: [{ ...me }, { ...partner }, { ...removed }],
  records
})

describe('bootstrap（冷启动）', () => {
  beforeEach(() => sdk.__reset())

  test('无任何集合（全新环境）：返回 { me: null }，不抛错', async () => {
    sdk.__reset({ collections: {} })
    const result = await bootstrap.main()
    expect(result).toEqual({ me: null })
  })

  test('调用者无成员记录：返回 { me: null }', async () => {
    sdk.__reset({
      collections: {
        members: [{ openid: 'openid-other', nickname: '别人', status: 'active' }]
      }
    })
    const result = await bootstrap.main()
    expect(result).toEqual({ me: null })
  })

  test('调用者已退出（status=left）：视为不在圈', async () => {
    sdk.__reset({
      collections: {
        members: [{ openid: 'openid-a', nickname: '我', status: 'left' }]
      }
    })
    const result = await bootstrap.main()
    expect(result).toEqual({ me: null })
  })

  test('active 成员：返回 me / circle / members / unreadCount', async () => {
    sdk.__reset({ collections: baseCollections([record()]) })
    const result = await bootstrap.main()

    expect(result.me.openid).toBe('openid-a')
    expect(result.me.status).toBe('active')
    expect(result.circle._id).toBe('c1')
    expect(result.members).toHaveLength(3) // 含被移除成员：设置页要显示状态（ADR 0002）
    expect(result.unreadCount).toBe(1)
  })

  describe('unreadCount（spec 4.2 水位公式 + 4.6 可见性 + 非本人）', () => {
    test('只统计 createdAt > 水位 且非本人所发的记录', async () => {
      sdk.__reset({ collections: baseCollections([
        record({ _id: 'r-new', createdAt: after }),            // 未读 ✓
        record({ _id: 'r-old', createdAt: before }),           // 水位前，已读
        record({ _id: 'r-mine', createdAt: after, authorId: 'openid-a' }) // 自己发的不给自己红点
      ]) })
      const result = await bootstrap.main()
      expect(result.unreadCount).toBe(1)
    })

    test('createdAt 恰等于水位：不算未读（严格 >）', async () => {
      sdk.__reset({ collections: baseCollections([record({ createdAt: watermark })]) })
      const result = await bootstrap.main()
      expect(result.unreadCount).toBe(0)
    })

    test('可见性过滤（spec 4.6 三档）：pair 仅 pairIds 内可见、private 仅本人可见', async () => {
      sdk.__reset({ collections: baseCollections([
        record({ _id: 'r-fam', visibility: 'family' }),                          // ✓
        record({ _id: 'r-pair-in', visibility: 'pair', pairIds: ['openid-a', 'openid-b'] }), // ✓
        record({ _id: 'r-pair-out', visibility: 'pair', pairIds: ['openid-b', 'openid-c'] }), // 不可见
        record({ _id: 'r-priv-other', visibility: 'private' })                    // 他人 private 不可见
      ]) })
      const result = await bootstrap.main()
      expect(result.unreadCount).toBe(2)
    })

    test('退出/被移除作者的新记录：不计入（spec 4.2，与 listFeed 同口径）', async () => {
      sdk.__reset({ collections: baseCollections([
        record({ _id: 'r-removed', authorId: 'openid-x' })
      ]) })
      const result = await bootstrap.main()
      expect(result.unreadCount).toBe(0)
    })

    test('无 lastReadAt：水位线回退到 joinedAt', async () => {
      sdk.__reset({
        collections: {
          circles: baseCollections().circles,
          members: [{ ...me, lastReadAt: undefined }, { ...partner }, { ...removed }],
          records: [record({ _id: 'r-since-join', createdAt: after })]
        }
      })
      const result = await bootstrap.main()
      expect(result.unreadCount).toBe(1)
    })

    test('records 集合不存在（还没人发过记录）：unreadCount 为 0，不抛错', async () => {
      const collections = baseCollections()
      delete collections.records
      sdk.__reset({ collections })
      const result = await bootstrap.main()
      expect(result.unreadCount).toBe(0)
    })
  })
})
