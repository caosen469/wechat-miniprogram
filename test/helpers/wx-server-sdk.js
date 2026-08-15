// wx-server-sdk 的最小内存版 mock，只覆盖本项目云函数用到的能力：
//   cloud.init / cloud.getWXContext / cloud.database
//   db.collection(name).where(cond).get()/count()、collection.add、collection.count、db.createCollection
//   db.command 的 gt/and/or/neq（返回不透明对象，where 匹配时跳过命令字段，
//   命令条件的查询结果用 __setCount 显式指定，用于测分支而非测查询语义）
//
// 真实云数据库里「集合不存在」时读写会抛错，这里保持同样行为，
// 以便测试「首次建圈前集合尚不存在」的路径。
//
// 每个测试用 __reset 播种数据后 require 被测云函数。

const state = {
  collections: {}, // name -> docs[]
  openid: 'openid-a',
  counts: {}, // name -> total，覆盖该集合 where().count() 的返回值
  seq: 0
}

function notExists (name) {
  return new Error(`database collection not exists: ${name}`)
}

function isPlainValue (v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
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
    async get () {
      if (docs === undefined) throw notExists(name)
      return { data: docs.map(d => ({ ...d })) }
    },
    async count () {
      if (docs === undefined) throw notExists(name)
      return { total: state.counts[name] !== undefined ? state.counts[name] : docs.length }
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
    or: (...args) => ({ __cmd: 'or', args })
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
  __reset ({ collections = {}, openid = 'openid-a', counts = {} } = {}) {
    state.collections = collections
    state.openid = openid
    state.counts = counts
    state.seq = 0
  },
  __state: state
}
