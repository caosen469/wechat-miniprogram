// T21：markRead 红点水位（spec 5.1、8.2、4.2）。
// 把当前成员 members.lastReadAt 更新为当前时间；不在圈（无 active 成员记录）→ NOT_IN_CIRCLE。
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const markRead = require('../cloudfunctions/markRead/index')

const members = [
  { _id: 'm-a', openid: 'openid-a', nickname: '小曹', status: 'active', joinedAt: new Date('2026-07-01T00:00:00Z') },
  { _id: 'm-b', openid: 'openid-b', nickname: '小美', status: 'active', joinedAt: new Date('2026-07-01T00:00:00Z') },
  { _id: 'm-c', openid: 'openid-c', nickname: '旧人', status: 'left', joinedAt: new Date('2026-07-01T00:00:00Z') }
]

const seed = (over = {}) => ({
  collections: { members, ...over }
})

describe('markRead（红点水位）', () => {
  test('不在圈（无该 openid 的 active 成员记录）：NOT_IN_CIRCLE', async () => {
    sdk.__reset(seed())
    sdk.__reset({ ...seed(), openid: 'openid-x' })
    const result = await markRead.main()
    expect(result).toEqual({ code: 'NOT_IN_CIRCLE', message: expect.any(String) })
  })

  test('已退出成员：NOT_IN_CIRCLE', async () => {
    sdk.__reset({ ...seed(), openid: 'openid-c' })
    const result = await markRead.main()
    expect(result).toEqual({ code: 'NOT_IN_CIRCLE', message: expect.any(String) })
  })

  test('无 lastReadAt：写入当前时间水位', async () => {
    sdk.__reset(seed())
    const before = Date.now()
    const result = await markRead.main()
    expect(result).toEqual({ ok: true })
    const me = sdk.__state.collections.members.find(m => m.openid === 'openid-a')
    expect(me.lastReadAt).toBeInstanceOf(Date)
    expect(me.lastReadAt.getTime()).toBeGreaterThanOrEqual(before)
  })

  test('已有 lastReadAt：水位被推进到更晚', async () => {
    const oldWatermark = new Date('2026-07-10T00:00:00Z')
    sdk.__reset(seed({
      members: [
        { ...members[0], lastReadAt: oldWatermark },
        members[1],
        members[2]
      ]
    }))
    const result = await markRead.main()
    expect(result).toEqual({ ok: true })
    const me = sdk.__state.collections.members.find(m => m.openid === 'openid-a')
    expect(me.lastReadAt.getTime()).toBeGreaterThan(oldWatermark.getTime())
  })

  test('只更新调用者自己的水位，不影响其他成员', async () => {
    const herWatermark = new Date('2026-07-10T00:00:00Z')
    sdk.__reset(seed({
      members: [
        members[0],
        { ...members[1], lastReadAt: herWatermark },
        members[2]
      ]
    }))
    await markRead.main()
    const me = sdk.__state.collections.members.find(m => m.openid === 'openid-a')
    const her = sdk.__state.collections.members.find(m => m.openid === 'openid-b')
    expect(me.lastReadAt).toBeInstanceOf(Date)
    expect(her.lastReadAt).toEqual(herWatermark)
  })

  test('members 集合尚不存在：按不在圈处理，不抛错', async () => {
    sdk.__reset({ collections: {} })
    const result = await markRead.main()
    expect(result).toEqual({ code: 'NOT_IN_CIRCLE', message: expect.any(String) })
  })
})
