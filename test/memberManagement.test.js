// T17：leaveCircle / removeMember / updateProfile 成员管理与改资料（spec 5.1、4.2 字段表）
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const leaveCircle = require('../cloudfunctions/leaveCircle/index')
const removeMember = require('../cloudfunctions/removeMember/index')
const updateProfile = require('../cloudfunctions/updateProfile/index')

function seed () {
  sdk.__reset({
    collections: {
      circles: [{ _id: 'circle-1', ownerId: 'openid-a', pairIds: [], createdAt: new Date() }],
      members: [
        { _id: 'member-1', openid: 'openid-a', nickname: '圈主', avatarUrl: 'cloud://a.png', role: 'owner', status: 'active', joinedAt: new Date(), leftAt: null, lastReadAt: null },
        { _id: 'member-2', openid: 'openid-b', nickname: '女友', avatarUrl: 'cloud://b.png', role: 'member', status: 'active', joinedAt: new Date(), leftAt: null, lastReadAt: null }
      ]
    },
    openid: 'openid-b' // 默认以普通成员身份操作
  })
}

describe('leaveCircle（自退）', () => {
  beforeEach(() => seed())

  test('普通成员自退：status 置 left、leftAt 有值，文档保留不删除', async () => {
    const result = await leaveCircle.main({})
    expect(result.code).toBeUndefined()

    const me = sdk.__state.collections.members.find(m => m.openid === 'openid-b')
    expect(me.status).toBe('left')
    expect(me.leftAt).toBeInstanceOf(Date)
    // 文档保留（记录保留、不可见不可改，ADR 0002）
    expect(sdk.__state.collections.members).toHaveLength(2)
  })

  test('圈主不可退：拒绝，返回 VALIDATION_FAILED，status 不变', async () => {
    sdk.__state.openid = 'openid-a'
    const result = await leaveCircle.main({})
    expect(result.code).toBe('VALIDATION_FAILED')
    expect(result.message).toContain('圈主')
    expect(sdk.__state.collections.members[0].status).toBe('active')
  })

  test('不在圈（无 active 记录）：返回 NOT_IN_CIRCLE', async () => {
    sdk.__state.openid = 'openid-stranger'
    const result = await leaveCircle.main({})
    expect(result.code).toBe('NOT_IN_CIRCLE')
  })

  test('已退出的成员再退：返回 NOT_IN_CIRCLE（已无 active 记录）', async () => {
    await leaveCircle.main({})
    const result = await leaveCircle.main({})
    expect(result.code).toBe('NOT_IN_CIRCLE')
  })

  test('自退的是另一半：circles.pairIds 一并清空（真机反馈：移除后设置页不再显示旧搭档）', async () => {
    sdk.__state.collections.circles[0].pairIds = ['openid-a', 'openid-b']
    const result = await leaveCircle.main({})
    expect(result.code).toBeUndefined()
    expect(sdk.__state.collections.circles[0].pairIds).toEqual([])
  })

  test('自退的不是另一半：pairIds 不动', async () => {
    sdk.__state.collections.members.push(
      { _id: 'member-3', openid: 'openid-c', nickname: '妈妈', avatarUrl: '', role: 'member', status: 'active', joinedAt: new Date(), leftAt: null, lastReadAt: null }
    )
    sdk.__state.collections.circles[0].pairIds = ['openid-a', 'openid-c']
    sdk.__state.openid = 'openid-b'
    const result = await leaveCircle.main({})
    expect(result.code).toBeUndefined()
    expect(sdk.__state.collections.circles[0].pairIds).toEqual(['openid-a', 'openid-c'])
  })
})

describe('removeMember（圈主移除成员）', () => {
  beforeEach(() => seed())

  test('圈主移除普通成员：status 置 removed、leftAt 有值，文档保留', async () => {
    sdk.__state.openid = 'openid-a'
    const result = await removeMember.main({ memberId: 'member-2' })
    expect(result.code).toBeUndefined()

    const removed = sdk.__state.collections.members.find(m => m._id === 'member-2')
    expect(removed.status).toBe('removed')
    expect(removed.leftAt).toBeInstanceOf(Date)
    expect(sdk.__state.collections.members).toHaveLength(2)
  })

  test('移除的是另一半：circles.pairIds 一并清空（真机反馈：移除后设置页不再显示旧搭档）', async () => {
    sdk.__state.collections.circles[0].pairIds = ['openid-a', 'openid-b']
    sdk.__state.openid = 'openid-a'
    const result = await removeMember.main({ memberId: 'member-2' })
    expect(result.code).toBeUndefined()
    expect(sdk.__state.collections.circles[0].pairIds).toEqual([])
  })

  test('移除的不是另一半：pairIds 不动', async () => {
    sdk.__state.collections.members.push(
      { _id: 'member-3', openid: 'openid-c', nickname: '妈妈', avatarUrl: '', role: 'member', status: 'active', joinedAt: new Date(), leftAt: null, lastReadAt: null }
    )
    sdk.__state.collections.circles[0].pairIds = ['openid-a', 'openid-b']
    sdk.__state.openid = 'openid-a'
    const result = await removeMember.main({ memberId: 'member-3' })
    expect(result.code).toBeUndefined()
    expect(sdk.__state.collections.circles[0].pairIds).toEqual(['openid-a', 'openid-b'])
  })

  test('不可移除自己：返回 VALIDATION_FAILED', async () => {
    sdk.__state.openid = 'openid-a'
    const result = await removeMember.main({ memberId: 'member-1' })
    expect(result.code).toBe('VALIDATION_FAILED')
    expect(sdk.__state.collections.members[0].status).toBe('active')
  })

  test('非圈主调用：返回 NOT_OWNER', async () => {
    const result = await removeMember.main({ memberId: 'member-1' })
    expect(result.code).toBe('NOT_OWNER')
    expect(sdk.__state.collections.members[0].status).toBe('active')
  })

  test('目标成员不存在：返回 VALIDATION_FAILED', async () => {
    sdk.__state.openid = 'openid-a'
    const result = await removeMember.main({ memberId: 'no-such-id' })
    expect(result.code).toBe('VALIDATION_FAILED')
  })

  test('目标已非 active（重复移除）：返回 VALIDATION_FAILED，不重复改库', async () => {
    sdk.__state.openid = 'openid-a'
    sdk.__state.collections.members[1].status = 'removed'
    sdk.__state.collections.members[1].leftAt = new Date('2026-01-01')
    const result = await removeMember.main({ memberId: 'member-2' })
    expect(result.code).toBe('VALIDATION_FAILED')
    expect(sdk.__state.collections.members[1].leftAt.getTime()).toBe(new Date('2026-01-01').getTime())
  })
})

describe('updateProfile（改资料）', () => {
  beforeEach(() => seed())

  test('改昵称：只动昵称，其余字段不变', async () => {
    const result = await updateProfile.main({ nickname: '新昵称' })
    expect(result.code).toBeUndefined()

    const me = sdk.__state.collections.members.find(m => m.openid === 'openid-b')
    expect(me.nickname).toBe('新昵称')
    expect(me.avatarUrl).toBe('cloud://b.png')
    expect(me.status).toBe('active')
  })

  test('改头像：只动头像', async () => {
    const result = await updateProfile.main({ avatarFileID: 'cloud://new.png' })
    expect(result.code).toBeUndefined()
    const me = sdk.__state.collections.members.find(m => m.openid === 'openid-b')
    expect(me.nickname).toBe('女友')
    expect(me.avatarUrl).toBe('cloud://new.png')
  })

  test('什么都不传：返回 VALIDATION_FAILED（无字段可改）', async () => {
    const result = await updateProfile.main({})
    expect(result.code).toBe('VALIDATION_FAILED')
  })

  test('昵称超长：返回 VALIDATION_FAILED，不改库', async () => {
    const result = await updateProfile.main({ nickname: 'a'.repeat(31) })
    expect(result.code).toBe('VALIDATION_FAILED')
    expect(sdk.__state.collections.members[1].nickname).toBe('女友')
  })

  test('昵称传空串（想清空昵称）：返回 VALIDATION_FAILED', async () => {
    const result = await updateProfile.main({ nickname: '  ' })
    expect(result.code).toBe('VALIDATION_FAILED')
  })

  test('不在圈：返回 NOT_IN_CIRCLE', async () => {
    sdk.__state.openid = 'openid-stranger'
    const result = await updateProfile.main({ nickname: '路人' })
    expect(result.code).toBe('NOT_IN_CIRCLE')
  })
})
