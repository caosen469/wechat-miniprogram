// T17：createInviteCode / revokeInviteCode 邀请码生成与作废（spec 5.1、4.3 字段表）
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const createInviteCode = require('../cloudfunctions/createInviteCode/index')
const revokeInviteCode = require('../cloudfunctions/revokeInviteCode/index')

// 圈主 + 圈子的标准开局（T14 建圈后的状态）
function seedOwner () {
  sdk.__reset({
    collections: {
      circles: [{ _id: 'circle-1', ownerId: 'openid-a', pairIds: [], createdAt: new Date() }],
      members: [{ _id: 'member-1', openid: 'openid-a', nickname: '圈主', role: 'owner', status: 'active' }],
      invite_codes: []
    }
  })
}

describe('createInviteCode（生成邀请码）', () => {
  beforeEach(() => seedOwner())

  test('圈主生成：返回 6 位码 + 24 小时有效期，字段符合 spec 4.3', async () => {
    const before = Date.now()
    const result = await createInviteCode.main({})

    expect(result.code).toBeUndefined()
    expect(result.inviteCode.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/) // 6 位且不含易混淆的 0/O/1/I
    expect(result.inviteCode.expiresAt.getTime() - before).toBeGreaterThanOrEqual(24 * 3600 * 1000 - 1000)

    const docs = sdk.__state.collections.invite_codes
    expect(docs).toHaveLength(1)
    expect(docs[0].code).toBe(result.inviteCode.code)
    expect(docs[0].revoked).toBe(false)
    expect(docs[0].createdBy).toBe('openid-a')
    expect(docs[0].createdAt).toBeInstanceOf(Date)
  })

  test('码可重复使用：不写入使用人、不随入圈变化（重复生成产生多个并存的有效码）', async () => {
    const r1 = await createInviteCode.main({})
    const r2 = await createInviteCode.main({})
    expect(sdk.__state.collections.invite_codes).toHaveLength(2)
    expect(r1.inviteCode.code).not.toBe(r2.inviteCode.code)
  })

  test('非圈主的普通成员：拒绝，返回 NOT_OWNER', async () => {
    sdk.__state.collections.members.push({
      _id: 'member-2', openid: 'openid-b', nickname: '女友', role: 'member', status: 'active'
    })
    sdk.__state.openid = 'openid-b'
    const result = await createInviteCode.main({})
    expect(result.code).toBe('NOT_OWNER')
    expect(sdk.__state.collections.invite_codes).toHaveLength(0)
  })

  test('不在圈（无 active 成员记录）：返回 NOT_IN_CIRCLE', async () => {
    sdk.__state.openid = 'openid-stranger'
    const result = await createInviteCode.main({})
    expect(result.code).toBe('NOT_IN_CIRCLE')
  })

  test('全新环境集合不存在：自动补建后正常生成', async () => {
    sdk.__reset({
      collections: {
        circles: [{ _id: 'circle-1', ownerId: 'openid-a', pairIds: [], createdAt: new Date() }],
        members: [{ _id: 'member-1', openid: 'openid-a', nickname: '圈主', role: 'owner', status: 'active' }]
      }
    })
    const result = await createInviteCode.main({})
    expect(result.inviteCode.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/) // 6 位且不含易混淆的 0/O/1/I
    expect(sdk.__state.collections.invite_codes).toHaveLength(1)
  })
})

describe('revokeInviteCode（作废邀请码）', () => {
  beforeEach(async () => {
    seedOwner()
  })

  test('圈主作废：该码 revoked 置 true', async () => {
    const created = await createInviteCode.main({})
    const result = await revokeInviteCode.main({ code: created.inviteCode.code })

    expect(result.code).toBeUndefined()
    const doc = sdk.__state.collections.invite_codes[0]
    expect(doc.revoked).toBe(true)
  })

  test('已过期的码也可作废（作废是状态标记，不依赖有效期）', async () => {
    sdk.__state.collections.invite_codes.push({
      _id: 'ic-1', code: 'ABC234', createdAt: new Date(Date.now() - 25 * 3600 * 1000),
      expiresAt: new Date(Date.now() - 3600 * 1000), revoked: false, createdBy: 'openid-a'
    })
    const result = await revokeInviteCode.main({ code: 'ABC234' })
    expect(result.code).toBeUndefined()
    expect(sdk.__state.collections.invite_codes[0].revoked).toBe(true)
  })

  test('码不存在：返回 INVITE_INVALID', async () => {
    const result = await revokeInviteCode.main({ code: 'NOPE00' })
    expect(result.code).toBe('INVITE_INVALID')
  })

  test('非圈主：返回 NOT_OWNER，不改库', async () => {
    sdk.__state.collections.invite_codes.push({
      _id: 'ic-1', code: 'ABC234', createdAt: new Date(),
      expiresAt: new Date(Date.now() + 3600 * 1000), revoked: false, createdBy: 'openid-a'
    })
    sdk.__state.collections.members.push({
      _id: 'member-2', openid: 'openid-b', nickname: '女友', role: 'member', status: 'active'
    })
    sdk.__state.openid = 'openid-b'
    const result = await revokeInviteCode.main({ code: 'ABC234' })
    expect(result.code).toBe('NOT_OWNER')
    expect(sdk.__state.collections.invite_codes[0].revoked).toBe(false)
  })
})
