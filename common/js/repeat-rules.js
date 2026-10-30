import { dates as svcDates } from './date-utils.js'

const svcRepeatRules = {}
export const repeatRules = svcRepeatRules

/** MAERS QLS — 重复规则匹配与自然语言描述。 */
const ISO_WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']

/** 判断给定 YYYY-MM-DD 是否命中重复规则（纯数据计算，供领域层与日历组件共用） */
svcRepeatRules.matchesRepeatRule = (repeat, dateStr, { untilDate = '', excludedDates = [] } = {}) => {
  if (!repeat || typeof repeat !== 'object' || !dateStr) return false
  const baseStr = repeat.baseDate
  if (!baseStr || dateStr < baseStr) return false
  if (untilDate && dateStr > untilDate) return false
  if (Array.isArray(excludedDates) && excludedDates.includes(dateStr)) return false

  const d0 = svcDates.parseDateKey(baseStr)
  const d1 = svcDates.parseDateKey(dateStr)
  if (!d0 || !d1) return false

  const interval = Math.max(1, Math.min(99, Number(repeat.interval) || 1))
  const unit = repeat.unit || 'day'

  if (unit === 'day') {
    const diffDays = Math.round((d1.getTime() - d0.getTime()) / 86400000)
    return diffDays >= 0 && diffDays % interval === 0
  }

  if (unit === 'week') {
    const isoDay = d1.getDay() === 0 ? 7 : d1.getDay()
    const weekDays = Array.isArray(repeat.weekDays) ? repeat.weekDays : []
    if (!weekDays.includes(isoDay)) return false
    const off0 = (d0.getDay() === 0 ? 7 : d0.getDay()) - 1
    const off1 = isoDay - 1
    const mon0 = svcDates.addDays(d0, -off0)
    const mon1 = svcDates.addDays(d1, -off1)
    const diffWeeks = Math.round((mon1.getTime() - mon0.getTime()) / (7 * 86400000))
    return diffWeeks >= 0 && diffWeeks % interval === 0
  }

  const dom = d1.getDate()
  const lastDom = new Date(d1.getFullYear(), d1.getMonth() + 1, 0).getDate()
  const monthDays = Array.isArray(repeat.monthDays) ? repeat.monthDays : []
  const dayMatched = monthDays.includes(dom) || (dom === lastDom && monthDays.includes('last'))

  if (unit === 'month') {
    const diffMonths = (d1.getFullYear() - d0.getFullYear()) * 12 + (d1.getMonth() - d0.getMonth())
    return diffMonths >= 0 && diffMonths % interval === 0 && dayMatched
  }

  if (unit === 'year') {
    const diffYears = d1.getFullYear() - d0.getFullYear()
    const yearMonths = Array.isArray(repeat.yearMonths) ? repeat.yearMonths : []
    return diffYears >= 0 && diffYears % interval === 0 && yearMonths.includes(d1.getMonth() + 1) && dayMatched
  }

  return false
}

function formatMonthDaysText(monthDays) {
  const nums = monthDays.filter(x => x !== 'last').map(Number).sort((a, b) => a - b).map(n => `${n}日`)
  if (monthDays.includes('last')) nums.push('最后一天')
  return nums.join('、')
}

/** 生成重复规则的自然语言描述 */
svcRepeatRules.formatRepeatSummary = (repeat) => {
  if (!repeat) return ''
  const n = Math.max(1, Math.min(99, Number(repeat.interval) || 1))
  const unit = repeat.unit || 'day'
  if (unit === 'day') return `事项将会每${n}天重复`
  if (unit === 'week') {
    const wText = [...(repeat.weekDays || [])].sort((a, b) => a - b).map(d => `周${ISO_WEEK_LABELS[d - 1]}`).join('、')
    return `事项将会每${n}周的${wText}重复`
  }
  if (unit === 'month') {
    return `事项将会每${n}月的${formatMonthDaysText(repeat.monthDays || [])}重复`
  }
  if (unit === 'year') {
    const mText = [...(repeat.yearMonths || [])].sort((a, b) => a - b).map(m => `${m}月`).join('、')
    return `事项将会每${n}年的${mText}的${formatMonthDaysText(repeat.monthDays || [])}重复`
  }
  return ''
}
