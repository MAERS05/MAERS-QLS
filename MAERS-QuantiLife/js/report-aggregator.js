import { records as svcRecords } from './records.js'
import { quantiTags as svcQuantiTags } from './tags.js'
import { timeStats as svcTimeStats } from './time-stats.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'

const svcReportAggregator = {}
export const reportAggregator = svcReportAggregator

/**
 * MAERS QuantiLife — 报告纯数据聚合引擎 (report-aggregator.js)
 * 负责：单日饮食汇总、时间段分桶聚合 (buildBuckets)、全量统计与单一/并行事项拆解 (totalAgg)
 */

const TIME_KEYS = svcMetadata.TIME_KEYS
const MOOD_META = svcMetadata.MOOD_META
const MOOD_KEYS = svcMetadata.MOOD_KEYS
const getDaysInRange = svcDates.getDaysInRange
const loadDayData = svcRecords.loadDayData

const sum = (arr) => arr.reduce((a, b) => a + b, 0)
const avg = (arr) => (arr.length ? sum(arr) / arr.length : 0)
const emptyMoods = () => Object.fromEntries(MOOD_KEYS.map(k => [k, 0]))

/** 计算单条记录的饮食汇总（loadDayData 已完成条目规范化） */
function dietTotals(data) {
  const items = data?.diet || []
  return {
    cal:     sum(items.map(f => f.cal)),
    carb:    sum(items.map(f => f.carb)),
    protein: sum(items.map(f => f.protein)),
    fat:     sum(items.map(f => f.fat)),
  }
}

/** 按指定精度构建分桶趋势序列与跨年标记 */
function buildBuckets(start, end, precision = 1) {
  const days = getDaysInRange(start, end)
  const buckets = []
  const spanYears = end.getFullYear() !== start.getFullYear()
  const spanMonths = spanYears || end.getMonth() !== start.getMonth()
  const fmtDate = (d) => (spanMonths ? `${d.getMonth() + 1}/${d.getDate()}` : `${d.getDate()}`)

  const yearMarkers = []
  let lastYearSeen = null

  for (let i = 0; i < days.length; i += precision) {
    const slice = days.slice(i, i + precision)
    const first = slice[0], last = slice[slice.length - 1]
    const yr = first.getFullYear()
    if (spanYears && yr !== lastYearSeen) {
      yearMarkers.push({ index: buckets.length, year: yr })
      lastYearSeen = yr
    }
    let label = fmtDate(first)
    if (precision > 1 && slice.length > 1) label += `~${last.getDate()}`

    const records = slice.map(d => loadDayData(d)).filter(Boolean)
    if (records.length === 0) {
      buckets.push({ label, recordDays: 0, time: {}, timePure: {}, timeFused: {}, moods: {} })
      continue
    }

    const diets = records.map(dietTotals)
    const moods = emptyMoods()
    records.forEach(r => { if (r.mood) moods[r.mood]++ })
    const moodScores = records.filter(r => r.mood).map(r => MOOD_META[r.mood].score)

    // 按 timeEvents 拆分各分类的单一/并行时长（每日独立统计，再取均值）
    const pureByDay  = records.map(r => Object.fromEntries(TIME_KEYS.map(k => [k, 0])))
    const fusedByDay = records.map(r => Object.fromEntries(TIME_KEYS.map(k => [k, 0])))
    records.forEach((r, ri) => {
      ;(r.timeEvents || []).forEach(ev => {
        const isFused = (ev.tags || []).length > 1 || !!ev._isParallel
        const cats = new Set((ev.tags || []).map(tag => svcQuantiTags.resolveTagCategory(tag)).filter(Boolean))
        cats.forEach(k => {
          if (isFused) fusedByDay[ri][k] = (fusedByDay[ri][k] || 0) + (ev.h || 0)
          else         pureByDay[ri][k]  = (pureByDay[ri][k]  || 0) + (ev.h || 0)
        })
      })
    })

    buckets.push({
      label,
      recordDays: records.length,
      moodScore: moodScores.length ? avg(moodScores) : null,
      steps:   avg(records.map(r => r.basics.steps)),
      sleep:   avg(records.map(r => r.basics.sleep)),
      water:   avg(records.map(r => r.basics.water)),
      cal:     avg(diets.map(d => d.cal)),
      carb:    avg(diets.map(d => d.carb)),
      protein: avg(diets.map(d => d.protein)),
      fat:     avg(diets.map(d => d.fat)),
      time:      Object.fromEntries(TIME_KEYS.map(k => [k, avg(records.map(r => r.time[k] || 0))])),
      timePure:  Object.fromEntries(TIME_KEYS.map(k => [k, avg(pureByDay.map(d => d[k] || 0))])),
      timeFused: Object.fromEntries(TIME_KEYS.map(k => [k, avg(fusedByDay.map(d => d[k] || 0))])),
      moods,
    })
  }
  return { buckets, yearMarkers }
}

/** 计算日期区间内的全量统计、大类与标签排行数据 */
function totalAgg(start, end) {
  const days = getDaysInRange(start, end)
  const totals = { steps: 0, sleep: 0, water: 0, cal: 0, carb: 0, protein: 0, fat: 0 }
  const timeSums = Object.fromEntries(TIME_KEYS.map(k => [k, 0]))
  const timeAgg = svcTimeStats.aggregateTimeEvents()
  const moods = emptyMoods()
  let recordDays = 0

  days.forEach(d => {
    const data = loadDayData(d)
    if (!data) return
    recordDays++
    totals.steps += data.basics.steps
    totals.sleep += data.basics.sleep
    totals.water += data.basics.water
    const dt = dietTotals(data)
    totals.cal += dt.cal
    totals.carb += dt.carb
    totals.protein += dt.protein
    totals.fat += dt.fat
    TIME_KEYS.forEach(k => { timeSums[k] += data.time[k] || 0 })
    if (data.mood) moods[data.mood]++

    svcTimeStats.aggregateTimeEvents(data.timeEvents, timeAgg, { date: data.date })
  })

  const perDay = (v) => (recordDays ? v / recordDays : 0)
  return {
    totalDays: days.length, recordDays, timeSums, moods,
    tagStats: timeAgg.tagStats,
    catStats: timeAgg.catStats,
    fusedEvents: timeAgg.fusedEvents,
    avgSteps:   perDay(totals.steps),
    avgSleep:   perDay(totals.sleep),
    avgWater:   perDay(totals.water),
    avgCal:     perDay(totals.cal),
    avgCarb:    perDay(totals.carb),
    avgProtein: perDay(totals.protein),
    avgFat:     perDay(totals.fat),
  }
}

svcReportAggregator.reportAggregator = { dietTotals, buildBuckets, totalAgg }
