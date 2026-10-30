import { metadata as svcMetadata } from '../core.js'
import { dates as svcDates } from '../date-utils.js'

const svcIdbMigrations = {}
export const idbMigrations = svcIdbMigrations

/** MAERS QLS — schema、旧 localStorage 数据迁移与启动恢复顺序。 */
svcIdbMigrations.createMigrations = ({ database, cache, KEEP_IN_LOCAL_STORAGE, isBusinessKey, mirrorSetting, scriptsReady, drafts }) => {
  const SCHEMA_KEY = '__schema_version__'

  const { transaction, readAll } = database

  async function migrateAndLoad() {
    await database.open()
    const records = await readAll()

    // ── schema 版本迁移 ──────────────────────────────────
    // 增量迁移表：键为旧版本号，值为 (records) => void 的迁移函数，就地修改记录的 raw 字符串。
    // 被修改的记录与新版本号在同一个 readwrite 事务中提交，失败则整体回滚（版本号不会先于数据升级）。
    const rewriteRaw = (records, key, transform) => {
      const record = records.find(r => r?.key === key)
      if (!record || typeof record.raw !== 'string') return
      try {
        const next = transform(JSON.parse(record.raw))
        if (next !== undefined) record.raw = JSON.stringify(next)
      } catch { /* 无法解析的数据保持原样，交由读取端归一化兜底 */ }
    }
    const SCHEMA_MIGRATIONS = {
      // v1 → v2：时间块 / 重复规则 / 进行中任务以分类键 category 取代颜色值 color
      1: (records) => {
        rewriteRaw(records, svcMetadata.TIMEBLOCK_KEY, map => {
          if (!map || typeof map !== 'object' || Array.isArray(map)) return undefined
          Object.keys(map).forEach(k => {
            if (Array.isArray(map[k])) map[k] = map[k].map(b => (b && typeof b === 'object' ? svcMetadata.stripLegacyColor(b) : b))
          })
          return map
        })
        rewriteRaw(records, svcMetadata.INPROGRESS_KEY, list =>
          (Array.isArray(list) ? list.map(t => (t && typeof t === 'object' ? svcMetadata.stripLegacyColor(t) : t)) : undefined))
      },
    }
    const schemaRecord = records.find(r => r?.key === SCHEMA_KEY)
    const rawBefore = new Map(records.map(r => [r?.key, r?.raw]))
    let storedSchemaVersion = schemaRecord ? Number(schemaRecord.raw) || 0 : 0
    // 无版本记录视为 v1（v1 是首个带版本号之前的数据结构）
    if (storedSchemaVersion < 1) storedSchemaVersion = 1
    const startVersion = storedSchemaVersion
    while (storedSchemaVersion < svcMetadata.SCHEMA_VERSION) {
      SCHEMA_MIGRATIONS[storedSchemaVersion]?.(records)
      storedSchemaVersion++
    }
    const migratedRecords = records.filter(r => r && r.key !== SCHEMA_KEY && r.raw !== rawBefore.get(r.key))
    if (migratedRecords.length > 0 || !schemaRecord || Number(schemaRecord.raw) !== svcMetadata.SCHEMA_VERSION || startVersion !== storedSchemaVersion) {
      await transaction('readwrite', store => {
        migratedRecords.forEach(record => store.put({ key: record.key, raw: record.raw }))
        store.put({ key: SCHEMA_KEY, raw: String(svcMetadata.SCHEMA_VERSION) })
      })
    }


    records.forEach(record => {
      if (!record || typeof record.key !== 'string' || typeof record.raw !== 'string') return
      if (record.key === SCHEMA_KEY) return
      cache.set(record.key, record.raw)
    })

    // 仅迁移 IDB 尚不存在的旧版 localStorage 业务键；已存在于 IDB 的遗留键直接清理，绝不用 localStorage 覆盖 IDB。
    const migration = []
    const staleLegacyKeys = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !isBusinessKey(key)) continue
      if (cache.has(key)) {
        if (!KEEP_IN_LOCAL_STORAGE.has(key)) staleLegacyKeys.push(key)
        continue
      }
      const raw = localStorage.getItem(key)
      if (raw !== null) migration.push({ key, raw })
    }
    if (migration.length) {
      await transaction('readwrite', store => migration.forEach(record => store.put(record)))
      migration.forEach(record => cache.set(record.key, record.raw))
      // 仅在 IndexedDB 事务提交成功后清理旧副本，保证迁移中断不会造成数据遗失。
    }
    // 已存在 IndexedDB 副本的遗留键同样可以安全清理，释放原 localStorage 配额。
    migration.forEach(record => {
      if (!KEEP_IN_LOCAL_STORAGE.has(record.key)) localStorage.removeItem(record.key)
    })
    staleLegacyKeys.forEach(key => localStorage.removeItem(key))
    KEEP_IN_LOCAL_STORAGE.forEach(key => { if (cache.has(key)) mirrorSetting(key, cache.get(key)) })

    // 恢复卸载前尚未提交的日记录；在事务内与最新数据合并，冲突草稿保留而不覆盖。
    await scriptsReady
    await drafts.recover()

    // 清理 90 天前的 bridge 已读标记（仅为 UI 红点状态，不影响任何业务数据）
    const cutoff = svcDates.dateKey(svcDates.addDays(new Date(), -90))
    const staleBridgeKeys = [...cache.keys()].filter(key => {
      if (!key.startsWith(svcMetadata.BRIDGE_VIEWED_PREFIX)) return false
      const dateStr = key.slice(svcMetadata.BRIDGE_VIEWED_PREFIX.length)
      return svcDates.isDateKey(dateStr) && dateStr < cutoff
    })
    if (staleBridgeKeys.length > 0) {
      await transaction('readwrite', store => staleBridgeKeys.forEach(key => store.delete(key)))
      staleBridgeKeys.forEach(key => cache.delete(key))
    }
  }

  return { migrateAndLoad }
}
