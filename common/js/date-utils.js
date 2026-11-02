import { metadata as svcMetadata } from './core.js'

const svcDates = {}
export const dates = svcDates

/** MAERS QLS — 本地日期、时钟、累计时长与计时分段工具。 */
// ── 7. 日期与时钟工具 ─────────────────────────────────
svcDates.pad2 = (n) => String(n).padStart(2, '0')

svcDates.dateKey = (d) => `${d.getFullYear()}-${svcDates.pad2(d.getMonth() + 1)}-${svcDates.pad2(d.getDate())}`
svcDates.today = () => svcDates.dateKey(new Date())

/**
 * 按本地时区严格解析 YYYY-M-D / YYYY-MM-DD；拒绝 2026-02-31 这类会被 Date 自动进位的脏值。
 * 避免 new Date("YYYY-MM-DD") 按 UTC 解析导致负偏移时区回退一天。
 */
svcDates.parseDateKey = (value) => {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : new Date(value.getFullYear(), value.getMonth(), value.getDate())
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? date : null
}
svcDates.isDateKey = (value) => svcDates.parseDateKey(value) !== null

/** 标准化为 YYYY-MM-DD；无效日期统一返回空串 */
svcDates.normalizeDateKey = (value) => {
  const date = svcDates.parseDateKey(value)
  return date ? svcDates.dateKey(date) : ''
}

/** 只接受 00:00–23:59 与作为结束边界的 24:00 */
svcDates.parseClock = (value) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return null
  return { hours, minutes, value: svcDates.toClock(hours, minutes) }
}

svcDates.toClock = (h, m) => `${svcDates.pad2(h)}:${svcDates.pad2(m)}`

/** "HH:MM" → 浮点小时；非法值返回 0 */
svcDates.clockToHours = (value) => {
  const clock = svcDates.parseClock(value)
  return clock ? clock.hours + clock.minutes / 60 : 0
}

/** 浮点小时 → "HH:MM"（分钟级四舍五入，限定在 00:00–24:00） */
svcDates.fmtClock = (h) => {
  const totalMinutes = svcMetadata.clamp(Math.round((Number(h) || 0) * 60), 0, 24 * 60)
  return svcDates.toClock(Math.floor(totalMinutes / 60), totalMinutes % 60)
}

/** 累计时长与日内时钟分开处理，小时数可超过 24。 */
svcDates.fmtDuration = (hours) => {
  const minutes = Math.max(0, Math.round((Number(hours) || 0) * 60))
  return svcDates.toClock(Math.floor(minutes / 60), minutes % 60)
}
svcDates.parseDuration = (value) => {
  const match = /^(\d+):([0-5]\d)$/.exec(String(value ?? '').trim())
  if (!match) return null
  const minutes = Number(match[1]) * 60 + Number(match[2])
  return Number.isSafeInteger(minutes) ? minutes / 60 : null
}

/** 手动段保留自己的起止日期；旧段优先从原时间戳取日期，最后才回退任务日期。 */
svcDates.timerSegmentBounds = (segment, fallbackDate) => {
  if (!segment.manualEdited && segment.startAt != null && segment.endAt != null) {
    return { startAt: Number(segment.startAt), endAt: Number(segment.endAt) }
  }
  const dateOf = (value, clock) => {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) return ''
    const date = new Date(Number(value))
    return svcDates.dateKey(clock === '24:00' ? svcDates.addDays(date, -1) : date)
  }
  const startDate = svcDates.normalizeDateKey(segment.date) || dateOf(segment.startAt, segment.startHm) || fallbackDate
  const endDate = svcDates.normalizeDateKey(segment.endDate) || dateOf(segment.endAt, segment.endHm) || startDate
  const startDay = svcDates.parseDateKey(startDate), endDay = svcDates.parseDateKey(endDate)
  if (!startDay || !endDay) return null
  const atClock = (day, clock) => {
    const parsed = svcDates.parseClock(clock)
    if (!parsed) return null
    const value = new Date(day)
    value.setHours(parsed.hours, parsed.minutes, 0, 0)
    return value.getTime()
  }
  const startAt = atClock(startDay, segment.startHm)
  let endAt = atClock(endDay, segment.endHm)
  if (startAt == null || endAt == null) return null
  if (endAt < startAt) endAt = atClock(svcDates.addDays(startDay, 1), segment.endHm)
  return { startAt, endAt }
}

svcDates.nowHm = (d = new Date()) => svcDates.toClock(d.getHours(), d.getMinutes())

svcDates.addDays = (d, n) => {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

svcDates.getDaysInRange = (start, end) => {
  const days = []
  let d = new Date(start)
  while (d <= end) {
    days.push(new Date(d))
    d = svcDates.addDays(d, 1)
  }
  return days
}

svcDates.formatDate = (dateStr) => {
  const d = svcDates.parseDateKey(dateStr)
  return d ? `${d.getMonth() + 1}月${d.getDate()}日` : ''
}

const WEEK_DAYS = ['日', '一', '二', '三', '四', '五', '六']
svcDates.WEEK_DAYS = WEEK_DAYS
svcDates.formatDateCN = (d) => {
  const dt = d instanceof Date ? d : svcDates.parseDateKey(d)
  if (!dt || isNaN(dt.getTime())) return ''
  return `${dt.getFullYear()}年${dt.getMonth() + 1}月${dt.getDate()}日 周${WEEK_DAYS[dt.getDay()]}`
}

svcDates.isOverdue = (dateStr) => {
  const date = svcDates.parseDateKey(dateStr)
  const today = svcDates.parseDateKey(svcDates.today())
  return !!date && !!today && date < today
}

svcDates.fmtH = (h) => {
  if (!h || h <= 0) return '0m'
  const totalMinutes = Math.round(Number(h) * 60)
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60
  if (hours === 0) return `${mins}m`
  if (mins === 0) return `${hours}h`
  return `${hours}h${mins}m`
}
