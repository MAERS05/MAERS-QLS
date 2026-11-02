import { tasks as svcTasks } from './task-service.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { storage as svcStorage } from '../../common/js/store.js'

const svcTimelineSort = {}
export const timelineSort = svcTimelineSort

/** MAERS Schedule — 时间轴排序配置、比较与手动顺序持久化。 */
const store = svcStorage.store

// ── 时间轴排序配置与多维排序引擎 ──────────────────────
/** 重要紧急程度优先级（紧急度优先：重要紧急 → 不重要紧急 → 重要不紧急 → 不重要不紧急） */
svcTimelineSort.QUADRANT_PRIORITY = { do: 0, delegate: 1, plan: 2, eliminate: 3 }
const SORT_MODES = ['manual', 'startDate', 'deadline', 'quadrant']
const SUB_SORT_MODES = ['none', 'startDate', 'deadline']

svcTimelineSort.timelineSortModes = { SORT_MODES, SUB_SORT_MODES }

svcTimelineSort.loadTimelineSort = () => {
  const parsed = store.get(svcMetadata.TIMELINE_SORT_KEY, null)
  return {
    mode: SORT_MODES.includes(parsed?.mode) ? parsed.mode : 'manual',
    subTimeSort: SUB_SORT_MODES.includes(parsed?.subTimeSort) ? parsed.subTimeSort : 'none',
  }
}

svcTimelineSort.saveTimelineSort = (cfg = {}) => {
  const cur = svcTimelineSort.loadTimelineSort()
  const next = {
    mode: SORT_MODES.includes(cfg.mode) ? cfg.mode : cur.mode,
    subTimeSort: SUB_SORT_MODES.includes(cfg.subTimeSort) ? cfg.subTimeSort : cur.subTimeSort,
  }
  store.set(svcMetadata.TIMELINE_SORT_KEY, next)
  return next
}

/**
 * 比较两个任务的指定日期字段（startDate 或 deadline）：
 * 有对应日期的任务按从早到晚排列；缺少该日期字段的任务一律排在最后
 */
function compareTaskDateField(a, b, field) {
  const va = String(a?.[field] || '').trim()
  const vb = String(b?.[field] || '').trim()
  if (va && vb) return va.localeCompare(vb)
  if (va) return -1
  if (vb) return 1
  return 0
}

/**
 * 按当前时间轴排序配置对任务列表进行稳定排序
 * 规则：
 * 1. 未完成 (active) 始终排在已完成 (done) 之前
 * 2. manual：保持手动拖拽顺序
 * 3. startDate / deadline：按对应时间从早到晚，缺失者放最后
 * 4. quadrant：按重要紧急程度排序，同等级内可按 subTimeSort 再排序
 */
svcTimelineSort.sortTimelineTasks = (tasks = [], sortCfg = null) => {
  const cfg = sortCfg || svcTimelineSort.loadTimelineSort()
  const indexed = tasks.filter(t => t && typeof t === 'object').map((item, idx) => ({ item, idx }))

  indexed.sort((x, y) => {
    const a = x.item
    const b = y.item
    const doneDiff = (a.status === 'done') - (b.status === 'done')
    if (doneDiff !== 0) return doneDiff

    if (cfg.mode === 'startDate' || cfg.mode === 'deadline') {
      return compareTaskDateField(a, b, cfg.mode) || (x.idx - y.idx)
    }
    if (cfg.mode === 'quadrant') {
      const qDiff = (svcTimelineSort.QUADRANT_PRIORITY[a.quadrant] ?? 0) - (svcTimelineSort.QUADRANT_PRIORITY[b.quadrant] ?? 0)
      if (qDiff !== 0) return qDiff
      if (cfg.subTimeSort !== 'none') {
        const cmp = compareTaskDateField(a, b, cfg.subTimeSort)
        if (cmp !== 0) return cmp
      }
    }
    return x.idx - y.idx
  })
  return indexed.map(entry => entry.item)
}

/** 按 orderedIds 重排列表，未出现在 orderedIds 中的项保持原相对顺序追加在末尾 */
function reorderByIds(items, orderedIds) {
  const idMap = new Map(items.map(it => [it.id, it]))
  const reordered = []
  orderedIds.forEach(id => {
    if (idMap.has(id)) {
      reordered.push(idMap.get(id))
      idMap.delete(id)
    }
  })
  idMap.forEach(it => reordered.push(it))
  return reordered
}

/** 时间轴同层级内手动排序持久化（短/中期自动切换为 manual 排序模式） */
svcTimelineSort.reorderTimelineTier = (tier, orderedIds = []) => {
  if (!Array.isArray(orderedIds) || orderedIds.length === 0) return null
  if (tier === 'long') {
    const reordered = reorderByIds(svcTasks.loadGoals(), orderedIds)
    svcTasks.saveGoals(reordered)
    return reordered
  }

  const allTasks = svcTasks.loadTasks()
  const reorderedTier = reorderByIds(allTasks.filter(t => t.tier === tier), orderedIds)
  let cursor = 0
  const merged = allTasks.map(t => (t.tier === tier ? reorderedTier[cursor++] : t))
  svcTasks.saveTasks(merged)
  svcTimelineSort.saveTimelineSort({ mode: 'manual' })
  return merged
}
