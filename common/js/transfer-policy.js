import { metadata } from './core.js'

export const transferPolicy = {}
transferPolicy.modes = {
  replace: '替换',
  'merge-skip': '合并（跳过冲突部分）',
  'merge-overwrite': '合并（覆盖冲突部分）',
}
transferPolicy.validate = mode => {
  if (!Object.hasOwn(transferPolicy.modes, mode)) throw new Error('请选择有效的数据处理方式')
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function mergeRecords(current, incoming, overwrite, idKey = 'id') {
  const records = new Map(current.map(item => [item[idKey], item]))
  incoming.forEach(item => {
    if (overwrite || !records.has(item[idKey])) records.set(item[idKey], item)
  })
  return [...records.values()]
}
function mergeBlocks(current, incoming, overwrite) {
  const merged = { ...current }
  Object.entries(incoming).forEach(([key, value]) => {
    if (!Object.hasOwn(current, key)) merged[key] = value
    else if (Array.isArray(current[key]) && Array.isArray(value)) {
      merged[key] = mergeRecords(current[key], value, overwrite, key === '_repeats' ? 'seriesId' : 'id')
    } else if (key === '_templates' && isObject(current[key]) && isObject(value)) {
      const items = mergeRecords(current[key].items || [], value.items || [], overwrite)
      const activeId = overwrite ? value.activeId : current[key].activeId
      merged[key] = { activeId: items.some(item => item.id === activeId) ? activeId : (items[0]?.id || ''), items }
    } else if (overwrite) merged[key] = value
  })
  return merged
}

/** 冲突以完整记录为单位，避免将两个版本的同一条记录拼成未经校验的新内容。 */
transferPolicy.apply = (current, incoming, mode = 'replace') => {
  transferPolicy.validate(mode)
  if (mode === 'replace') return { ...incoming }
  const overwrite = mode === 'merge-overwrite'
  const merged = { ...current }
  Object.entries(incoming).forEach(([key, value]) => {
    if (!Object.hasOwn(current, key)) merged[key] = value
    else if ([metadata.TASKS_KEY, metadata.GOALS_KEY, metadata.INPROGRESS_KEY].includes(key) &&
        Array.isArray(current[key]) && Array.isArray(value)) merged[key] = mergeRecords(current[key], value, overwrite)
    else if (key === metadata.TIMEBLOCK_KEY && isObject(current[key]) && isObject(value)) merged[key] = mergeBlocks(current[key], value, overwrite)
    else if (key === metadata.TAGS_KEY && isObject(current[key]) && isObject(value)) merged[key] = overwrite
      ? { ...current[key], ...value } : { ...value, ...current[key] }
    else if (overwrite) merged[key] = value
  })
  return merged
}
