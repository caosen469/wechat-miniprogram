// wx-server-sdk 的最小内存版 mock，只覆盖本项目云函数用到的能力：
//   cloud.init / cloud.getWXContext / cloud.database / cloud.deleteFile / cloud.callFunction
//   cloud.openapi.subscribeMessage.send（T24 提醒推送断言用）
//   db.collection(name).where(cond).get()/count()/update()、collection.add、collection.count、
//   collection.doc(id).get()/update()/remove()、db.createCollection、where().orderBy().limit().get()
//   db.command 的 gt/and/or/neq（返回不透明对象，where 匹配时跳过命令字段，
//   命令条件的查询结果用 __setCount 显式指定，用于测分支而非测查询语义）
//   db.Geo.Point（记录经纬度，spec 4.4 location 字段）
//
// 真实云数据库里「集合不存在」时读写会抛错，这里保持同样行为，
// 以便测试「首次建圈前集合尚不存在」的路径。
//
// 每个测试用 __reset 播种数据后 require 被测云函数。

const state = {
  collections: {}, // name -> docs[]
  openid: 'openid-a',
  counts: {}, // name -> total，覆盖该集合 where().count() 的返回值
  seq: 0,
  deletedFiles: [], // cloud.deleteFile 被调用的 fileID 累计（deleteRecord 测试断言用）
  functions: {}, // name -> async (event) => result，callFunction 的被调函数表
  calls: [], // callFunction 入参累计 {name, data}（publishRecord 触发 sendReminders 断言用）
  sentMessages: [], // openapi.subscribeMessage.send 成功入参累计（sendReminders 测试断言用）
  sendBehavior: null // fn(opts) -> throw|undefined，模拟 43101 等发送失败
}

function notExists (name) {
  return new Error(`database collection not exists: ${name}`)
}

function isPlainValue (v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}

const REMOVE = Symbol('remove')

function applyUpdate (doc, data) {
  // wx-server-sdk 的 update 是顶层字段合并，不是整体替换；
  // _.remove() 标记对应真实 SDK 的字段删除
  for (const key of Object.keys(data)) {
    if (data[key] === REMOVE) {
      delete doc[key]
    } else {
      doc[key] = data[key]
    }
  }
}

function makeQuery (docs, name) {
  return {
    where (cond = {}) {
      if (docs === undefined) return makeQuery(undefined, name)
      const filtered = docs.filter(doc =>
        Object.keys(cond).every(k => isPlainValue(cond[k]) ? doc[k] === cond[k] : true)
      )
      return makeQuery(filtered, name)
    },
    limit () {
      return this
    },
    orderBy (field, direction) {
      if (docs === undefined) return makeQuery(undefined, name)
      const sorted = [...docs].sort((x, y) => {
        const a = x[field]
        const b = y[field]
        const cmp = a < b ? -1 : a > b ? 1 : 0
        return direction === 'desc' ? -cmp : cmp
      })
      return makeQuery(sorted, name)
    },
    async get () {
      if (docs === undefined) throw notExists(name)
      return { data: docs.map(d => ({ ...d })) }
    },
    async count () {
      if (docs === undefined) throw notExists(name)
      return { total: state.counts[name] !== undefined ? state.counts[name] : docs.length }
    },
    async update ({ data }) {
      if (docs === undefined) throw notExists(name)
      docs.forEach(doc => applyUpdate(doc, data))
      return { stats: { updated: docs.length } }
    },
    doc (id) {
      const all = state.collections[name]
      if (all === undefined) throw notExists(name)
      const target = all.find(d => d._id === id)
      if (!target) throw new Error(`document not exists: ${id}`)
      return {
        async get () {
          return { data: { ...target } }
        },
        async update ({ data }) {
          applyUpdate(target, data)
          return { stats: { updated: 1 } }
        },
        async remove () {
          const i = all.indexOf(target)
          if (i === -1) throw new Error(`document not exists: ${id}`)
          all.splice(i, 1)
          return { stats: { removed: 1 } }
        }
      }
    }
  }
}

const db = {
  collection (name) {
    const q = makeQuery(state.collections[name], name)
    q.add = async ({ data }) => {
      const docs = state.collections[name]
      if (docs === undefined) throw notExists(name)
      const _id = `id-${++state.seq}`
      docs.push({ _id, ...data })
      return { _id }
    }
    return q
  },
  async createCollection (name) {
    if (name in state.collections) {
      throw new Error(`collection exists: ${name}`)
    }
    state.collections[name] = []
  },
  command: {
    gt: v => ({ __cmd: 'gt', v }),
    neq: v => ({ __cmd: 'neq', v }),
    and: (...args) => ({ __cmd: 'and', args }),
    or: (...args) => ({ __cmd: 'or', args }),
    remove: () => REMOVE
  },
  Geo: {
    Point: class Point {
      constructor (longitude, latitude) {
        this.coordinates = [longitude, latitude]
      }
    }
  }
}

module.exports = {
  DYNAMIC_CURRENT_ENV: Symbol('DYNAMIC_CURRENT_ENV'),
  init () {},
  getWXContext () {
    return { OPENID: state.openid }
  },
  database () {
    return db
  },
  // deleteRecord 删媒体用（spec 5.1）：记录被调用的 fileID 供测试断言
  async deleteFile ({ fileList }) {
    state.deletedFiles.push(...fileList)
    return { fileList: fileList.map(fileID => ({ fileID, status: 0 })) }
  },
  // publishRecord 内部触发 sendReminders 用（spec 8.1）：查 functions 表分发；
  // 未注册的函数按调用成功处理（推送缺席不影响发布主流程）
  async callFunction ({ name, data }) {
    state.calls.push({ name, data })
    const fn = state.functions[name]
    if (!fn) return { result: {} }
    return { result: await fn(data) }
  },
  openapi: {
    subscribeMessage: {
      // sendReminders 推送用（spec 8.1）：默认记录入参并返回成功；
      // sendBehavior 存在时完全接管（自行 push sentMessages / 抛 43101 模拟失败）
      async send (options) {
        if (typeof state.sendBehavior === 'function') {
          state.sendBehavior(options)
          return { errCode: 0 }
        }
        state.sentMessages.push(options)
        return { errCode: 0 }
      }
    }
  },
  __reset ({ collections = {}, openid = 'openid-a', counts = {}, functions = {}, sendBehavior = null } = {}) {
    state.collections = collections
    state.openid = openid
    state.counts = counts
    state.seq = 0
    state.deletedFiles = []
    state.functions = functions
    state.calls = []
    state.sentMessages = []
    state.sendBehavior = sendBehavior
  },
  __state: state
}
