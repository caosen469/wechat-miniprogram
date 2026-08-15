// T17：joinCircle 凭码入圈（spec 5.1、4.2 字段表）
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const joinCircle = require('../cloudfunctions/joinCircle/index')

const HOUR = 3600 * 1000

// 圈主已建圈、已生成一张有效邀请码 ABC234 的标准开局
function seed ({ code = 'ABC234', expiresAt = new Date(Date.now() + HOUR), revoked = false, activeCount = 1 } = {}) {
  const members = [
    { _id: 'member-1', openid: 'openid-a', nickname: '圈主', role: 'owner', status: 'active' }
  ]
  for (let i = 1; i < activeCount; i++) {
    members.push({ _id: `member-${i + 1}`, openid: `openid-filler-${i}`, nickname: `成员${i}`, role: 'member', status: 'active' })
  }
  sdk.__reset({
    collections: {
      circles: [{ _id: 'circle-1', ownerId: 'openid-a', pairIds: [], createdAt: new Date() }],
      members,
      invite_codes: [{
        _id: 'ic-1', code, createdAt: new Date(Date.now() - HOUR),
        expiresAt, revoked, createdBy: 'openid-a'
      }]
    },
    openid: 'openid-b' // 女友（无圈用户）凭码入圈
  })
}

describe('joinCircle（凭码入圈）', () => {
  test('凭有效码入圈：创建 role=member/status=active 成员文档，字段符合 spec 4.2', async () => {
    seed()
    const result = await joinCircle.main({ code: 'ABC234', nickname: '女友', avatarFileID: 'cloud://y.png' })

    expect(result.code).toBeUndefined()
    expect(result.member.openid).toBe('openid-b')
    expect(result.member.nickname).toBe('女友')
    expect(result.member.avatarUrl).toBe('cloud://y.png')
    expect(result.member.role).toBe('member')
    expect(result.member.status).toBe('active')
    expect(result.member.joinedAt).toBeInstanceOf(Date)
    expect(result.member.lastReadAt).toBeNull()

    expect(sdk.__state.collections.members).toHaveLength(2)
  })

  test('码不存在：返回 INVITE_INVALID', async () => {
    seed()
    const result = await joinCircle.main({ code: 'ZZZZ99', nickname: '女友', avatarFileID: 'cloud://y.png' })
    expect(result.code).toBe('INVITE_INVALID')
  })

  test('码已过期：返回 INVITE_INVALID', async () => {
    seed({ expiresAt: new Date(Date.now() - HOUR) })
    const result = await joinCircle.main({ code: 'ABC234', nickname: '女友', avatarFileID: 'cloud://y.png' })
    expect(result.code).toBe('INVITE_INVALID')
  })

  test('码已作废：返回 INVITE_INVALID', async () => {
    seed({ revoked: true })
    const result = await joinCircle.main({ code: 'ABC234', nickname: '女友', avatarFileID: 'cloud://y.png' })
    expect(result.code).toBe('INVITE_INVALID')
  })

  test('码可重复使用：第二人凭同一码也能入圈', async () => {
    seed({ activeCount: 2 })
    const r1 = await joinCircle.main({ code: 'ABC234', nickname: '女友', avatarFileID: 'cloud://y.png' })
    sdk.__state.openid = 'openid-c'
    const r2 = await joinCircle.main({ code: 'ABC234', nickname: '妈妈', avatarFileID: 'cloud://m.png' })
    expect(r1.code).toBeUndefined()
    expect(r2.code).toBeUndefined()
    expect(sdk.__state.collections.members).toHaveLength(4)
  })

  test('active 成员达 12 人：返回 CIRCLE_FULL', async () => {
    seed({ activeCount: 12 })
    const result = await joinCircle.main({ code: 'ABC234', nickname: '女友', avatarFileID: 'cloud://y.png' })
    expect(result.code).toBe('CIRCLE_FULL')
    expect(sdk.__state.collections.members).toHaveLength(12)
  })

  test('调用者已是 active 成员：返回 ALREADY_IN_CIRCLE', async () => {
    seed()
    sdk.__state.openid = 'openid-a'
    const result = await joinCircle.main({ code: 'ABC234', nickname: '圈主', avatarFileID: 'cloud://y.png' })
    expect(result.code).toBe('ALREADY_IN_CIRCLE')
  })

  test('曾退出/被移除的成员凭新码再次入圈：重新激活原成员文档，而非新建', async () => {
    seed()
    sdk.__state.collections.members.push({
      _id: 'member-old', openid: 'openid-b', nickname: '旧昵称', role: 'member',
      status: 'left', joinedAt: new Date(), leftAt: new Date(), lastReadAt: null
    })
    const result = await joinCircle.main({ code: 'ABC234', nickname: '新昵称', avatarFileID: 'cloud://new.png' })

    expect(result.code).toBeUndefined()
    expect(result.member._id).toBe('member-old')
    expect(result.member.status).toBe('active')
    expect(result.member.nickname).toBe('新昵称')
    expect(result.member.avatarUrl).toBe('cloud://new.png')
    expect(result.member.leftAt).toBeNull()
    // openid 唯一索引：库里不能出现两条 openid-b
    expect(sdk.__state.collections.members.filter(m => m.openid === 'openid-b')).toHaveLength(1)
  })

  test('昵称缺失或超长：返回 VALIDATION_FAILED', async () => {
    seed()
    expect((await joinCircle.main({ code: 'ABC234', nickname: ' ', avatarFileID: 'cloud://y.png' })).code).toBe('VALIDATION_FAILED')
    expect((await joinCircle.main({ code: 'ABC234', nickname: 'a'.repeat(31), avatarFileID: 'cloud://y.png' })).code).toBe('VALIDATION_FAILED')
  })

  test('头像缺失：返回 VALIDATION_FAILED', async () => {
    seed()
    const result = await joinCircle.main({ code: 'ABC234', nickname: '女友' })
    expect(result.code).toBe('VALIDATION_FAILED')
  })
})
