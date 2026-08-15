// wx-server-sdk 的最小内存版 mock，只覆盖本项目云函数用到的能力：
//   cloud.init / cloud.getWXContext / cloud.database / cloud.deleteFile
//   db.collection(name).where(cond).get()/count()/update()、collection.add、collection.count、
//   collection.doc(id).get()/update()/remove()、db.createCollection、where().orderBy().limit().get()
//   db.command 的 gt/and/or/neq/in：where 会真实求值命令条件（用于 bootstrap 的
//   unreadCount 可见性过滤测试）；与命令无关的字段仍按精确匹配。
//   数组字段 + 标量条件的语义与真实云数据库一致：where({arrField: x}) 匹配
//   数组包含 x（bootstrap 的 {pairIds: OPENID} 依赖这一行为）。
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
  deletedFiles: [] // cloud.deleteFile 被调用的 fileID 累计（deleteRecord 测试断言用）
}

function notExists (name) {
  return new Error(`database collection not exists: ${name}`)
}

function isPlainValue (v) {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}

// ---- db.command 求值（_.gt / _.neq / _.and / _.or）----
// 约定：command 对象是 {__cmd, v | args} 形态；字段命令（gt/neq）作用于单个字段值，
// 顶层 and/or 作用于整个文档（其参数是「字段对象」或嵌套命令）。
function isCommand (v) {
  return !!v && typeof v === 'object' && typeof v.__cmd === 'string'
}

// 字段命令：actual 是该字段在文档里的值
function evalFieldCommand (cmd, actual) {
  switch (cmd.__cmd) {
    case 'gt': return actual > cmd.v
    case 'neq': return actual !== cmd.v
    case 'in': return Array.isArray(cmd.v) && cmd.v.includes(actual)
    case 'and': return cmd.args.every(a => isPlainValue(a) ? actual === a : evalFieldCommand(a, actual))
    case 'or': return cmd.args.some(a => isPlainValue(a) ? actual === a : evalFieldCommand(a, actual))
    default: return true
  }
}

// 字段对象：{field: 值 | 字段命令}，作用于单个文档
function matchesFieldObject (obj, doc) {
  return Object.keys(obj).every(k => {
    const v = obj[k]
    if (isPlainValue(v)) {
      // 数组字段 + 标量 = 包含匹配（真实云数据库语义，如 {pairIds: OPENID}）
      return Array.isArray(doc[k]) ? doc[k].includes(v) : doc[k] === v
    }
    return evalFieldCommand(v, doc[k])
  })
}

// 顶层命令：_.and(...) / _.or(...)，其参数是字段对象或嵌套顶层命令
function evalTopCommand (cmd, doc) {
  const evalArg = a => isCommand(a) ? evalTopCommand(a, doc) : matchesFieldObject(a, doc)
  if (cmd.__cmd === 'and') return cmd.args.every(evalArg)
  if (cmd.__cmd === 'or') return cmd.args.some(evalArg)
  return true
}

// where 条件：可能是普通字段对象，也可能是顶层命令对象（如 bootstrap 的 _.and）
function whereMatches (doc, cond) {
  if (isCommand(cond)) return evalTopCommand(cond, doc)
  return matchesFieldObject(cond, doc)
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
      const filtered = docs.filter(doc => whereMatches(doc, cond))
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
    in: v => ({ __cmd: 'in', v }),
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
  __reset ({ collections = {}, openid = 'openid-a', counts = {} } = {}) {
    state.collections = collections
    state.openid = openid
    state.counts = counts
    state.seq = 0
    state.deletedFiles = []
  },
  __state: state
}
