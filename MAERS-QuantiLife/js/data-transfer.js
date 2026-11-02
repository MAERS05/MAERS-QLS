import { expectations as svcExpectations } from './expectation-store.js'
import { records as svcRecords } from './records.js'
import { quantiTags as svcQuantiTags } from './tags.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { jsonTransfer as svcJsonTransfer } from '../../common/js/json-transfer.js'
import { storage as svcStorage } from '../../common/js/store.js'

const svcQuantiTransfer = {}
export const quantiTransfer = svcQuantiTransfer

/** MAERS QuantiLife — 备份导出、结构校验与原子导入。 */
const store = svcStorage.store
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

// ── 备份导出与导入 ────────────────────────────────────
svcQuantiTransfer.exportBackup = () => ({
  filename: `quantilife-export-${svcDates.today()}.json`,
  data: svcJsonTransfer.createBackup(store.dump([svcMetadata.QL_PREFIX])),
})

/**
 * 仅解析校验 QuantiLife 备份，返回 { entries, pendingTags }，不执行任何写入。
 * 供 importBackup 和门户跨系统原子导入共用。
 */
svcQuantiTransfer.prepareImportEntries = (json) => {
  const data = svcJsonTransfer.unwrapBackup(json)
  if (!data) return { entries: [], pendingTags: null }

  const entries = []
  let pendingTags = null
  Object.entries(data).forEach(([rawKey, val]) => {
    const key = String(rawKey)
    if (!key.startsWith(svcMetadata.QL_PREFIX)) return
    const shortKey = key.slice(svcMetadata.QL_PREFIX.length)

    if (shortKey === 'tags') {
      if (!isPlainObject(val)) return
      pendingTags = svcQuantiTags.normalizeTags(val)
      entries.push({ key: svcMetadata.TAGS_KEY, value: pendingTags })
    } else if (shortKey === 'expectations') {
      const normalized = svcExpectations.normalizeExpectations(val)
      if (normalized) entries.push({ key: svcMetadata.EXPECTATIONS_KEY, value: normalized })
    } else if (shortKey === 'entry_page') {
      if (val === 'index' || val === 'report') entries.push({ key: svcMetadata.QL_ENTRY_KEY, value: val })
    } else if (svcDates.isDateKey(shortKey)) {
      const norm = svcRecords.normalizeDayData(val, shortKey)
      if (norm?.date) entries.push({ key: svcMetadata.QL_PREFIX + norm.date, value: norm })
    }
  })

  return { entries, pendingTags }
}

/**
 * 校验并导入 QuantiLife 备份（标准信封 + quantilife_ 前缀键）。
 * P0: 先全量解析校验到内存，再通过 batchSet 原子批量写入；任一条失败自动回滚。
 * 返回成功导入的条目数量。
 */
svcQuantiTransfer.importBackup = async (json) => {
  const { entries } = svcQuantiTransfer.prepareImportEntries(json)
  if (entries.length === 0) return 0

  const written = await store.batchSet(entries)
  return written
}
