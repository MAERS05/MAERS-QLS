import { metadata as svcMetadata } from './core.js'
import { dates as svcDates } from './date-utils.js'
import { storage as svcStorage } from './store.js'

const svcDayRecords = {}
export const dayRecords = svcDayRecords

/**
 * MAERS QLS — 每日量化记录的公共数据契约 (common/js/day-record.js)
 * 职责：
 * 1. 唯一定义「单日量化记录」的数据结构、归一化与空记录判定，供 QuantiLife 领域层与跨系统桥接层共用；
 * 2. 唯一实现「事件 → 七大分类时长」汇总逻辑，避免桥接层与领域层各维护一套；
 * 3. 提供统一的保存入口：内容为空时删除对应键，避免残留空记录。
 * 本文件只处理数据，不涉及任何 DOM。
 */
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const nonNegative = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, n) : 0
}

/** 创建指定日期的空记录骨架 */
svcDayRecords.createEmptyDay = (dateStr) => ({
  date: dateStr,
  basics: { steps: 0, sleep: 0, water: 0 },
  diet: [],
  time: {},
  timeEvents: [],
  mood: null,
  moodNote: '',
})

/** 规范化单日记录；结构非法返回 null，未知字段原样保留 */
svcDayRecords.normalizeDayData = (data, fallbackDate = '') => {
  if (!isPlainObject(data)) return null
  const b = isPlainObject(data.basics) ? data.basics : {}
  const parsedDate = svcDates.parseDateKey(data.date) || svcDates.parseDateKey(fallbackDate)
  const rawTime = isPlainObject(data.time) ? data.time : {}
  const cleanTime = {}
  Object.entries(rawTime).forEach(([k, v]) => {
    if (svcMetadata.TIME_META[k]) cleanTime[k] = nonNegative(v)
  })

  const cleanDiet = Array.isArray(data.diet)
    ? data.diet.filter(isPlainObject).map(svcMetadata.normalizeDietItem)
    : []

  const cleanEvents = Array.isArray(data.timeEvents)
    ? data.timeEvents.filter(isPlainObject).map(ev => ({
        ...ev,
        name: String(ev.name || '未命名'),
        h: nonNegative(ev.h),
        tags: Array.isArray(ev.tags) ? ev.tags.map(t => String(t || '').trim()).filter(Boolean) : [],
        segments: Array.isArray(ev.segments)
          ? ev.segments.filter(isPlainObject).map(s => ({ startHm: String(s.startHm || ''), endHm: String(s.endHm || '') }))
          : undefined,
      }))
    : []

  return {
    ...data,
    date: parsedDate ? svcDates.dateKey(parsedDate) : '',
    basics: {
      steps: nonNegative(b.steps),
      sleep: nonNegative(b.sleep),
      water: nonNegative(b.water),
    },
    diet: cleanDiet,
    time: cleanTime,
    timeEvents: cleanEvents,
    mood: svcMetadata.MOOD_META[data.mood] ? data.mood : null,
    moodNote: typeof data.moodNote === 'string' ? data.moodNote : '',
  }
}

/** 单日记录是否不含任何有效内容 */
svcDayRecords.isDayDataEmpty = (data) => {
  const norm = svcDayRecords.normalizeDayData(data)
  if (!norm) return true
  const b = norm.basics
  return !(
    b.steps > 0 || b.sleep > 0 || b.water > 0 ||
    norm.diet.some(f => f.name.trim() !== '') ||
    norm.timeEvents.length > 0 ||
    Object.values(norm.time).some(v => v > 0) ||
    norm.mood ||
    norm.moodNote.trim() !== ''
  )
}

/**
 * 汇总事件在七大分类上的时长（同一事件含多个同类标签只计一次，跨类标签各计一次）。
 * tagMap：标签 → 分类 key 的标签库；decimals 为 null 时不做舍入，否则逐步舍入到指定小数位。
 */
svcDayRecords.computeTimeTotals = (events = [], tagMap = {}, { decimals = null } = {}) => {
  const totals = Object.fromEntries(svcMetadata.TIME_KEYS.map(k => [k, 0]))
  const scale = decimals == null ? null : 10 ** decimals
  ;(events || []).forEach(ev => {
    const hours = nonNegative(ev?.h)
    const cats = new Set((ev?.tags || []).map(tag => svcMetadata.resolveTagCategory(tag, tagMap)).filter(Boolean))
    cats.forEach(cat => {
      const next = totals[cat] + hours
      totals[cat] = scale == null ? next : Math.round(next * scale) / scale
    })
  })
  return totals
}

/** 保存单日记录；内容为空时删除对应键。返回写入是否成功 */
svcDayRecords.saveDayRecord = (data, options) => {
  const norm = svcDayRecords.normalizeDayData(data, data?.date)
  if (!norm || !norm.date) return false
  const key = svcMetadata.QL_PREFIX + norm.date
  return svcDayRecords.isDayDataEmpty(norm) ? svcStorage.store.remove(key, options) : svcStorage.store.set(key, norm, options)
}
