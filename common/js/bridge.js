import { metadata as svcMetadata } from './core.js'
import { dates as svcDates } from './date-utils.js'
import { dayRecords as svcDayRecords } from './day-record.js'
import { storage as svcStorage } from './store.js'
import { tagRepository as svcTagRepository } from './tag-store.js'
import { timerProjection as svcTimerProjection } from './timer-events.js'

const svcBridge = {}
export const bridge = svcBridge

/**
 * MAERS QLS — 跨系统数据桥接层 (common/js/bridge.js)
 * 职责（纯数据层，不接触 DOM；界面见 bridge-ui.js）：
 * 1. 将 MAERS-Schedule「进行中」板块完成的计时任务同步写入 MAERS-QuantiLife 当日量化记录与今日记录浮窗；
 * 2. 支持对已同步的计时任务再次调整各段起止时间或总时长，并实时回写 QuantiLife；
 * 3. 将 MAERS-Schedule 规划表的「期望」列（ideal）一键同步至 MAERS-QuantiLife 期望设定面板。
 */
const store = svcStorage.store

const Bridge = {
  // ── 读取与写入 QuantiLife 标签与事件 ──────────────────
  getQLTags() {
    return svcTagRepository.tagStore.load()
  },

  saveQLTags(tags) {
    return svcTagRepository.tagStore.save(tags)
  },

  getQLEvents(dateStr) {
    const d = store.get(svcMetadata.QL_PREFIX + dateStr, null)
    return Array.isArray(d?.timeEvents) ? d.timeEvents : []
  },

  /** 通知界面层某日摘要已变化（界面层通过 QLS.BRIDGE_CHANGED_EVENT 订阅） */
  _notifyChanged(dateStr) {
    svcStorage.emit(svcMetadata.BRIDGE_CHANGED_EVENT, { dateStr })
  },

  /** 重新汇总某日 QuantiLife 数据的七大类时长 */
  _recomputeTotals(qlData) {
    qlData.time = svcDayRecords.computeTimeTotals(qlData.timeEvents, this.getQLTags(), { decimals: 2 })
  },

  /** 保存或清理某日 QuantiLife 数据（空记录自动删除对应键） */
  _persistDayData(dateStr, qlData) {
    this._recomputeTotals(qlData)
    if (!qlData.date) qlData.date = dateStr
    svcDayRecords.saveDayRecord(qlData, { syncSchedule: true })
    this._notifyChanged(dateStr)
  },

  /** 根据 Schedule 已完成任务，自动拆分跨午夜与并行重叠时段并同步至涉及的各个自然日 */
  syncDayFromSchedule(dateStr, allInProgressTasks = null, changedTasks = null) {
    if (!dateStr) return false
    const list = Array.isArray(allInProgressTasks) ? allInProgressTasks : store.get(svcMetadata.INPROGRESS_KEY, [])
    if (!Array.isArray(list)) return false
    const index = svcTimerProjection.timerEvents.buildTaskDayIndex(list)
    const affectedDates = new Set([dateStr])
    if (changedTasks === null) index.forEach((_, date) => affectedDates.add(date))
    // 变更前、后的覆盖日取并集；删除、缩短和移除标签均能清理原日期。
    ;(changedTasks || []).forEach((t, idx) => {
      svcTimerProjection.timerEvents.extractTaskDayIntervals(t, idx).forEach(it => affectedDates.add(it.dateStr))
    })

    affectedDates.forEach(dStr => {
      if (!dStr) return
      const qlKey = svcMetadata.QL_PREFIX + dStr
      const stored = store.get(qlKey, null)
      const syncedEvents = svcTimerProjection.timerEvents.sliceParallelTasksToEvents(list, dStr, index)

      if (!stored && syncedEvents.length === 0) {
        if (dStr === dateStr) this._notifyChanged(dStr)
        return
      }

      const qlData = stored && typeof stored === 'object' ? stored : svcDayRecords.createEmptyDay(dStr)
      const manualEvents = (Array.isArray(qlData.timeEvents) ? qlData.timeEvents : []).filter(e => !e._isSync)
      qlData.timeEvents = [...manualEvents, ...syncedEvents]

      this._persistDayData(dStr, qlData)
    })
    return true
  },

  // ── 方向 2：Schedule 期望列 (ideal) 同步 → QuantiLife 期望面板 ──
  syncIdealToQLExpectations(exp) {
    if (!exp || typeof exp !== 'object') return false
    const all = store.get(svcMetadata.TIMEBLOCK_KEY, {}) || {}
    const ideal = Array.isArray(all.ideal) ? all.ideal : []
    if (!exp.time || typeof exp.time !== 'object') exp.time = {}

    const hadPriorTimeExp = svcMetadata.TIME_KEYS.some(k => {
      const cur = exp.time[k]
      return !!cur && (Number(cur.hours) > 0 || (Array.isArray(cur.items) && cur.items.length > 0))
    })

    // 无论期望列是否为空，先清空旧的时间分配期望，避免删除全部期望块后残留旧数据
    svcMetadata.TIME_KEYS.forEach(k => { exp.time[k] = { hours: 0, items: [] } })
    if (!ideal.length) return hadPriorTimeExp

    ideal.forEach(b => {
      const cat = b.category
      if (!svcMetadata.TIME_META[cat] || !b.durationH) return
      exp.time[cat].hours += b.durationH
      exp.time[cat].items.push({ label: b.label || '', hours: Math.round(b.durationH * 100) / 100 })
    })
    svcMetadata.TIME_KEYS.forEach(k => {
      exp.time[k].hours = Math.round(exp.time[k].hours * 100) / 100
    })
    return true
  },

  // ── Bridge 今日量化记录摘要 ──────────────────────────
  getTodayBridge(dateStr) {
    const tagHours = {}
    this.getQLEvents(dateStr).forEach(ev => {
      ;(ev.tags || []).forEach(tag => {
        tagHours[tag] = (tagHours[tag] || 0) + (ev.h || 0)
      })
    })
    return Object.entries(tagHours).map(([tag, hours]) => ({
      tag,
      hours: Math.round(hours * 100) / 100,
      fmtHours: svcDates.fmtH(hours),
    }))
  },

  /** 记录用户已查看某日摘要（用于界面红点） */
  markViewed(dateStr) {
    store.set(svcMetadata.BRIDGE_VIEWED_PREFIX + dateStr, this.getTodayBridge(dateStr))
  },

  /** 某日摘要自上次查看后是否未变化 */
  isViewed(dateStr, bridge) {
    return JSON.stringify(store.get(svcMetadata.BRIDGE_VIEWED_PREFIX + dateStr, null)) === JSON.stringify(bridge)
  },

}

Object.assign(svcBridge, Bridge)
