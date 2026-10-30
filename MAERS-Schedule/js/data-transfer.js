import { scheduleModels as svcScheduleModels } from './models.js'
import { timelineSort as svcTimelineSort } from './timeline-sort.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { jsonTransfer as svcJsonTransfer } from '../../common/js/json-transfer.js'
import { storage as svcStorage } from '../../common/js/store.js'

const svcScheduleTransfer = {}
export const scheduleTransfer = svcScheduleTransfer

/** MAERS Schedule — 备份导出、结构校验与原子导入。 */
const store = svcStorage.store
const { SORT_MODES, SUB_SORT_MODES } = svcTimelineSort.timelineSortModes
const { normalizeTaskObject, normalizeGoalObject, normalizeBlockObject, normalizeRepeatRule, storageDateOf, normalizeInProgressItem } = svcScheduleModels.models

// ── 导入导出业务服务（含严格结构校验与消毒） ──────────
svcScheduleTransfer.exportBackup = () => ({
  filename: `schedule-export-${svcDates.today()}.json`,
  data: svcJsonTransfer.createBackup(store.dump([svcMetadata.MS_PREFIX])),
})

/**
 * 仅解析校验 Schedule 备份，返回 { entries }，不执行任何写入。
 * 供 importBackup 和门户跨系统原子导入共用。
 */
svcScheduleTransfer.prepareImportEntries = (json) => {
  const data = svcJsonTransfer.unwrapBackup(json)
  if (!data) return { entries: [] }

  const validators = {
    [svcMetadata.GOALS_KEY]: (val) => {
      if (!Array.isArray(val)) return null
      return (val).map(normalizeGoalObject).filter(Boolean)
    },
    [svcMetadata.TASKS_KEY]: (val) => {
      if (!Array.isArray(val)) return null
      return (val).map(normalizeTaskObject).filter(Boolean)
    },
    [svcMetadata.INPROGRESS_KEY]: (val) => {
      if (!Array.isArray(val)) return null
      return (val).map(normalizeInProgressItem).filter(Boolean)
    },
    [svcMetadata.TIMELINE_SORT_KEY]: (val) => {
      if (!val || typeof val !== 'object' || Array.isArray(val)) return null
      const cur = svcTimelineSort.loadTimelineSort()
      return {
        mode: SORT_MODES.includes(val.mode) ? val.mode : cur.mode,
        subTimeSort: SUB_SORT_MODES.includes(val.subTimeSort) ? val.subTimeSort : cur.subTimeSort,
      }
    },
    [svcMetadata.SCH_ENTRY_KEY]: (val) => (
      val === 'timeblock' || val === 'timeline' || val === 'inprogress' ? val : null
    ),
    [svcMetadata.TB_STEP_KEY]: (val) => (
      svcMetadata.TB_STEPS.includes(Number(val)) ? Number(val) : null
    ),
    [svcMetadata.TIMEBLOCK_KEY]: (val) => {
      if (!val || typeof val !== 'object' || Array.isArray(val)) return null
      const cleanMap = {}
      Object.entries(val).forEach(([ds, arr]) => {
        if (ds === '_repeats') {
          if (!Array.isArray(arr)) return
          const validRules = arr.map(normalizeRepeatRule).filter(Boolean)
          if (validRules.length > 0) cleanMap._repeats = validRules
          return
        }
        const key = storageDateOf(ds)
        if (!key || !Array.isArray(arr)) return
        const validArr = arr.map(normalizeBlockObject).filter(Boolean)
        if (validArr.length > 0) cleanMap[key] = validArr
      })
      return cleanMap
    },
  }

  const entries = []
  Object.entries(data).forEach(([key, val]) => {
    const validator = validators[key]
    if (!validator) return
    const cleaned = validator(val)
    if (cleaned != null) entries.push({ key, value: cleaned })
  })

  return { entries }
}

/**
 * 校验并导入备份；仅接受 Schedule 已知键。
 * P0: 先全量解析校验到内存，再通过 batchSet 原子批量写入；任一条失败自动回滚。
 * 返回成功导入的键数量（全部成功 = entries.length，否则为 0）。
 */
svcScheduleTransfer.importBackup = async (json) => {
  const { entries } = svcScheduleTransfer.prepareImportEntries(json)
  if (entries.length === 0) return 0
  return await store.batchSet(entries)
}
