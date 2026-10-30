import { metadata as svcMetadata } from './core.js'
import { dates as svcDates } from './date-utils.js'

const svcTimerProjection = {}
export const timerProjection = svcTimerProjection

/** MAERS QLS — 计时分段跨日与并行事件投影；不读写存储或页面状态。 */
const EPS = 1e-6
const timerEvents = {
  /** 计算基准日期偏移 offsetDays 天后的 YYYY-MM-DD 字符串 */
  offsetDateStr(baseDateStr, offsetDays) {
    const base = svcDates.parseDateKey(baseDateStr)
    return base ? svcDates.dateKey(svcDates.addDays(base, offsetDays)) : ''
  },

  /**
   * 提取单个已完成任务按自然日拆分后的区间列表
   * 若某分段跨午夜（如 23:30 至次日 00:30），自动拆分为当日 [23.5, 24] 与次日 [0, 0.5]
   */
  extractTaskDayIntervals(task, taskOrder = 0) {
    if (!task || task.status !== 'completed' || !Array.isArray(task.tags) || task.tags.length === 0) {
      return []
    }
    const baseDate = svcDates.normalizeDateKey(task.date)
    if (!baseDate) return []
    const baseMidnightMs = svcDates.parseDateKey(baseDate).getTime()

    const segs = Array.isArray(task.segments) ? task.segments : []
    const taskIntervals = []
    segs.forEach(seg => {
      const bounds = svcDates.timerSegmentBounds(seg, baseDate)
      if (!bounds || !Number.isFinite(new Date(bounds.startAt).getTime()) || !Number.isFinite(new Date(bounds.endAt).getTime())) return
      const sH = (bounds.startAt - baseMidnightMs) / 3600000
      const eH = (bounds.endAt - baseMidnightMs) / 3600000
      if (Number.isFinite(sH) && Number.isFinite(eH) && eH > sH && eH - sH <= svcMetadata.MAX_TIMER_HOURS) taskIntervals.push({ sH, eH })
    })

    // 最终时长为准：调小时从最后一段开始逐段扣减，调大时延长最后一段。
    const segSum = taskIntervals.reduce((acc, it) => acc + (it.eH - it.sH), 0)
    const requested = task.finalHours != null ? Number(task.finalHours) : segSum
    const targetH = Number.isFinite(requested) ? Math.max(0, requested) : segSum
    if (targetH === 0 || targetH > svcMetadata.MAX_TIMER_HOURS) return []
    if (taskIntervals.length === 0 && targetH > 0) {
      const sH = svcDates.clockToHours(segs[0]?.startHm || '09:00')
      taskIntervals.push({ sH, eH: sH + targetH })
    } else if (targetH < segSum) {
      let remaining = targetH
      for (const interval of taskIntervals) {
        const hours = Math.min(interval.eH - interval.sH, remaining)
        interval.eH = interval.sH + hours
        remaining = Math.max(0, remaining - hours)
      }
    } else if (targetH > segSum) {
      taskIntervals[taskIntervals.length - 1].eH += targetH - segSum
    }

    // 将可能跨午夜的 [sH, eH] 按每 24 小时自然日边界切分到对应日期
    const dayIntervals = []
    taskIntervals.forEach(({ sH, eH }) => {
      if (!Number.isFinite(sH) || !Number.isFinite(eH) || eH - sH > svcMetadata.MAX_TIMER_HOURS) return
      const startDayIdx = Math.floor((sH + EPS) / 24)
      const endDayIdx   = Math.ceil((eH - EPS) / 24) - 1
      for (let dIdx = startDayIdx; dIdx <= endDayIdx; dIdx++) {
        const localS = svcMetadata.clamp(sH - dIdx * 24, 0, 24)
        const localE = svcMetadata.clamp(eH - dIdx * 24, 0, 24)
        if (localE - localS > EPS) {
          dayIntervals.push({ dateStr: this.offsetDateStr(baseDate, dIdx), task, taskOrder, sH: localS, eH: localE })
        }
      }
    })
    return dayIntervals
  },

  /** 一次提取全部任务区间并按日期分桶，后续按日切分无需再次扫描历史。 */
  buildTaskDayIndex(tasks = []) {
    const index = new Map()
    tasks.forEach((task, order) => {
      this.extractTaskDayIntervals(task, order).forEach(interval => {
        if (!index.has(interval.dateStr)) index.set(interval.dateStr, [])
        index.get(interval.dateStr).push(interval)
      })
    })
    return index
  },

  /**
   * 扫描线时间轴切分引擎：
   * 将目标日期 targetDateStr 下的任务区间按时间轴重叠关系切分为：
   * - 重叠时段 -> 自动合并为并行事项（多任务标题拼接、标签求并集、_isParallel: true）
   * - 非重叠时段 -> 保持各任务独立的单一事项（早结束与晚结束的时间差自动算作单独事项）
   */
  sliceParallelTasksToEvents(completedTaggedTasks, targetDateStr = null, dayIndex = null) {
    const index = dayIndex || this.buildTaskDayIndex(completedTaggedTasks || [])
    const targetDate = targetDateStr || index.keys().next().value || svcDates.today()
    const rawIntervals = index.get(targetDate) || []
    if (rawIntervals.length === 0) return []

    // 收集所有时间边界点并排序去重
    const points = []
    rawIntervals.flatMap(it => [it.sH, it.eH]).sort((a, b) => a - b).forEach(p => {
      if (points.length === 0 || p - points[points.length - 1] > EPS) points.push(p)
    })

    // 扫描每个原子时间切片 [p_i, p_{i+1}]，按同时活动的任务组合聚合
    const grouped = new Map()
    for (let i = 0; i < points.length - 1; i++) {
      const sH = points[i]
      const eH = points[i + 1]
      if (eH - sH <= EPS) continue

      const activeMap = new Map()
      rawIntervals.forEach(it => {
        if (it.sH <= sH + EPS && it.eH >= eH - EPS && !activeMap.has(it.task.id)) {
          activeMap.set(it.task.id, { task: it.task, order: it.taskOrder })
        }
      })
      if (activeMap.size === 0) continue

      const activeList = Array.from(activeMap.values())
        .sort((a, b) => (a.task.createdAt || 0) - (b.task.createdAt || 0) || a.order - b.order)
        .map(x => x.task)
      const groupKey = activeList.map(t => t.id).join('+')

      if (!grouped.has(groupKey)) grouped.set(groupKey, { activeList, totalH: 0, segments: [] })
      const g = grouped.get(groupKey)
      g.totalH += eH - sH
      g.segments.push({ startHm: svcDates.fmtClock(sH), endHm: svcDates.fmtClock(eH) })
    }

    return Array.from(grouped, ([groupKey, g]) => {
      const isMultiTask = g.activeList.length > 1
      const mergedTags = Array.from(new Set(g.activeList.flatMap(t => t.tags || []).filter(Boolean)))
      const name = g.activeList.map(t => t.title).join(' + ')
      return {
        name: name || mergedTags.join('+') || '未命名',
        h: Math.round(g.totalH * 10000) / 10000,
        tags: mergedTags,
        segments: g.segments,
        _date: targetDate,
        _isSync: true,
        _isParallel: isMultiTask || mergedTags.length > 1,
        _syncId: isMultiTask ? `parallel_${groupKey}` : g.activeList[0].id,
        _syncTaskIds: g.activeList.map(t => t.id),
      }
    })
  },


}
svcTimerProjection.timerEvents = timerEvents
