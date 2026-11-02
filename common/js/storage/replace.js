import { metadata as svcMetadata } from '../core.js'
import { transferFormat as format } from '../transfer-format.js'

export const idbReplace = {}
/** 整体覆盖只在 IndexedDB 提供；旧副本、接收回执、数据代次与全部业务键一次提交。 */
idbReplace.createReplacer = ({ database, enqueue, cache, committed, mirrorSetting, announce, flush }) => {
  const parse = raw => raw == null ? null : JSON.parse(raw)
  function checkEpoch(records) {
    if ((parse(records.find(record => record.key === format.EPOCH_KEY)?.raw) || '0') !== database.getEpoch()) {
      throw new Error('本机数据已被替换，请先保留输入并刷新页面')
    }
  }

  async function snapshot() {
    await flush()
    const records = await database.readAll()
    checkEpoch(records)
    return {
      data: Object.fromEntries(format.rawEntries(records).map(({ key, raw }) => [key, parse(raw)])),
      baseline: format.baseline(records),
      recovery: !!records.find(record => record.key === format.RECOVERY_KEY),
      receipt: parse(records.find(record => record.key === format.RECEIPT_KEY)?.raw),
    }
  }

  async function replace(data, { baseline, id, checksum, restore = false }) {
    if (typeof baseline !== 'string' || typeof id !== 'string' || !id || typeof checksum !== 'string') throw new Error('无效覆盖请求')
    const entries = Object.entries(data).map(([key, value]) => {
      if (!format.isBusinessKey(key)) throw new Error('覆盖请求包含范围外的数据')
      const raw = JSON.stringify(value)
      if (typeof raw !== 'string') throw new Error('覆盖数据不能序列化')
      return { key, raw }
    })
    if (!restore) format.parse(JSON.stringify(data))
    await flush()
    return enqueue(async () => {
      let result, changes, nextEpoch, failure
      await database.transaction('readwrite', store => {
        const request = store.getAll()
        request.onsuccess = () => {
          try {
            const records = request.result
            const receipt = parse(records.find(record => record.key === format.RECEIPT_KEY)?.raw)
            if (receipt?.id === id) {
              if (receipt.checksum !== checksum) throw new Error('同一传输编号的数据不一致')
              result = receipt
              return
            }
            if (format.baseline(records) !== baseline) throw new Error('本机数据已发生变化，请重新确认覆盖')
            const previous = format.rawEntries(records)
            const incoming = restore ? parse(records.find(record => record.key === format.RECOVERY_KEY)?.raw)?.entries : entries
            if (!Array.isArray(incoming)) throw new Error('没有可恢复的覆盖前副本')
            nextEpoch = svcMetadata.uid('epoch_')
            result = { id, checksum, savedAt: new Date().toISOString(), count: incoming.length }
            changes = new Map(previous.map(({ key }) => [key, null]))
            previous.forEach(({ key }) => store.delete(key))
            incoming.forEach(({ key, raw }) => {
              if (!format.isBusinessKey(key) || typeof raw !== 'string') throw new Error('恢复副本无效')
              store.put({ key, raw }); changes.set(key, raw)
            })
            store.put({ key: format.RECOVERY_KEY, raw: JSON.stringify({ savedAt: result.savedAt, entries: previous }) })
            store.put({ key: format.RECEIPT_KEY, raw: JSON.stringify(result) })
            store.put({ key: format.EPOCH_KEY, raw: JSON.stringify(nextEpoch) })
          } catch (err) { failure = err; store.transaction.abort() }
        }
      }).catch(err => { throw failure || err })
      if (changes) {
        database.setEpoch(nextEpoch)
        changes.forEach((raw, key) => {
          if (raw === null) { cache.delete(key); committed.delete(key) }
          else { cache.set(key, raw); committed.set(key, raw) }
          mirrorSetting(key, raw)
        })
        announce([...changes.keys(), format.EPOCH_KEY])
      }
      return result
    })
  }
  return { snapshot, replace }
}
