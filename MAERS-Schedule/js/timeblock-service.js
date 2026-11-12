import { scheduleModels as svcScheduleModels } from './models.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { planningTemplates as svcPlanningTemplates } from '../../common/js/planning-templates.js'
import { repeatRules as svcRepeatRules } from '../../common/js/repeat-rules.js'
import { storage as svcStorage } from '../../common/js/store.js'

const svcTimeblocks = {}
export const timeblocks = svcTimeblocks

/** MAERS Schedule — 时间块、重复系列与自定义时间列的领域服务。 */
const store = svcStorage.store
const { normalizeBlockObject, normalizeRepeatRule, storageDateOf } = svcScheduleModels.models

function readBlocksMap(options) {
  const all = options && Object.hasOwn(options, 'base')
    ? JSON.parse(JSON.stringify(options.base || {}))
    : store.get(svcMetadata.TIMEBLOCK_KEY, {})
  return all && typeof all === 'object' && !Array.isArray(all) ? all : {}
}

svcTimeblocks.loadBlocks = (dateStr, options) => {
  const key = storageDateOf(dateStr)
  if (!key) return []
  const all = readBlocksMap(options)
  const source = key === 'ideal' ? svcPlanningTemplates.active(all)?.blocks : all[key]
  const dayList = Array.isArray(source) ? source.map(normalizeBlockObject).filter(Boolean) : []
  if (key === 'ideal') return dayList

  const repeats = Array.isArray(all._repeats) ? all._repeats.map(normalizeRepeatRule).filter(Boolean) : []
  repeats.forEach(r => {
    if (svcRepeatRules.matchesRepeatRule(r.repeat, key, r)) {
      dayList.push({
        id: `${r.seriesId}_${key}`,
        seriesId: r.seriesId,
        label: r.label,
        startH: r.startH,
        durationH: r.durationH,
        category: r.category,
        notes: r.notes,
        missed: r.missedDates.includes(key),
        repeat: r.repeat,
      })
    }
  })
  return dayList
}

svcTimeblocks.loadTemplates = options => svcPlanningTemplates.read(readBlocksMap(options))
svcTimeblocks.loadActiveTemplate = options => svcPlanningTemplates.active(readBlocksMap(options))

svcTimeblocks.createTemplate = (name, options) => {
  const cleanName = typeof name === 'string' ? name.trim() : ''
  if (!cleanName || cleanName.length > 24) return null
  const all = readBlocksMap(options)
  const state = svcPlanningTemplates.read(all)
  if (state.items.some(item => item.name.toLowerCase() === cleanName.toLowerCase())) return null
  const template = { id: svcMetadata.uid('tpl_'), name: cleanName, blocks: [] }
  state.items.push(template)
  state.activeId = template.id
  return store.set(svcMetadata.TIMEBLOCK_KEY, svcPlanningTemplates.write(all, state), options) ? template : null
}

/** 重命名自定义时间列：名称规则与创建一致，重名（忽略大小写，排除自身）或无变化时返回 false。 */
svcTimeblocks.renameTemplate = (id, name, options) => {
  const cleanName = typeof name === 'string' ? name.trim() : ''
  if (!cleanName || cleanName.length > 24) return false
  const all = readBlocksMap(options)
  const state = svcPlanningTemplates.read(all)
  const target = state.items.find(item => item.id === id)
  if (!target || target.name === cleanName) return false
  if (state.items.some(item => item.id !== id && item.name.toLowerCase() === cleanName.toLowerCase())) return false
  target.name = cleanName
  return store.set(svcMetadata.TIMEBLOCK_KEY, svcPlanningTemplates.write(all, state), options)
}

svcTimeblocks.selectTemplate = (id, options) => {
  const all = readBlocksMap(options)
  const state = svcPlanningTemplates.read(all)
  if (!state.items.some(item => item.id === id)) return false
  state.activeId = id
  return store.set(svcMetadata.TIMEBLOCK_KEY, svcPlanningTemplates.write(all, state), options)
}

svcTimeblocks.deleteTemplate = (id, options) => {
  const all = readBlocksMap(options)
  const state = svcPlanningTemplates.read(all)
  if (!state.items.some(item => item.id === id)) return false
  state.items = state.items.filter(item => item.id !== id)
  if (state.activeId === id) state.activeId = state.items[0]?.id || ''
  return store.set(svcMetadata.TIMEBLOCK_KEY, svcPlanningTemplates.write(all, state), options)
}

svcTimeblocks.saveRepeatBlock = (block, options) => {
  const rule = normalizeRepeatRule({ ...block, seriesId: block?.seriesId || svcMetadata.uid('tbs_') })
  if (!rule) return null
  const all = readBlocksMap(options)
  const list = Array.isArray(all._repeats) ? all._repeats.map(normalizeRepeatRule).filter(Boolean) : []
  const idx = list.findIndex(r => r.seriesId === rule.seriesId)
  if (idx >= 0) list[idx] = rule
  else list.push(rule)
  all._repeats = list
  return store.set(svcMetadata.TIMEBLOCK_KEY, all, options) ? rule : null
}

function putBlock(all, key, norm) {
  const state = key === 'ideal' ? svcPlanningTemplates.read(all) : null
  const template = state?.items.find(item => item.id === state.activeId)
  const source = key === 'ideal' ? template.blocks : all[key]
  const list = (Array.isArray(source) ? source : []).map(normalizeBlockObject).filter(Boolean)
  const idx = list.findIndex(b => b.id === norm.id)
  if (idx >= 0) list[idx] = norm
  else list.push(norm)
  if (template) {
    template.blocks = list
    svcPlanningTemplates.write(all, state)
  } else all[key] = list
}

/** 日期移动、多日添加与重复规则转换以一次写入提交，保留弹窗原始基线。 */
svcTimeblocks.saveBlocksFromEditor = ({ origDate, previous, targetDates, block, repeat }, base) => {
  const all = readBlocksMap({ base })
  if (targetDates.includes('ideal') && !svcPlanningTemplates.active(all)) return false
  if (previous && (repeat || !targetDates.includes(origDate))) {
    all[origDate] = (all[origDate] || []).filter(item => item.id !== previous.id)
    if (!all[origDate].length) delete all[origDate]
  }
  if (repeat) {
    const rule = normalizeRepeatRule({ ...block, repeat, seriesId: svcMetadata.uid('tbs_') })
    if (!rule) return false
    all._repeats = [...(all._repeats || []), rule]
  } else {
    targetDates.forEach(date => putBlock(all, date, normalizeBlockObject({
      ...block, id: previous && date === origDate ? previous.id : svcMetadata.uid('tb_'),
    })))
  }
  return store.set(svcMetadata.TIMEBLOCK_KEY, all, { base })
}

svcTimeblocks.saveBlock = (dateStr, block, options) => {
  const norm = normalizeBlockObject(block)
  const key = storageDateOf(dateStr)
  if (!norm || !key) return null
  const all = readBlocksMap(options)
  if (key === 'ideal' && !svcPlanningTemplates.active(all)) return null
  if (key !== 'ideal' && norm.seriesId && Array.isArray(all._repeats)) {
    const rIdx = all._repeats.findIndex(r => r && r.seriesId === norm.seriesId)
    if (rIdx >= 0) {
      const rule = normalizeRepeatRule(all._repeats[rIdx])
      if (rule) {
        const mSet = new Set(rule.missedDates)
        if (norm.missed) mSet.add(key)
        else mSet.delete(key)
        rule.missedDates = [...mSet]
        all._repeats[rIdx] = rule
        return store.set(svcMetadata.TIMEBLOCK_KEY, all, options) ? norm : null
      }
    }
  }
  putBlock(all, key, norm)
  return store.set(svcMetadata.TIMEBLOCK_KEY, all, options) ? norm : null
}

svcTimeblocks.deleteBlock = (dateStr, blockId, options) => {
  const key = storageDateOf(dateStr)
  if (!key) return false
  const all = readBlocksMap(options)
  if (key === 'ideal') {
    const state = svcPlanningTemplates.read(all)
    const template = state.items.find(item => item.id === state.activeId)
    if (!template) return false
    template.blocks = template.blocks.filter(block => block.id !== blockId)
    return store.set(svcMetadata.TIMEBLOCK_KEY, svcPlanningTemplates.write(all, state), options)
  }
  if (key !== 'ideal' && Array.isArray(all._repeats)) {
    const rIdx = all._repeats.findIndex(r => r && (blockId === `${r.seriesId}_${key}` || blockId === r.seriesId))
    if (rIdx >= 0) {
      const rule = normalizeRepeatRule(all._repeats[rIdx])
      if (rule && !rule.excludedDates.includes(key)) {
        rule.excludedDates.push(key)
        all._repeats[rIdx] = rule
        return store.set(svcMetadata.TIMEBLOCK_KEY, all, options)
      }
    }
  }
  if (Array.isArray(all[key])) {
    all[key] = all[key].filter(b => b && b.id !== blockId)
    if (all[key].length === 0) delete all[key]
  }
  return store.set(svcMetadata.TIMEBLOCK_KEY, all, options)
}

/** 查找跨日/多日/重复同批次创建的关联时间块列表 */
svcTimeblocks.findSeriesBlocks = (seriesId) => {
  if (!seriesId || typeof seriesId !== 'string') return []
  const all = readBlocksMap()
  if (Array.isArray(all._repeats)) {
    const rule = all._repeats.map(normalizeRepeatRule).find(r => r && r.seriesId === seriesId)
    if (rule) {
      return [
        { dateStr: rule.repeat.baseDate, block: { ...rule, id: `${rule.seriesId}_${rule.repeat.baseDate}` } },
        { dateStr: 'repeat', block: { ...rule, id: `${rule.seriesId}_repeat` } },
      ]
    }
  }
  const matches = []
  Object.keys(all).sort().forEach(dateKey => {
    if (dateKey === 'ideal' || dateKey === '_repeats' || !Array.isArray(all[dateKey])) return
    all[dateKey].forEach(raw => {
      const b = normalizeBlockObject(raw)
      if (b && b.seriesId === seriesId) matches.push({ dateStr: dateKey, block: b })
    })
  })
  return matches
}

/** 删除跨日/多日/重复同批次的关联时间块（传入 fromDate 时仅删除该日期及以后），返回受影响的日期数组 */
svcTimeblocks.deleteSeriesBlocks = (seriesId, fromDate = '') => {
  if (!seriesId || typeof seriesId !== 'string') return []
  const all = readBlocksMap()
  if (Array.isArray(all._repeats)) {
    const rIdx = all._repeats.findIndex(r => r && r.seriesId === seriesId)
    if (rIdx >= 0) {
      const rule = normalizeRepeatRule(all._repeats[rIdx])
      if (!fromDate || !rule || fromDate <= rule.repeat.baseDate) {
        all._repeats.splice(rIdx, 1)
        if (all._repeats.length === 0) delete all._repeats
      } else {
        const prevDay = svcDates.dateKey(svcDates.addDays(svcDates.parseDateKey(fromDate), -1))
        rule.untilDate = prevDay
        all._repeats[rIdx] = rule
      }
      store.set(svcMetadata.TIMEBLOCK_KEY, all)
      return ['*']
    }
  }
  const affectedDates = []
  Object.keys(all).forEach(dateKey => {
    if (dateKey === 'ideal' || dateKey === '_repeats' || !Array.isArray(all[dateKey])) return
    if (fromDate && dateKey < fromDate) return
    const before = all[dateKey].length
    all[dateKey] = all[dateKey].filter(b => b && b.seriesId !== seriesId)
    if (all[dateKey].length !== before) affectedDates.push(dateKey)
    if (all[dateKey].length === 0) delete all[dateKey]
  })
  if (affectedDates.length > 0) store.set(svcMetadata.TIMEBLOCK_KEY, all)
  return affectedDates
}

/** 统一的重叠详情项过滤算法：被更长的块完整覆盖的块为详情项；其含义（拆分/并行）由使用者决定 */
svcTimeblocks.filterDetailBlocks = (blocks, showDetails = false) => {
  if (showDetails) return blocks
  return blocks.filter(b => !blocks.some(other => {
    if (other.id === b.id) return false
    if (other.startH <= b.startH && other.startH + other.durationH >= b.startH + b.durationH) {
      if (other.durationH === b.durationH && other.startH === b.startH) return other.id < b.id
      return other.durationH > b.durationH
    }
    return false
  }))
}
