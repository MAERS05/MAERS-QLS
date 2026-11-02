import { metadata as svcMetadata } from './core.js'

const svcPlanningTemplates = {}
export const planningTemplates = svcPlanningTemplates

/** 自定义时间列的数据契约与时间分配投影；不访问页面或存储。 */
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

svcPlanningTemplates.read = map => {
  const raw = map?._templates
  if (isObject(raw) && Array.isArray(raw.items)) {
    const seen = new Set()
    const items = raw.items.filter(item => {
      if (!isObject(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id) ||
          typeof item.name !== 'string' || !item.name.trim()) return false
      seen.add(item.id)
      return true
    }).map(item => ({ id: item.id, name: item.name.trim().slice(0, 24), blocks: Array.isArray(item.blocks) ? item.blocks : [] }))
    return { activeId: items.some(item => item.id === raw.activeId) ? raw.activeId : (items[0]?.id || ''), items }
  }
  const blocks = Array.isArray(map?.ideal) ? map.ideal : []
  return blocks.length
    ? { activeId: 'legacy-ideal', items: [{ id: 'legacy-ideal', name: '原期望', blocks }] }
    : { activeId: '', items: [] }
}

svcPlanningTemplates.active = map => {
  const state = svcPlanningTemplates.read(map)
  return state.items.find(item => item.id === state.activeId) || null
}

svcPlanningTemplates.write = (map, state) => {
  map._templates = state
  delete map.ideal
  return map
}

svcPlanningTemplates.migrate = map => {
  if (!isObject(map) || !Array.isArray(map.ideal)) return map
  return svcPlanningTemplates.write({ ...map }, svcPlanningTemplates.read(map))
}

svcPlanningTemplates.time = map => {
  const time = Object.fromEntries(svcMetadata.TIME_KEYS.map(key => [key, { hours: 0, items: [] }]))
  ;(svcPlanningTemplates.active(map)?.blocks || []).forEach(block => {
    const hours = Number(block?.durationH)
    const category = svcMetadata.normalizeCategoryKey(block?.category, block?.color)
    if (!Number.isFinite(hours) || hours <= 0) return
    time[category].hours += hours
    time[category].items.push({ label: typeof block.label === 'string' ? block.label : '', hours: Math.round(hours * 100) / 100 })
  })
  Object.values(time).forEach(category => { category.hours = Math.round(category.hours * 100) / 100 })
  return time
}

svcPlanningTemplates.changed = (before, after) =>
  JSON.stringify(svcPlanningTemplates.active(before)) !== JSON.stringify(svcPlanningTemplates.active(after))

svcPlanningTemplates.expectations = (map, current) => ({
  ...(isObject(current) ? current : {}), time: svcPlanningTemplates.time(map),
})
