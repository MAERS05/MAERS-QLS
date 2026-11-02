import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { dayRecords as svcDayRecords } from '../../common/js/day-record.js'
import { storage as svcStorage } from '../../common/js/store.js'

const svcRecords = {}
export const records = svcRecords

/** MAERS QuantiLife — 日记录存取、空记录清理与日期索引。 */
const store = svcStorage.store

// ── 每日记录归一化与存取 ──────────────────────────────
/** 单日记录的数据契约（归一化 / 空记录判定 / 保存）由 common/js/day-record.js 统一定义，此处仅作领域层别名 */
svcRecords.normalizeDayData = svcDayRecords.normalizeDayData

const dayKeyOf = (d) => (typeof d === 'string' ? svcDates.normalizeDateKey(d) : svcDates.dateKey(d))

svcRecords.loadDayData = (d) => {
  const key = dayKeyOf(d)
  if (!key) return null
  const stored = store.get(svcMetadata.QL_PREFIX + key, null)
  return stored ? svcRecords.normalizeDayData(stored, key) : null
}

svcRecords.isDataEmpty = svcDayRecords.isDayDataEmpty

/** 保存当日记录；内容为空时删除对应键，避免残留空记录 */
svcRecords.saveDayData = svcDayRecords.saveDayRecord

/** 枚举全部日记录键，返回 [{ key, dateStr }] */
function listDayKeys() {
  return store.keys(svcMetadata.QL_PREFIX)
    .map(key => ({ key, dateStr: key.slice(svcMetadata.QL_PREFIX.length) }))
    .filter(({ dateStr }) => svcDates.isDateKey(dateStr))
}

svcRecords.cleanupEmptyRecords = () => {
  listDayKeys().forEach(({ key }) => {
    if (svcRecords.isDataEmpty(store.get(key, null))) store.remove(key)
  })
}

svcRecords.findEarliestRecord = () => listDayKeys().reduce((earliest, { dateStr }) => {
  const d = svcDates.parseDateKey(dateStr)
  return !earliest || d < earliest ? d : earliest
}, null)
