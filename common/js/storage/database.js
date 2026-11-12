import { transferFormat as format } from '../transfer-format.js'

const svcIdbDatabase = {}
export const idbDatabase = svcIdbDatabase

/** MAERS QLS — IndexedDB 连接与底层事务、读取。 */
svcIdbDatabase.createDatabase = () => {
  const DB_NAME = 'maers-qls-data'
  const STORE_NAME = 'keyvalue'

  let db = null
  let epoch = null

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DB_NAME, 1)
      request.onupgradeneeded = () => {
        const database = request.result
        if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
      request.onsuccess = () => {
        const database = request.result
        database.onversionchange = () => database.close()
        resolve(database)
      }
      request.onerror = () => reject(request.error || new Error('无法打开 IndexedDB'))
      request.onblocked = () => reject(new Error('IndexedDB 被其他页面占用'))
    })
  }

  function transaction(mode, work) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode)
      const store = tx.objectStore(STORE_NAME)
      let failure
      const run = () => { try { work(store) } catch (err) { failure = err; tx.abort() } }
      if (mode === 'readwrite' && epoch !== null) {
        const request = store.get(format.EPOCH_KEY)
        request.onsuccess = () => {
          if ((request.result?.raw ?? '"0"') !== JSON.stringify(epoch)) {
            failure = new Error('本机数据已被设备互传替换，请先保留输入并刷新页面')
            failure.name = 'DataEpochError'
            tx.abort()
          } else run()
        }
      } else run()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(failure || tx.error || new Error('IndexedDB 事务失败'))
      tx.onabort = () => reject(failure || tx.error || new Error('IndexedDB 事务已取消'))
    })
  }

  function readAll() {
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll()
      request.onsuccess = () => resolve(request.result || [])
      request.onerror = () => reject(request.error || new Error('无法读取 IndexedDB'))
    })
  }

  /** 按键读取记录；返回 Map<key, raw | undefined>（undefined 表示磁盘上已不存在） */
  function readKeys(keys) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const result = new Map()
      keys.forEach(key => {
        const request = store.get(key)
        request.onsuccess = () => result.set(key, request.result?.raw)
      })
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error || new Error('无法读取 IndexedDB'))
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 读取已取消'))
    })
  }

  return { open: async () => { db = await openDatabase() }, transaction, readAll, readKeys,
    getEpoch: () => epoch ?? '0', setEpoch: value => { epoch = value } }
}
