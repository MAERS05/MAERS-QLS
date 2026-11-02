import { scheduleModels as svcScheduleModels } from './models.js'
import { scheduleMetadata as svcScheduleMetadata } from './shared.js'
import { scheduleTags as svcScheduleTags } from './tags.js'
import { bridge as svcBridge } from '../../common/js/bridge.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { storage as svcStorage } from '../../common/js/store.js'

const svcTimers = {}
export const timers = svcTimers

/** MAERS Schedule — 计时工具、进行中任务生命周期与入账协调。 */
const store = svcStorage.store
const { normalizeInProgressItem } = svcScheduleModels.models

// ── 计时工具 ──────────────────────────────────────────
/** 将毫秒数格式化为实时计时器文本 "HH:MM:SS" */
svcTimers.fmtDurationSec = (ms) => {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  return `${svcDates.pad2(h)}:${svcDates.pad2(m)}:${svcDates.pad2(totalSec % 60)}`
}

/** 计算单个计时分段的小时数（兼容实时时间戳与手动调整后的起止时间） */
svcTimers.calcSegmentHours = (seg, nowMs = Date.now()) => {
  if (!seg) return 0
  if ((seg.manualEdited || seg.startAt == null) && seg.startHm && seg.endHm) {
    const bounds = svcDates.timerSegmentBounds(seg, svcDates.today())
    if (bounds) return Math.max(0, (bounds.endAt - bounds.startAt) / 3600000)
    let diff = svcDates.clockToHours(seg.endHm) - svcDates.clockToHours(seg.startHm)
    if (diff < 0) diff += 24
    return Math.max(0, diff)
  }
  const start = seg.startAt || nowMs
  const end   = seg.endAt != null ? seg.endAt : nowMs
  return Math.max(0, (end - start) / 3600000)
}

/** 汇总多个计时分段的总小时数 */
svcTimers.calcSegmentsTotalHours = (segments, nowMs = Date.now()) =>
  Array.isArray(segments) ? segments.reduce((sum, seg) => sum + svcTimers.calcSegmentHours(seg, nowMs), 0) : 0

function readArray(key) {
  const list = store.get(key, [])
  return Array.isArray(list) ? list : []
}

function cleanTagList(tags) {
  return Array.isArray(tags) ? tags.map(s => String(s).trim()).filter(Boolean) : []
}


function syncToQuantiLife(dateStr, list, changedTasks) {
  // IndexedDB 在任务提交事务内同步日记录，不能再拆成独立的后续写入。
  if (store.mode === 'indexeddb') return
  svcBridge?.syncDayFromSchedule(dateStr, list, changedTasks)
}

svcTimers.loadInProgressTasks = () => readArray(svcMetadata.INPROGRESS_KEY).map(normalizeInProgressItem).filter(Boolean)

let runningVersion, runningTasks = []
svcTimers.loadRunningTasks = () => {
  const version = store.version(svcMetadata.INPROGRESS_KEY)
  if (version !== runningVersion) {
    runningTasks = svcTimers.loadInProgressTasks().filter(task => task.status === 'running')
    runningVersion = version
  }
  return runningTasks
}

svcTimers.saveInProgressTasks = (list, options) => {
  return store.set(svcMetadata.INPROGRESS_KEY, (Array.isArray(list) ? list : []).map(normalizeInProgressItem).filter(Boolean), options)
}

svcTimers.loadTimerEditor = () => {
  const base = store.getCommitted(svcMetadata.INPROGRESS_KEY, null)
  return { base, items: (Array.isArray(base) ? base : []).map(normalizeInProgressItem).filter(Boolean) }
}

/** 新建并启动一个进行中计时任务（任务名称与标签完全解耦，留空标签则仅本地计时） */
svcTimers.startInProgressTask = ({ title, category, tags, now = Date.now() }) => {
  const catObj = svcScheduleMetadata.categoryMeta(category)
  const cleanTags = cleanTagList(tags)
  cleanTags.forEach(tag => svcScheduleTags.registerNewTag(tag, catObj.key))

  const newTask = {
    id: svcMetadata.uid('ip_'),
    title: String(title || '').trim() || '未命名',
    category: catObj.key,
    tags: cleanTags,
    status: 'running',
    date: svcDates.dateKey(new Date(now)),
    createdAt: now,
    segments: [{ startAt: now, endAt: null, startHm: svcDates.nowHm(new Date(now)), endHm: null }],
  }

  const list = svcTimers.loadInProgressTasks()
  list.unshift(newTask)
  svcTimers.saveInProgressTasks(list)
  return newTask
}

function closeOpenSegment(task, now) {
  const lastSeg = task.segments[task.segments.length - 1]
  if (lastSeg && lastSeg.endAt == null) {
    lastSeg.endAt = now
    lastSeg.endHm = svcDates.nowHm(new Date(now))
  }
}

/** 暂停正在计时的任务，闭合当前时间段 */
svcTimers.pauseInProgressTask = (taskId, now = Date.now()) => {
  const list = svcTimers.loadInProgressTasks()
  const task = list.find(t => t.id === taskId)
  if (!task || task.status !== 'running') return null
  closeOpenSegment(task, now)
  task.status = 'paused'
  svcTimers.saveInProgressTasks(list)
  return task
}

/** 继续已暂停的任务，开启新的时间段 */
svcTimers.resumeInProgressTask = (taskId, now = Date.now()) => {
  const list = svcTimers.loadInProgressTasks()
  const task = list.find(t => t.id === taskId)
  if (!task || task.status !== 'paused') return null
  task.segments.push({ startAt: now, endAt: null, startHm: svcDates.nowHm(new Date(now)), endHm: null })
  task.status = 'running'
  svcTimers.saveInProgressTasks(list)
  return task
}

/** 结束任务计时；若存在联动标签则通过扫描线引擎自动切分重叠/独立时段并同步至 QuantiLife */
svcTimers.finishInProgressTask = (taskId, now = Date.now()) => {
  const list = svcTimers.loadInProgressTasks()
  const task = list.find(t => t.id === taskId)
  if (!task) return null
  const before = { ...task }

  if (task.status === 'running') closeOpenSegment(task, now)
  task.finalHours = Math.round(Math.max(svcTimers.calcSegmentsTotalHours(task.segments, now), 1 / 60) * 100) / 100
  task.status = 'completed'
  task.completedAt = now
  if (!task.date) task.date = svcDates.today()

  svcTimers.saveInProgressTasks(list)
  if (task.tags.length > 0) syncToQuantiLife(task.date, list, [before, task])
  return task
}

/** 编辑非计时状态下任务的元信息（名称、分类颜色、联动标签）；若任务已结束则重新同步 QuantiLife */
svcTimers.updateInProgressTask = (taskId, { title, category, tags }, options) => {
  const list = options && Object.hasOwn(options, 'base')
    ? JSON.parse(JSON.stringify(options.base || [])) : svcTimers.loadInProgressTasks()
  const task = list.find(t => t.id === taskId)
  if (!task || task.status === 'running') return null
  const before = { ...task }

  const catObj = svcScheduleMetadata.categoryMeta(category || task.category)
  const cleanTags = cleanTagList(tags)
  cleanTags.forEach(tag => svcScheduleTags.registerNewTag(tag, catObj.key))

  task.title = String(title || '').trim() || task.title
  task.category = catObj.key
  task.tags = cleanTags

  if (!svcTimers.saveInProgressTasks(list, options)) return null
  if (task.status === 'completed') {
    syncToQuantiLife(task.date || svcDates.today(), list, [before, task])
  }
  return task
}

/** 调整已结束任务的分段起止时间或最终时长；重新切分当日重叠/独立时段并同步至 QuantiLife */
svcTimers.settleInProgressTask = (taskId, { title, tags, segments, finalHours }, options) => {
  if (!Number.isFinite(Number(finalHours)) || Number(finalHours) < 0 || Number(finalHours) > svcMetadata.MAX_TIMER_HOURS) return null
  const list = options && Object.hasOwn(options, 'base')
    ? JSON.parse(JSON.stringify(options.base || [])) : svcTimers.loadInProgressTasks()
  const task = list.find(t => t.id === taskId)
  if (!task) return null
  const before = { ...task }

  const catObj = svcScheduleMetadata.categoryMeta(task.category)
  const cleanTags = cleanTagList(tags)
  cleanTags.forEach(tag => svcScheduleTags.registerNewTag(tag, catObj.key))

  task.title = String(title || '').trim() || task.title
  task.tags = cleanTags
  if (Array.isArray(segments)) task.segments = segments
  task.finalHours = Math.round(Math.max(0, Number(finalHours) || 0) * 100) / 100
  task.status = 'completed'
  if (!task.completedAt) task.completedAt = Date.now()
  if (!task.date) task.date = svcDates.today()

  if (!svcTimers.saveInProgressTasks(list, options)) return null
  syncToQuantiLife(task.date, list, [before, task])
  return task
}

/** 放弃未完成的计时任务（不计入量化） */
svcTimers.abandonInProgressTask = (taskId) => {
  svcTimers.saveInProgressTasks(svcTimers.loadInProgressTasks().filter(t => t.id !== taskId))
}

/** 删除已结束的计时任务并重新同步 QuantiLife 当日记录 */
svcTimers.deleteInProgressTask = (taskId) => {
  const list = svcTimers.loadInProgressTasks()
  const task = list.find(t => t.id === taskId)
  const remaining = list.filter(t => t.id !== taskId)
  svcTimers.saveInProgressTasks(remaining)
  if (task) syncToQuantiLife(task.date || svcDates.today(), remaining, [task])
}

/** 设置已结束任务的展示心情（仅保存在任务卡片供展示，不影响 QuantiLife 每日心情） */
svcTimers.setInProgressTaskMood = (taskId, mood) => {
  const list = svcTimers.loadInProgressTasks()
  const task = list.find(t => t.id === taskId)
  if (!task) return null
  task.mood = svcMetadata.MOOD_META[mood] ? mood : null
  svcTimers.saveInProgressTasks(list)
  return task
}
