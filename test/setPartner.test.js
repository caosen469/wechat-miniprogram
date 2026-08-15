// T18：setPartner 圈主指定/更换另一半（spec 5.1、4.1）
// 只改 circles.pairIds，不动历史记录（pairIds 快照语义，spec 4.5）。
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')

const setPartner = require('../cloudfunctions/setPartner/index')

const members = [
  { _id: 'm-owner', openid: 'openid-owner', nickname: '圈主', role: 'owner', status: 'active' },
  { _id: 'm-b', openid: 'openid-b', nickname: '女友', role: 'member', status: 'active' },
  { _id: 'm-c', openid: 'openid-c', nickname: '妈妈', role: 'member', status: 'active' },
  { _id: 'm-left', openid: 'openid-left', nickname: '旧成员', role: 'member', status: 'removed' }
]

function reset ({ pairIds = [], openid = 'openid-owner' } = {}) {
  sdk.__reset({
    openid,
    collections: {
      circles: [{ ownerId: 'openid-owner', pairIds, createdAt: new Date() }],
      members: members.map(m => ({ ...m }))
    }
  })
}

describe('setPartner（圈主指定/更换另一半）', () => {
  test('圈主指定 active 成员：circles.pairIds 更新为 [圈主, 新搭档]', async () => {
    reset({ pairIds: [] })
    const result = await setPartner.main({ partnerOpenid: 'openid-b' })
    expect(result.code).toBeUndefined()
    const circle = sdk.__state.collections.circles[0]
    expect(circle.pairIds).toEqual(['openid-owner', 'openid-b'])
  })

  test('重指另一半：pairIds 更新，历史记录的 pairIds 不受影响（快照语义）', async () => {
    reset({ pairIds: ['openid-owner', 'openid-b'] })
    sdk.__state.collections.records = [{
      _id: 'r-old',
      visibility: 'pair',
      pairIds: ['openid-owner', 'openid-b'],
      authorId: 'openid-owner'
    }]
    const result = await setPartner.main({ partnerOpenid: 'openid-c' })
    expect(result.code).toBeUndefined()
    expect(sdk.__state.collections.circles[0].pairIds).toEqual(['openid-owner', 'openid-c'])
    // 旧 pair 记录的快照不动（spec 4.5：重指不影响历史记录）
    expect(sdk.__state.collections.records[0].pairIds).toEqual(['openid-owner', 'openid-b'])
  })

  test('非圈主调用：NOT_OWNER', async () => {
    reset({ openid: 'openid-b' })
    const result = await setPartner.main({ partnerOpenid: 'openid-c' })
    expect(result.code).toBe('NOT_OWNER')
  })

  test('不在圈 / 非 active：NOT_IN_CIRCLE', async () => {
    reset({ openid: 'openid-left' })
    const result = await setPartner.main({ partnerOpenid: 'openid-b' })
    expect(result.code).toBe('NOT_IN_CIRCLE')
  })

  test('目标不是 active 成员：VALIDATION_FAILED', async () => {
    reset()
    const result = await setPartner.main({ partnerOpenid: 'openid-left' })
    expect(result.code).toBe('VALIDATION_FAILED')
    expect(sdk.__state.collections.circles[0].pairIds).toEqual([])
  })

  test('目标是自己：VALIDATION_FAILED（另一半是另一个人）', async () => {
    reset()
    const result = await setPartner.main({ partnerOpenid: 'openid-owner' })
    expect(result.code).toBe('VALIDATION_FAILED')
  })

  test('目标不存在：VALIDATION_FAILED', async () => {
    reset()
    const result = await setPartner.main({ partnerOpenid: 'no-such' })
    expect(result.code).toBe('VALIDATION_FAILED')
  })

  test('缺少 partnerOpenid：VALIDATION_FAILED', async () => {
    reset()
    const result = await setPartner.main({})
    expect(result.code).toBe('VALIDATION_FAILED')
  })
})
