import { metadata as svcMetadata } from './core.js'
import { dates as svcDates } from './date-utils.js'

export const transferFormat = {}
transferFormat.SCOPE = 'qls-business-v1'
transferFormat.EPOCH_KEY = '__data_epoch__'
transferFormat.RECOVERY_KEY = '__transfer_recovery__'
transferFormat.RECEIPT_KEY = '__transfer_receipt__'
const keys = new Set([
  svcMetadata.TASKS_KEY, svcMetadata.GOALS_KEY, svcMetadata.TIMEBLOCK_KEY, svcMetadata.INPROGRESS_KEY,
  svcMetadata.TIMELINE_SORT_KEY, svcMetadata.TB_STEP_KEY, svcMetadata.SCH_ENTRY_KEY,
  svcMetadata.TAGS_KEY, svcMetadata.EXPECTATIONS_KEY, svcMetadata.QL_ENTRY_KEY,
])
transferFormat.isBusinessKey = key => typeof key === 'string' && (keys.has(key) ||
  (key.startsWith(svcMetadata.QL_PREFIX) && svcDates.isDateKey(key.slice(svcMetadata.QL_PREFIX.length))))
transferFormat.rawEntries = records => records.filter(record => transferFormat.isBusinessKey(record.key))
  .map(({ key, raw }) => ({ key, raw })).sort((a, b) => a.key.localeCompare(b.key))
transferFormat.baseline = records => JSON.stringify(transferFormat.rawEntries(records))
transferFormat.bytes = text => new TextEncoder().encode(text)
transferFormat.parse = text => {
  if (typeof text !== 'string' || transferFormat.bytes(text).length > svcMetadata.MAX_IMPORT_BYTES) throw new Error('数据超过 10 MiB 上限')
  return JSON.parse(text)
}
// 传输采用可靠、有序且加密的 DataChannel；此校验值仅用于检出组包和重试错误。
transferFormat.checksum = bytes => {
  let hash = 2166136261
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619)
  return `${bytes.length}:${(hash >>> 0).toString(16)}`
}
