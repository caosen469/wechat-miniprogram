// sendReminders —— 新记录提醒推送（内部函数，spec 8.1 / ADR 0004，T24）。
// 由 publishRecord 在发布成功后触发，对除作者外的可见成员发一次性订阅消息；
// 红点兜底与此无关（spec 8.2：推送全挂产品依然完整可用）。
//
// 隐私与权限联动（全部在本函数收口过滤）：
//   「仅我俩」→ 只推 pairIds 快照里的另一人，且用模糊文案（不带地点不带摘要，
//              防止推送文案在微信「服务通知」列表里泄露私密内容）；
//   「仅自己」→ 不触发（publishRecord 侧就不调）；
//   退出/被移除成员 → 发送时按当前 status 复查，不推；
//   作者本人 → 不推自己；设置里关了提醒（members.remindersOff）→ 不推。
//
// 聚合（同一作者 1 分钟内连发只推最后一条）：发送前先等满聚合窗口，再看窗口内
// 有没有同作者更新的记录——有则本条不推（更新那条自己的调用会推）。
// 因此推送统一延迟约一个窗口才到，这是兑现「只推最后一条」的必要代价；
// 等待在本函数内完成 → config.json 里 timeout 已配 60s（默认 20s 会掐死等待）。
// 窗口边界：等待 58s 略短于判定窗口 60s（云函数超时上限 60s 留不出余量），
// 58–60 秒间隔连发的两条可能都推——宁可边界多一条，不丢通知。
//
// 降级（spec 10.3 预设路径）：「内容提醒」类模板审核不过时 templateId 留空，
// 本函数直接跳过——纯红点形态上线，推送代码留接口，过审后填 id 即启用。
const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()

// ---- 环境配置：模板过审后填到这里（前端同步填 miniprogram/config/index.js）----
const config = {
  // 公共模板库「内容提醒/家庭内容提醒」类模板的 id；留空 = 降级不发
  templateId: '',
  // 聚合等待（毫秒）：须 < 云函数超时（60s）留出查库+发送余量
  aggregateWindowMs: 58 * 1000,
  // 体验版用 trial 才能收到推送；正式发布后改 formal
  miniprogramState: 'trial'
}

// thing 类模板字段上限 20 字（微信模板规范，超长会 47003）
const THING_MAX = 20
// 「1 分钟内连发」的判定窗口
const AGG_WINDOW = 60 * 1000
// 只推「新鲜」记录：防止客户端拿历史 recordId 反复点名调用烧订阅额度
const MAX_RECORD_AGE = 10 * 60 * 1000

exports.config = config

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const cut = s => String(s || '').slice(0, THING_MAX)

// 吐槽首句：首个句末标点前的内容，空吐槽给兜底文案
function firstSentence (text) {
  const t = typeof text === 'string' ? text.trim() : ''
  if (!t) return '点击查看'
  const m = t.match(/^[^。！!？?~\n]*[。！!？?~]?/)
  return cut(m && m[0]) || '点击查看'
}

// 发送目标：visible 成员里除作者、未关提醒的 openid 列表
function pickRecipients (record, activeMembers) {
  const pool = record.visibility === 'pair'
    ? (record.pairIds || []).filter(id => id !== record.authorId)
    : activeMembers.map(m => m.openid).filter(id => id !== record.authorId)
  const activeOnids = new Set(activeMembers.map(m => m.openid))
  return pool.filter(id => activeOnids.has(id))
}

// family 文案：作者昵称 + 地点名 + 吐槽首句（spec 8.1）
// 注：字段名 thing1/2/3 是接口占位，模板过审后按实际字段名调整；
// 微信对空 thing 字段报 47003，缺失信息用占位文案兜底
function familyData (author, placeName, record) {
  return {
    thing1: cut(author && author.nickname) || '你的家人',
    thing2: cut(placeName) || '一个打卡地点',
    thing3: firstSentence(record.text)
  }
}

// pair 模糊文案（spec 8.1）：不带地点不带摘要
function pairData () {
  return {
    thing1: '你的另一半',
    thing2: '发了一条仅你可见的动态',
    thing3: '点击查看'
  }
}

exports.main = async (event) => {
  try {
    // 鉴权：与其他云函数同口径（openid → active 成员）。虽是内部函数，
    // 但 wx.cloud.callFunction 可被客户端点名调用，不设防会被拿历史
    // recordId 反复触发、烧光成员「一次授权 = 一条」的订阅额度
    const { OPENID } = cloud.getWXContext()
    const callerRes = await db.collection('members')
      .where({ openid: OPENID, status: 'active' })
      .get()
    if (callerRes.data.length === 0) {
      return { skipped: 'forbidden' }
    }

    // 降级路径：模板未过审（id 留空）时直接跳过，不等待不发送
    if (!config.templateId) {
      return { skipped: 'no-template' }
    }

    // 等满聚合窗口再判定：窗口内若出现同作者更新的记录，本条让位（只推最后一条）
    if (config.aggregateWindowMs > 0) {
      await sleep(config.aggregateWindowMs)
    }

    const recordRes = await db.collection('records').doc(event.recordId).get()
    const record = recordRes.data
    if (!record) {
      return { skipped: 'not-found' }
    }
    if (record.visibility === 'private') {
      return { skipped: 'private' } // 仅自己可见：不推（spec 8.1）
    }

    const mine = new Date(record.createdAt).getTime()
    if (isNaN(mine)) {
      return { skipped: 'no-createdAt' }
    }
    // 只推新鲜记录：配合上面的鉴权，杜绝拿旧 recordId 重放烧额度
    if (Date.now() - mine > MAX_RECORD_AGE) {
      return { skipped: 'stale' }
    }
    // 聚合判定：60s 内有同作者更新的记录 → 本条不推。
    // 查询用 createdAt > 本条 下推 + 倒序限量（默认 get 只取 100 条且无序，
    // 作者历史一多就看不见新记录）；private 档不算——它自己永远不会触发
    // 推送，若算作超越会让前一条正常记录的推送凭空消失
    const newerRes = await db.collection('records')
      .where({ authorId: record.authorId, createdAt: db.command.gt(record.createdAt) })
      .orderBy('createdAt', 'desc')
      .limit(5)
      .get()
    const superseded = newerRes.data.some(r => {
      const ts = new Date(r.createdAt).getTime()
      return r.visibility !== 'private' &&
        ts > mine && ts - mine <= AGG_WINDOW
    })
    if (superseded) {
      return { skipped: 'superseded' }
    }

    // 发送时按当前成员状态复查（退出/被移除不推）+ 提醒开关过滤
    const members = (await db.collection('members').limit(100).get()).data
    const active = members.filter(m => m.status === 'active' && m.remindersOff !== true)
    const recipients = pickRecipients(record, active)
    const author = members.find(m => m.openid === record.authorId)

    let placeName = ''
    try {
      placeName = (await db.collection('places').doc(record.placeId).get()).data.name
    } catch (e) { /* 地点并档/删除后悬空：thing2 用占位文案兜底（空串会 47003） */ }

    let sent = 0
    for (const touser of recipients) {
      try {
        await cloud.openapi.subscribeMessage.send({
          touser,
          templateId: config.templateId,
          page: `pages/detail/detail?recordId=${event.recordId}`,
          data: record.visibility === 'pair'
            ? pairData()
            : familyData(author, placeName, record),
          miniprogramState: config.miniprogramState,
          lang: 'zh_CN'
        })
        sent++
      } catch (e) {
        // 43101（额度耗尽/未订阅）等发送失败一律静默（spec 8.1：
        // 绝不提示发布者「谁没收到」，家庭场景避免制造社交压力）
        console.warn('subscribeMessage.send fail:', touser,
          (e && (e.errCode || e.errMsg)) || e)
      }
    }
    return { sent }
  } catch (e) {
    // 提醒是增强不是依赖（spec 8.2）：任何异常静默吞掉，绝不向上抛
    console.warn('sendReminders skipped:', (e && e.message) || e)
    return { skipped: 'error' }
  }
}
