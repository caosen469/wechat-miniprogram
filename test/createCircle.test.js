// T14：createCircle 建圈（spec 5.1、4.1/4.2 字段表）
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

// mock 的数据状态在调用时才读取，require 一次即可跨用例复用
const createCircle = require('../cloudfunctions/createCircle/index')

describe('createCircle（建圈）', () => {
  beforeEach(() => {
    sdk.__reset()
  })

  test('全新环境：创建圈 + 圈主成员文档，字段符合 spec 4.1/4.2', async () => {
    const result = await createCircle.main({ nickname: '圈主', avatarFileID: 'cloud://xxx.png' })

    expect(result.code).toBeUndefined()
    expect(result.circle.ownerId).toBe('openid-a')
    expect(result.circle.pairIds).toEqual([])
    expect(result.circle.createdAt).toBeInstanceOf(Date)

    expect(result.member.openid).toBe('openid-a')
    expect(result.member.nickname).toBe('圈主')
    expect(result.member.avatarUrl).toBe('cloud://xxx.png')
    expect(result.member.role).toBe('owner')
    expect(result.member.status).toBe('active')
    expect(result.member.joinedAt).toBeInstanceOf(Date)
    expect(result.member.leftAt).toBeNull()
    expect(result.member.lastReadAt).toBeNull()

    // 落库校验
    const circles = sdk.__state.collections.circles
    const members = sdk.__state.collections.members
    expect(circles).toHaveLength(1)
    expect(members).toHaveLength(1)
    expect(members[0].role).toBe('owner')
  })

  test('全库已有圈子：拒绝，返回 CIRCLE_EXISTS', async () => {
    sdk.__reset({
      collections: {
        circles: [{ ownerId: 'openid-other', pairIds: [], createdAt: new Date() }],
        members: []
      }
    })
    const result = await createCircle.main({ nickname: '后来者', avatarFileID: 'cloud://xxx.png' })
    expect(result.code).toBe('CIRCLE_EXISTS')
    expect(result.message).toBeTruthy()
  })

  test('调用者已是 active 成员：拒绝，返回 ALREADY_IN_CIRCLE', async () => {
    sdk.__reset({
      collections: {
        circles: [{ ownerId: 'openid-a', pairIds: [], createdAt: new Date() }],
        members: [{ openid: 'openid-a', nickname: '我', status: 'active' }]
      }
    })
    const result = await createCircle.main({ nickname: '我', avatarFileID: 'cloud://xxx.png' })
    expect(result.code).toBe('ALREADY_IN_CIRCLE')
  })

  test('昵称缺失：返回 VALIDATION_FAILED，不写库', async () => {
    const result = await createCircle.main({ nickname: '  ', avatarFileID: 'cloud://xxx.png' })
    expect(result.code).toBe('VALIDATION_FAILED')
    // 校验在补建集合之前发生：连集合都不应有写入
    expect(sdk.__state.collections.members).toBeUndefined()
  })

  test('昵称超长：返回 VALIDATION_FAILED', async () => {
    const result = await createCircle.main({ nickname: 'a'.repeat(31), avatarFileID: 'cloud://xxx.png' })
    expect(result.code).toBe('VALIDATION_FAILED')
  })

  test('头像 fileID 缺失：返回 VALIDATION_FAILED', async () => {
    const result = await createCircle.main({ nickname: '圈主' })
    expect(result.code).toBe('VALIDATION_FAILED')
  })
})
