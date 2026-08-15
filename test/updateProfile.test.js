// updateProfile —— 修改我的资料（spec 5.1）：昵称、头像、提醒开关（T24）。
// remindersOn: false 写 members.remindersOff=true（spec 8.1：关 = 不再请求授权也不再发）。
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const updateProfile = require('../cloudfunctions/updateProfile/index')

const seed = (over = {}) => sdk.__reset({
  collections: {
    members: [{ _id: 'm-a', openid: 'openid-a', nickname: '我', status: 'active', remindersOff: false }]
  },
  ...over
})

const memberNow = () => sdk.__state.collections.members[0]

describe('updateProfile（修改资料，T24 扩展提醒开关）', () => {
  test('remindersOn: false → remindersOff 落 true', async () => {
    seed()
    const result = await updateProfile.main({ remindersOn: false })
    expect(result.code).toBeUndefined()
    expect(memberNow().remindersOff).toBe(true)
  })

  test('remindersOn: true → remindersOff 落 false（重新打开）', async () => {
    seed({ collections: { members: [{ _id: 'm-a', openid: 'openid-a', nickname: '我', status: 'active', remindersOff: true }] } })
    const result = await updateProfile.main({ remindersOn: true })
    expect(result.code).toBeUndefined()
    expect(memberNow().remindersOff).toBe(false)
  })

  test('remindersOn 非布尔：VALIDATION_FAILED 且不落库', async () => {
    seed()
    const result = await updateProfile.main({ remindersOn: 'no' })
    expect(result.code).toBe('VALIDATION_FAILED')
    expect(memberNow().remindersOff).toBe(false)
  })

  test('不在圈 / 非 active：NOT_IN_CIRCLE', async () => {
    seed({ collections: { members: [{ _id: 'm-a', openid: 'openid-a', status: 'left' }] } })
    const result = await updateProfile.main({ remindersOn: false })
    expect(result.code).toBe('NOT_IN_CIRCLE')
  })

  test('什么都不传：VALIDATION_FAILED（至少传一项）', async () => {
    seed()
    const result = await updateProfile.main({})
    expect(result.code).toBe('VALIDATION_FAILED')
  })
})
