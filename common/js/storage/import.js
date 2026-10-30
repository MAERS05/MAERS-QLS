import { metadata as svcMetadata } from '../core.js'
import { idbMerge as svcIdbMerge } from './merge.js'
import { storage as svcStorage } from '../store.js'

const svcIdbImport = {}
export const idbImport = svcIdbImport

/** MAERS QLS — 备份批量导入的配额预检与单事务提交。 */
svcIdbImport.createImporter = ({ cache, committed, revisions, estimateQuota, enqueue, transaction, writeScheduleDays, mirrorSetting, announce, notify }) => {
  const { parse, setRaw, rawByteSize } = svcIdbMerge.merge

  return async function batchSet(entries) {
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
        const changes = new Map(prepared)
        await transaction('readwrite', store => {
          const tasks = prepared.has(svcMetadata.INPROGRESS_KEY) ? store.get(svcMetadata.INPROGRESS_KEY) : null
          const tags = tasks ? store.get(svcMetadata.TAGS_KEY) : null
          if (!tasks) prepared.forEach((raw, key) => store.put({ key, raw }))
          else tags.onsuccess = () => {
            try {
              prepared.forEach((raw, key) => store.put({ key, raw }))
              writeScheduleDays(store, parse(tasks.result?.raw, []), parse(prepared.get(svcMetadata.INPROGRESS_KEY), []),
                parse(prepared.get(svcMetadata.TAGS_KEY) ?? tags.result?.raw, {}), changes, prepared)
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
