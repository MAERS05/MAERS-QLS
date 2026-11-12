import { metadata as svcMetadata } from '../core.js'
import { idbMerge as svcIdbMerge } from './merge.js'
import { storage as svcStorage } from '../store.js'
import { transferPolicy } from '../transfer-policy.js'

const svcIdbImport = {}
export const idbImport = svcIdbImport

/** MAERS QLS — 备份批量导入的配额预检与单事务提交。 */
svcIdbImport.createImporter = ({ cache, committed, revisions, estimateQuota, enqueue, transaction, writeScheduleDays, writeExpectations, mirrorSetting, announce, notify }) => {
  const { parse, setRaw, rawByteSize } = svcIdbMerge.merge

  return async function batchSet(entries, { mode = 'replace' } = {}) {
    transferPolicy.validate(mode)
    if (!Array.isArray(entries) || entries.length === 0) return 0
    const prepared = new Map()
    try {
      entries.forEach(entry => {
        if (!entry || typeof entry.key !== 'string' || !entry.key) throw new TypeError('无效存储键')
        const raw = JSON.stringify(entry.value)
        if (raw === undefined) throw new TypeError('不可序列化的数据')
        prepared.set(entry.key, raw)
      })
    } catch (err) {
      console.error('[QLS] 导入数据无法序列化:', err)
      notify('导入失败：备份数据格式无效，原数据未更改')
      return 0
    }

    const quota = await estimateQuota()
    if (quota?.quota && Number.isFinite(quota.usage)) {
      let projected = quota.usage
      prepared.forEach((raw, key) => {
        const oldRaw = cache.get(key)
        projected += rawByteSize(key, raw) - (oldRaw == null ? 0 : rawByteSize(key, oldRaw))
      })
      if (projected > quota.quota) {
        notify('导入失败：本地可用空间不足，原数据未更改')
        return 0
      }
    }

    try {
      const versions = new Map(revisions)
      await enqueue(async () => {
        const changes = new Map()
        await transaction('readwrite', store => {
          const request = store.getAll()
          request.onsuccess = () => {
            try {
              const previous = new Map(request.result.map(({ key, raw }) => [key, raw]))
              const current = Object.fromEntries([...prepared.keys()].filter(key => previous.has(key)).map(key => [key, parse(previous.get(key))]))
              const incoming = Object.fromEntries([...prepared].map(([key, raw]) => [key, parse(raw)]))
              const merged = transferPolicy.apply(current, incoming, mode)
              const replacements = new Map(Object.entries(merged).map(([key, value]) => [key, JSON.stringify(value)]))
              if (quota?.quota && Number.isFinite(quota.usage)) {
                let projected = quota.usage
                replacements.forEach((raw, key) => { projected += rawByteSize(key, raw) - (previous.has(key) ? rawByteSize(key, previous.get(key)) : 0) })
                if (projected > quota.quota) throw new Error('本地可用空间不足')
              }
              replacements.forEach((raw, key) => { store.put({ key, raw }); changes.set(key, raw) })
              if (replacements.has(svcMetadata.INPROGRESS_KEY)) writeScheduleDays(store, parse(previous.get(svcMetadata.INPROGRESS_KEY), []),
                merged[svcMetadata.INPROGRESS_KEY], merged[svcMetadata.TAGS_KEY] ?? parse(previous.get(svcMetadata.TAGS_KEY), {}), changes, replacements)
              if (replacements.has(svcMetadata.TIMEBLOCK_KEY)) writeExpectations(store, parse(previous.get(svcMetadata.TIMEBLOCK_KEY), null),
                merged[svcMetadata.TIMEBLOCK_KEY], merged[svcMetadata.EXPECTATIONS_KEY] ?? parse(previous.get(svcMetadata.EXPECTATIONS_KEY), {}), changes)
            } catch { store.transaction.abort() }
          }
        })
        changes.forEach((raw, key) => {
          setRaw(committed, key, raw)
          if (versions.get(key) === revisions.get(key)) {
            setRaw(cache, key, raw)
            mirrorSetting(key, raw)
          }
        })
        svcStorage.emit(svcStorage.STORE_CHANGE_EVENT, [...changes.keys()])
        announce([...changes.keys()])
      })
      return entries.length
    } catch (err) {
      console.error('[QLS] IndexedDB 批量写入失败:', err)
      notify('导入失败：本地数据未更改，请检查可用空间或浏览器存储权限')
      return 0
    }
  }
}
