import { scheduleMetadata as svcScheduleMetadata } from './shared.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'

const svcScheduleModels = {}
export const scheduleModels = svcScheduleModels

/** MAERS Schedule — 任务、愿景、时间块与计时数据的归一化契约。 */
function normalizeTaskObject(t) {
  if (!t || typeof t !== 'object') return null
  const title = typeof t.title === 'string' ? t.title.trim() : ''
  if (!title) return null
  return {
    ...t,
    id: String(t.id || svcMetadata.uid()),
    title,
    status: t.status === 'done' ? 'done' : 'active',
    tier: t.tier === 'mid' ? 'mid' : 'short',
    quadrant: svcScheduleMetadata.QUADRANT_KEYS.includes(t.quadrant) ? t.quadrant : 'do',
    startDate: svcDates.normalizeDateKey(t.startDate),
    deadline: svcDates.normalizeDateKey(t.deadline),
    notes: typeof t.notes === 'string' ? t.notes : '',
    subtasks: Array.isArray(t.subtasks)
      ? t.subtasks
          .filter(s => s && typeof s === 'object' && typeof s.text === 'string' && s.text.trim())
          .map(s => ({ text: s.text.trim(), done: !!s.done }))
      : [],
  }
}

function normalizeGoalObject(g) {
  if (!g || typeof g !== 'object') return null
  const title = typeof g.title === 'string' ? g.title.trim() : ''
  if (!title) return null
  return {
    ...g,
    id: String(g.id || svcMetadata.uid('g_')),
    title,
    notes: typeof g.notes === 'string' ? g.notes : '',
  }
}

function normalizeBlockObject(b) {
  if (!b || typeof b !== 'object') return null
  const label = typeof b.label === 'string' ? b.label.trim() : ''
  if (!label) return null
  const startH = Number(b.startH)
  const durationH = Number(b.durationH)
  const seriesId = typeof b.seriesId === 'string' && b.seriesId.trim() ? b.seriesId.trim() : ''
  return {
    ...svcMetadata.stripLegacyColor(b),
    id: String(b.id || svcMetadata.uid('tb_')),
    label,
    startH: Number.isFinite(startH) ? svcMetadata.clamp(Math.round(startH * 60), 0, 1439) / 60 : 9,
    durationH: Number.isFinite(durationH) && durationH > 0 ? Math.min(24, durationH) : 1,
    missed: !!b.missed,
    notes: typeof b.notes === 'string' ? b.notes : '',
    ...(seriesId ? { seriesId } : {}),
  }
}

function normalizeRepeatRule(r) {
  if (!r || typeof r !== 'object' || !r.repeat || typeof r.repeat !== 'object') return null
  const base = normalizeBlockObject(r)
  const baseDate = svcDates.normalizeDateKey(r.repeat.baseDate)
  if (!base || !baseDate) return null
  const seriesId = base.seriesId || svcMetadata.uid('tbs_')
  return {
    seriesId,
    label: base.label,
    startH: base.startH,
    durationH: base.durationH,
    category: base.category,
    notes: base.notes,
    repeat: {
      unit: ['day', 'week', 'month', 'year'].includes(r.repeat.unit) ? r.repeat.unit : 'day',
      interval: Math.max(1, Math.min(99, Number(r.repeat.interval) || 1)),
      baseDate,
      weekDays: Array.isArray(r.repeat.weekDays) ? r.repeat.weekDays.map(Number).filter(n => n >= 1 && n <= 7) : [],
      monthDays: Array.isArray(r.repeat.monthDays) ? r.repeat.monthDays.map(x => x === 'last' ? 'last' : Number(x)).filter(x => x === 'last' || (x >= 1 && x <= 31)) : [],
      yearMonths: Array.isArray(r.repeat.yearMonths) ? r.repeat.yearMonths.map(Number).filter(n => n >= 1 && n <= 12) : [],
    },
    untilDate: svcDates.normalizeDateKey(r.untilDate) || '',
    excludedDates: Array.isArray(r.excludedDates) ? r.excludedDates.map(d => svcDates.normalizeDateKey(d)).filter(Boolean) : [],
    missedDates: Array.isArray(r.missedDates) ? r.missedDates.map(d => svcDates.normalizeDateKey(d)).filter(Boolean) : [],
  }
}

function storageDateOf(dateStr) {
  return dateStr === 'ideal' ? 'ideal' : svcDates.normalizeDateKey(dateStr)
}

function normalizeTimerSegment(segment) {
  if (!segment || typeof segment !== 'object') return null
  const startAt = Number(segment.startAt)
  const endAt = Number(segment.endAt)
  const hasStartAt = Number.isFinite(startAt) && startAt > 0
  const hasEndAt = Number.isFinite(endAt) && endAt > 0
  if (hasStartAt && hasEndAt && endAt < startAt) return null

  const startClock = svcDates.parseClock(segment.startHm)
  const endClock = svcDates.parseClock(segment.endHm)
  if (!hasStartAt && !startClock) return null

  return {
    ...segment,
    startAt: hasStartAt ? startAt : null,
    endAt: hasEndAt ? endAt : null,
    startHm: startClock ? startClock.value : '',
    endHm: endClock ? endClock.value : null,
    manualEdited: !!segment.manualEdited,
  }
}

function normalizeInProgressItem(t) {
  if (!t || typeof t !== 'object') return null
  const title = typeof t.title === 'string' ? t.title.trim() : ''
  if (!title || (t.finalHours != null && (!Number.isFinite(Number(t.finalHours)) || Number(t.finalHours) < 0 || Number(t.finalHours) > svcMetadata.MAX_TIMER_HOURS))) return null
  return {
    ...svcMetadata.stripLegacyColor(t),
    id: String(t.id || svcMetadata.uid('ip_')),
    title,
    tags: Array.isArray(t.tags) ? t.tags.map(s => String(s || '').trim()).filter(Boolean) : [],
    mood: svcMetadata.MOOD_META[t.mood] ? t.mood : null,
    status: ['running', 'paused', 'completed'].includes(t.status) ? t.status : 'paused',
    segments: Array.isArray(t.segments) ? t.segments.map(normalizeTimerSegment).filter(Boolean) : [],
  }
}

svcScheduleModels.models = { normalizeTaskObject, normalizeGoalObject, normalizeBlockObject, normalizeRepeatRule, storageDateOf, normalizeTimerSegment, normalizeInProgressItem }
