// T24：sendReminders 新记录提醒推送（spec 8.1 / ADR 0004）
// 覆盖：可见范围过滤（pair 模糊文案 / private 不推 / 非成员不推 / 作者不推 / 关提醒不推）、
// 1 分钟聚合（只推最后一条）、43101 静默失败、模板未过审降级（留接口不发）。
jest.mock('wx-server-sdk', () => require('./helpers/wx-server-sdk'), { virtual: true })

const sdk = require('./helpers/wx-server-sdk')
const sendReminders = require('../cloudfunctions/sendReminders/index')

// 聚合等待在测试中归零（真实值见 config 注释）；窗口判定仍是 60s 语义
sendReminders.config.aggregateWindowMs = 0
sendReminders.config.templateId = 'TMPL-1'

const now = Date.now()
const AGG_WINDOW = 60 * 1000

const author = { _id: 'm-a', openid: 'openid-a', nickname: '阿曹', status: 'active' }
const partner = { _id: 'm-b', openid: 'openid-b', nickname: '小美', status: 'active' }
const mom = { _id: 'm-c', openid: 'openid-c', nickname: '妈妈', status: 'active' }
const removed = { _id: 'm-x', openid: 'openid-x', nickname: '旧成员', status: 'removed' }
const left = { _id: 'm-y', openid: 'openid-y', nickname: '走的人', status: 'left' }
const muted = { _id: 'm-z', openid: 'openid-z', nickname: '关提醒的人', status: 'active', remindersOff: true }

const place = { _id: 'p-1', name: '外婆家（湖滨银泰店）', type: 'restaurant' }

// 一条 family 档记录（默认 30 秒前发布，聚合窗口已过）
const familyRecord = (over = {}) => ({
  _id: 'r-1',
  placeId: 'p-1',
  authorId: 'openid-a',
  text: '这次排队半小时，值得！下次还来。',
  rating: 4,
  visibility: 'family',
  createdAt: new Date(now - 30 * 1000),
  ...over
})

const seed = (record, over = {}) => {
  sdk.__reset({
    collections: {
      circles: [{ ownerId: 'openid-a', pairIds: ['openid-a', 'openid-b'], createdAt: new Date() }],
      members: [author, partner, mom, removed, left, muted],
      places: [place],
      records: record ? [record] : []
    },
    ...over
  })
}

const sentTousers = () => sdk.__state.sentMessages.map(m => m.touser)

describe('sendReminders（提醒推送，spec 8.1）', () => {
  test('family 档：推给除作者外的 active 且未关提醒的成员，内容=昵称+地点+首句，直达详情页', async () => {
    seed(familyRecord())

    const result = await sendReminders.main({ recordId: 'r-1' })

    expect(result.code).toBeUndefined()
    expect(result.sent).toBe(2)
    // 作者本人、已移除、已退出、关了提醒的都不推
    expect(sentTousers().sort()).toEqual(['openid-b', 'openid-c'])
    const msg = sdk.__state.sentMessages[0]
    expect(msg.templateId).toBe('TMPL-1')
    expect(msg.page).toBe('pages/detail/detail?recordId=r-1')
    // 「新日志提醒」模板字段：thing1=日志作者，thing2=日志内容（地点：首句），time3=发布时间
    expect(msg.data.thing1).toBe('阿曹')
    expect(msg.data.thing2).toContain('外婆家（湖滨银泰店）')
    expect(msg.data.thing2).toContain('这次排队半小时')
    expect(msg.data.time3).toMatch(/^\d{4}年\d{1,2}月\d{1,2}日 \d{2}:\d{2}$/)
  })

  test('吐槽首句截断：thing2 整体 ≤20 字（地点：首句）；空吐槽给兜底文案', async () => {
    seed(familyRecord({
      text: '这是一段特别长的吐槽，第一句就超过了二十个字的模板字段上限，必须截断。第二句不该出现。'
    }))
    await sendReminders.main({ recordId: 'r-1' })
    const thing2 = sdk.__state.sentMessages[0].data.thing2
    expect(thing2.length).toBeLessThanOrEqual(20)
    expect(thing2.startsWith('外婆家（湖滨银泰店）')).toBe(true)
    expect(thing2).not.toContain('第二句')

    seed(familyRecord({ text: '' }))
    await sendReminders.main({ recordId: 'r-1' })
    expect(sdk.__state.sentMessages[0].data.thing2).toContain('点击查看')
  })

  test('private 档：不推任何人的', async () => {
    seed(familyRecord({ visibility: 'private' }))
    const result = await sendReminders.main({ recordId: 'r-1' })
    expect(result.skipped).toBe('private')
    expect(sdk.__state.sentMessages).toHaveLength(0)
  })

  test('pair 档：只推二人组里除作者的另一人，模糊文案不带地点不带摘要', async () => {
    seed(familyRecord({ visibility: 'pair', pairIds: ['openid-a', 'openid-b'] }))

    const result = await sendReminders.main({ recordId: 'r-1' })

    expect(result.sent).toBe(1)
    expect(sentTousers()).toEqual(['openid-b']) // 妈妈（第三人）不推
    const joined = Object.values(sdk.__state.sentMessages[0].data).join('')
    expect(joined).not.toContain('外婆家')
    expect(joined).not.toContain('排队')
    expect(joined).toContain('仅你可见')
  })

  test('pair 档：另一半已退出/被移除，不推', async () => {
    seed(familyRecord({ visibility: 'pair', pairIds: ['openid-a', 'openid-y'] }))
    const result = await sendReminders.main({ recordId: 'r-1' })
    expect(result.sent).toBe(0)
    expect(sdk.__state.sentMessages).toHaveLength(0)
  })

  test('设置里关掉提醒（remindersOff）：不推', async () => {
    seed(familyRecord())
    sdk.__state.collections.members = [author, muted]
    const result = await sendReminders.main({ recordId: 'r-1' })
    expect(result.sent).toBe(0)
  })

  describe('1 分钟聚合：同一作者连发多条只推最后一条（spec 8.1）', () => {
    test('60s 内有同作者更新的记录：本条不推（更新的那条自己会推）', async () => {
      seed(familyRecord())
      sdk.__state.collections.records.push(
        familyRecord({ _id: 'r-2', createdAt: new Date(now - 10 * 1000) })
      )
      const result = await sendReminders.main({ recordId: 'r-1' })
      expect(result.skipped).toBe('superseded')
      expect(sdk.__state.sentMessages).toHaveLength(0)
    })

    test('更新的记录在 60s 窗口之外：两条独立记录各自推', async () => {
      seed(familyRecord({ createdAt: new Date(now - 3 * 60 * 1000) }))
      sdk.__state.collections.records.push(
        familyRecord({ _id: 'r-2', createdAt: new Date(now - 30 * 1000) })
      )
      const result = await sendReminders.main({ recordId: 'r-1' })
      expect(result.sent).toBe(2) // r-1 与 r-2 间隔 > 60s，各自成条
    })

    test('更新的记录是别人的：不影响本条推送', async () => {
      seed(familyRecord())
      sdk.__state.collections.records.push(
        familyRecord({ _id: 'r-2', authorId: 'openid-c', createdAt: new Date(now - 5 * 1000) })
      )
      const result = await sendReminders.main({ recordId: 'r-1' })
      expect(result.sent).toBe(2)
    })

    test('更新的记录是 private 档：不算超越（它自己永远不推，否则通知链路凭空丢失）', async () => {
      seed(familyRecord())
      sdk.__state.collections.records.push(
        familyRecord({ _id: 'r-2', visibility: 'private', createdAt: new Date(now - 10 * 1000) })
      )
      const result = await sendReminders.main({ recordId: 'r-1' })
      expect(result.skipped).toBeUndefined()
      expect(result.sent).toBe(2)
    })

    test('本条自己不算超越（等满窗口后仍推）', async () => {
      seed(familyRecord())
      const result = await sendReminders.main({ recordId: 'r-1' })
      expect(result.skipped).toBeUndefined()
      expect(result.sent).toBe(2)
    })
  })

  test('调用者不是 active 成员（客户端点名调用）：forbidden 不发', async () => {
    seed(familyRecord())
    sdk.__state.openid = 'openid-stranger'
    const result = await sendReminders.main({ recordId: 'r-1' })
    expect(result.skipped).toBe('forbidden')
    expect(sdk.__state.sentMessages).toHaveLength(0)
  })

  test('陈旧记录（拿历史 recordId 重放）：stale 不发，不烧订阅额度', async () => {
    seed(familyRecord({ createdAt: new Date(now - 11 * 60 * 1000) }))
    const result = await sendReminders.main({ recordId: 'r-1' })
    expect(result.skipped).toBe('stale')
    expect(sdk.__state.sentMessages).toHaveLength(0)
  })

  test('地点文档已悬空：thing2 用占位地点兜底，不因空字段 47003 丢推送', async () => {
    seed(familyRecord({ placeId: 'p-gone' }))
    const result = await sendReminders.main({ recordId: 'r-1' })
    expect(result.sent).toBe(2)
    expect(sdk.__state.sentMessages[0].data.thing2).toContain('一个打卡地点')
  })

  test('额度耗尽（43101）等发送失败：静默跳过该人，不影响其他人，不报错', async () => {
    seed(familyRecord())
    sdk.__state.sendBehavior = (opts) => {
      if (opts.touser === 'openid-b') {
        const e = new Error('user refused')
        e.errCode = 43101
        throw e
      }
      sdk.__state.sentMessages.push(opts)
    }

    const result = await sendReminders.main({ recordId: 'r-1' })

    expect(result.code).toBeUndefined()
    expect(sentTousers()).toEqual(['openid-c']) // openid-b 静默失败，openid-c 照发
  })

  test('模板未配置（未过审降级路径）：不发、不等待，直接跳过', async () => {
    sendReminders.config.templateId = ''
    seed(familyRecord())
    const result = await sendReminders.main({ recordId: 'r-1' })
    sendReminders.config.templateId = 'TMPL-1'
    expect(result.skipped).toBe('no-template')
    expect(sdk.__state.sentMessages).toHaveLength(0)
  })

  test('记录不存在 / 查库异常：静默返回，不抛错（提醒绝不阻塞发布）', async () => {
    seed(familyRecord())
    const result = await sendReminders.main({ recordId: 'no-such' })
    expect(result.code).toBeUndefined()
    expect(sdk.__state.sentMessages).toHaveLength(0)
  })
})
