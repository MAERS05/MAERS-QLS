const svcIdbMerge = {}
export const idbMerge = svcIdbMerge

/** MAERS QLS — 序列化值的三方合并与存储辅助计算。 */
function parse(raw, fallback) {
  try { return raw == null ? fallback : JSON.parse(raw) } catch { return fallback }
}

function rawByteSize(key, raw) {
  return (String(key).length + String(raw).length) * 2
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const conflict = () => new Error('其他页面已修改同一内容，请检查最新数据后重试')

/** 三方合并：仅提交相对本页快照的修改；同一字段冲突则拒绝，不能静默覆盖。 */
function mergeValue(base, next, latest) {
  if (same(base, next)) return latest
  if (same(base, latest) || same(next, latest)) return next
  if (isObject(next) && isObject(latest) && (base === undefined || isObject(base))) {
    const keys = new Set([...Object.keys(base || {}), ...Object.keys(next), ...Object.keys(latest)])
    return Object.fromEntries([...keys].flatMap(key => {
      const value = mergeValue(base?.[key], next[key], latest[key])
      return value === undefined ? [] : [[key, value]]
    }))
  }
  if (Array.isArray(next) && Array.isArray(latest) && (base === undefined || Array.isArray(base))) {
    const all = [...(base || []), ...next, ...latest]
    const identity = ['id', 'seriesId', '_syncId'].find(field =>
      all.length > 0 && all.every(item => isObject(item) && typeof item[field] === 'string' && item[field]))
    if (identity) {
      const toMap = list => new Map(list.map(item => [item[identity], item]))
      const before = toMap(base || []), wanted = toMap(next), current = toMap(latest)
      if ([base || [], next, latest].some(list => toMap(list).size !== list.length)) throw conflict()
      const order = new Set([...wanted.keys(), ...current.keys(), ...before.keys()])
      return [...order].flatMap(id => {
        const value = mergeValue(before.get(id), wanted.get(id), current.get(id))
        return value === undefined ? [] : [value]
      })
    }
  }
  throw conflict()
}

const mergeRaw = (base, next, latest) => {
  const value = mergeValue(parse(base, undefined), parse(next, undefined), parse(latest, undefined))
  return value === undefined ? null : JSON.stringify(value)
}

function setRaw(map, key, raw) {
  if (raw == null) map.delete(key)
  else map.set(key, raw)
}

svcIdbMerge.merge = { parse, rawByteSize, same, conflict, mergeValue, mergeRaw, setRaw }
