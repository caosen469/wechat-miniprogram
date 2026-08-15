// T21：markRead 红点水位更新（spec 5.1、4.2、8.2）。
// 红点条展开后调用，把调用者的 lastReadAt 推进到当前时间。
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const markRead = require('../cloudfunctions/markRead/index')

const joinedAt = new Date('2026-07-01T00:00:00Z')

describe('markRead（红点水位）', () => {
  test('active 成员：lastReadAt 更新为当前时间（云函数侧时钟，不信任设备时间）', async () => {
    sdk.__reset({
      collections: {
        members: [{ _id: 'm1', openid: 'openid-a', nickname: '我', status: 'active', joinedAt, lastReadAt: joinedAt }]
      }
    })
    const result = await markRead.main()
    expect(result.lastReadAt instanceof Date).toBe(true) // 返回服务端时间供前端推进本地水位
    expect(result.lastReadAt.getTime()).toBeGreaterThan(joinedAt.getTime())
    const me = sdk.__state.collections.members[0]
    expect(me.lastReadAt).toBe(result.lastReadAt) // 落库与返回是同一时刻
  })

  test('只更新调用者本人，其他成员与其他字段不动', async () => {
    const partnerOld = { nickname: '搭档', status: 'active' }
    sdk.__reset({
      collections: {
        members: [
          { _id: 'm1', openid: 'openid-a', nickname: '我', status: 'active', joinedAt },
          { _id: 'm2', openid: 'openid-b', ...partnerOld, joinedAt, lastReadAt: joinedAt }
        ]
      }
    })
    await markRead.main()
    const [me, partner] = sdk.__state.collections.members
    expect(me.lastReadAt.getTime()).toBeGreaterThan(joinedAt.getTime())
    expect(me.nickname).toBe('我') // update 是字段合并不整体替换
    expect(partner.lastReadAt).toBe(joinedAt)
  })

  test('无 lastReadAt（首次已读）：从无到有写入水位', async () => {
    sdk.__reset({
      collections: {
        members: [{ _id: 'm1', openid: 'openid-a', status: 'active', joinedAt }]
      }
    })
    await markRead.main()
    expect(sdk.__state.collections.members[0].lastReadAt).toBeInstanceOf(Date)
  })

  test('已退出（status=left）：NOT_IN_CIRCLE', async () => {
    sdk.__reset({
      collections: {
        members: [{ _id: 'm1', openid: 'openid-a', status: 'left', joinedAt }]
      }
    })
    const result = await markRead.main()
    expect(result).toEqual({ code: 'NOT_IN_CIRCLE', message: expect.any(String) })
  })

  test('无成员记录：NOT_IN_CIRCLE', async () => {
    sdk.__reset({ collections: { members: [{ _id: 'm1', openid: 'openid-b', status: 'active', joinedAt }] } })
    const result = await markRead.main()
    expect(result).toEqual({ code: 'NOT_IN_CIRCLE', message: expect.any(String) })
  })

  test('members 集合尚不存在（全新环境）：NOT_IN_CIRCLE 不崩', async () => {
    sdk.__reset({ collections: {} })
    const result = await markRead.main()
    expect(result).toEqual({ code: 'NOT_IN_CIRCLE', message: expect.any(String) })
  })
})
