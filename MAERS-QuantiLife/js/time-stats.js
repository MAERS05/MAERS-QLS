import { quantiTags as svcQuantiTags } from './tags.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dayRecords as svcDayRecords } from '../../common/js/day-record.js'

const svcTimeStats = {}
export const timeStats = svcTimeStats

/** MAERS QuantiLife — 时间事件统计、排行数据与并行组合计算。 */
// ── 时间事件统计与排行数据（供详情、报告聚合和排行视图共用）────
svcTimeStats.TIME_MODES = [
  { value: 'include', label: '包含并行' },
  { value: 'pure', label: '单一事项' },
  { value: 'only', label: '仅并行' },
]

const DISPLAY_H = { pure: s => s.pureH, include: s => s.pureH + s.fusedH, only: s => s.fusedH }
const eventCategories = (ev) => new Set((ev.tags || []).map(svcQuantiTags.resolveTagCategory).filter(Boolean))
const isFusedEvent = (ev) => (ev.tags || []).length > 1 || !!ev._isParallel
const emptyTimeStat = (extra = {}) => ({ pureH: 0, fusedH: 0, fusedDetails: [], ...extra })

function addEventToStat(stat, ev, isFused) {
  const h = ev.h || 0
  if (isFused) {
    stat.fusedH += h
    stat.fusedDetails.push({ name: ev.name, h, tags: ev.tags })
  } else {
    stat.pureH += h
  }
}

/** 计算各分类汇总时长（区分单一与并行事项） */
svcTimeStats.computeTimeCategoryTotals = (events = []) => {
  const totals = Object.fromEntries(svcMetadata.TIME_KEYS.map(k => [k, { pure: 0, fused: 0 }]))
  events.forEach(ev => {
    const field = isFusedEvent(ev) ? 'fused' : 'pure'
    eventCategories(ev).forEach(k => { totals[k][field] += ev.h || 0 })
  })
  return totals
}

/** 计算分类总时长映射（单一与并行合计） */
svcTimeStats.computeTimeCategorySumMap = (events = []) => svcDayRecords.computeTimeTotals(events, svcQuantiTags.TAG_META)

/**
 * 聚合时间事件列表，生成或累加 { catStats, tagStats, fusedEvents }。
 * 供单日详情面板 (time-detail.js) 与多日区间报告 (report-aggregator.js) 统一复用。
 */
svcTimeStats.aggregateTimeEvents = (events = [], target = null, meta = {}) => {
  const acc = target || {
    catStats: Object.fromEntries(svcMetadata.TIME_KEYS.map(k => [k, emptyTimeStat()])),
    tagStats: {},
    fusedEvents: [],
  }
  events.forEach(ev => {
    const tags = ev.tags || []
    const isFused = isFusedEvent(ev)
    const catsInEvent = new Set()
    tags.forEach(tag => {
      const cat = svcQuantiTags.resolveTagCategory(tag) || 'basic'
      catsInEvent.add(cat)
      const labelKey = svcMetadata.TIME_META[tag]?.label || tag
      if (!acc.tagStats[labelKey]) acc.tagStats[labelKey] = emptyTimeStat({ cat })
      addEventToStat(acc.tagStats[labelKey], ev, isFused)
    })
    catsInEvent.forEach(cat => addEventToStat(acc.catStats[cat], ev, isFused))
    if (isFused && catsInEvent.size > 0) {
      acc.fusedEvents.push({
        ...meta,
        name: ev.name,
        h: ev.h || 0,
        tags: [...tags],
        cats: svcMetadata.TIME_KEYS.filter(cat => catsInEvent.has(cat)),
      })
    }
  })
  return acc
}

/** 构建排行列表：大类模式按分类聚合，下钻模式只显示当前分类的标签 */
function buildRankList(agg, categoryContext = 'all', timeMode = 'include') {
  const isCatMode = categoryContext === 'all'
  const statsObj = (isCatMode ? agg?.catStats : agg?.tagStats) || {}
  const pick = DISPLAY_H[timeMode] || DISPLAY_H.include
  return Object.entries(statsObj)
    .map(([key, stat]) => {
      const cat = isCatMode ? key : (svcQuantiTags.resolveTagCategory(key) || stat.cat)
      if (!isCatMode && cat !== categoryContext) return null
      return { key, cat, label: svcMetadata.TIME_META[key]?.label || key, ...stat, displayH: pick(stat) }
    })
    .filter(item => item && item.displayH > 0)
    .sort((a, b) => b.displayH - a.displayH)
}

function categoryPartsFor(event) {
  const parts = (event.tags || []).map(tag => svcQuantiTags.resolveTagCategory(tag)).filter(Boolean)
  // 单标签但被标记为并行，表示同类任务彼此并行，也要明确显示“分类 + 分类”。
  if (parts.length === 1) parts.push(parts[0])
  return parts.sort((a, b) => svcMetadata.TIME_KEYS.indexOf(a) - svcMetadata.TIME_KEYS.indexOf(b))
}

/** “仅并行”按分类组合或标签组合聚合；组合本身也可继续查看标签详情。 */
function buildParallelCombinations(agg, kind, categoryFilter = null, categoryComboKey = null) {
  const groups = new Map()
  ;(agg?.fusedEvents || []).forEach(event => {
    const categoryParts = categoryPartsFor(event)
    const eventCategoryKey = categoryParts.join(' + ')
    if (categoryFilter && !categoryParts.includes(categoryFilter)) return
    if (categoryComboKey && eventCategoryKey !== categoryComboKey) return
    const parts = kind === 'category'
      ? categoryParts
      : [...new Set((event.tags || []).map(tag => String(tag).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    if (parts.length === 0) return
    if (kind === 'tag' && parts.length === 1) parts.push(parts[0])
    const key = parts.join(' + ')
    const label = kind === 'category'
      ? parts.map(cat => svcMetadata.TIME_META[cat]?.label || cat).join(' + ')
      : key
    if (!groups.has(key)) groups.set(key, {
      key,
      label,
      categoryParts: kind === 'category' ? [...parts] : null,
      tagParts: kind === 'tag' ? [...parts] : null,
      h: 0,
      cats: [...new Set(categoryParts)],
    })
    const group = groups.get(key)
    group.h += event.h
  })
  return [...groups.values()].sort((a, b) => b.h - a.h || a.label.localeCompare(b.label, 'zh-CN'))
}

svcTimeStats.timeStats = { buildRankList, buildParallelCombinations }
