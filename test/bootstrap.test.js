// T14：bootstrap 冷启动鉴权底座（spec 5.1、4.1/4.2 字段表、4.6 可见性过滤）
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

// mock 的数据状态在调用时才读取，require 一次即可跨用例复用
const bootstrap = require('../cloudfunctions/bootstrap/index')

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
    const now = new Date('2026-08-01T00:00:00Z')
    sdk.__reset({
      collections: {
        circles: [{ _id: 'c1', ownerId: 'openid-a', pairIds: [], createdAt: now }],
        members: [
          { _id: 'm1', openid: 'openid-a', nickname: '我', status: 'active', joinedAt: now, lastReadAt: now },
          { _id: 'm2', openid: 'openid-b', nickname: '她', status: 'active', joinedAt: now }
        ],
        records: []
      },
      counts: { records: 3 }
    })
    const result = await bootstrap.main()

    expect(result.me.openid).toBe('openid-a')
    expect(result.me.status).toBe('active')
    expect(result.circle._id).toBe('c1')
    expect(result.members).toHaveLength(2)
    expect(result.unreadCount).toBe(3)
  })

  test('无 lastReadAt：水位线回退到 joinedAt，仍有未读统计', async () => {
    const joinedAt = new Date('2026-07-01T00:00:00Z')
    sdk.__reset({
      collections: {
        circles: [{ _id: 'c1', ownerId: 'openid-a', pairIds: [], createdAt: joinedAt }],
        members: [{ _id: 'm1', openid: 'openid-a', nickname: '我', status: 'active', joinedAt }],
        records: []
      },
      counts: { records: 5 }
    })
    const result = await bootstrap.main()
    expect(result.unreadCount).toBe(5)
  })

  test('records 集合不存在（还没人发过记录）：unreadCount 为 0，不抛错', async () => {
    const joinedAt = new Date('2026-07-01T00:00:00Z')
    sdk.__reset({
      collections: {
        circles: [{ _id: 'c1', ownerId: 'openid-a', pairIds: [], createdAt: joinedAt }],
        members: [{ _id: 'm1', openid: 'openid-a', nickname: '我', status: 'active', joinedAt }]
      }
      // 无 records 集合
    })
    const result = await bootstrap.main()
    expect(result.unreadCount).toBe(0)
  })
})
