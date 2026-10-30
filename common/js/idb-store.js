import { metadata as svcMetadata } from './core.js'
import { idbDatabase as svcIdbDatabase } from './storage/database.js'
import { idbDaySync as svcIdbDaySync } from './storage/day-sync.js'
import { idbDrafts as svcIdbDrafts } from './storage/drafts.js'
import { idbImport as svcIdbImport } from './storage/import.js'
import { idbLock as svcIdbLock } from './storage/lock.js'
import { idbMerge as svcIdbMerge } from './storage/merge.js'
import { idbMigrations as svcIdbMigrations } from './storage/migrations.js'
import { localStorageModule as svcLocalStorageModule } from './store-local.js'
import { storage as svcStorage } from './store.js'
import { ui as svcUi } from './ui.js'

const svcStorageState = {}
export const storageState = svcStorageState

function initialize() {
  /**
   * MAERS QLS — IndexedDB 后端协调器。
   * 负责乐观缓存、写入队列、存储门面与跨标签页通知；连接、合并、入账、
   * 草稿、迁移、导入和锁定分别由 storage/ 子模块实现。对外接口保持不变。
   */
  const localStorageBackend = svcLocalStorageModule.localStoreBackend
  const CHANNEL_NAME = 'maers-qls-store'
  const KEEP_IN_LOCAL_STORAGE = new Set([svcMetadata.THEME_KEY, svcMetadata.SCH_ENTRY_KEY, svcMetadata.QL_ENTRY_KEY, svcMetadata.LAST_EXPORT_KEY])
  const cache = new Map()
  const committed = new Map()
  const revisions = new Map()
  const pending = new Map()
  const writeErrors = []
  const readyCallbacks = []
  const tabId = svcMetadata.uid('tab_')
  let ready = false
  let writeQueue = Promise.resolve()
  let flushQueue = null
  let flushResult = null
  let channel = null
  // defer 脚本可能尚在下载；恢复草稿前必须等日记录契约与桥接模块完成定义。
  const scriptsReady = Promise.resolve()

  const isBusinessKey = key => KEEP_IN_LOCAL_STORAGE.has(key) || (
    key.startsWith(svcMetadata.QL_PREFIX) || key.startsWith(svcMetadata.MS_PREFIX) ||
    key.startsWith(svcMetadata.BRIDGE_VIEWED_PREFIX) || key === svcMetadata.REPORT_STATE_KEY
  )
  const notify = message => setTimeout(() => svcUi.showToast?.(`⚠️ ${message}`), 0)

  const { parse, rawByteSize, conflict, setRaw } = svcIdbMerge.merge
  const database = svcIdbDatabase.createDatabase()
  const { transaction, readKeys } = database
  const { commitMutation, commitScheduleMutation, writeScheduleDays } = svcIdbDaySync.createDaySync({ transaction })
  const drafts = svcIdbDrafts.createDrafts({ cache, tabId, notify, commitMutation, closeChannel: () => channel?.close() })
  const { clearDraft, settleDraft } = drafts
  const { migrateAndLoad } = svcIdbMigrations.createMigrations({
    database, cache, KEEP_IN_LOCAL_STORAGE, isBusinessKey, mirrorSetting, scriptsReady, drafts,
  })
  const { lockPage } = svcIdbLock.createLock({ localStorageBackend, KEEP_IN_LOCAL_STORAGE, notify })

  function finishReady() {
    ready = true
    document.documentElement.removeAttribute('data-storage-loading')
    while (readyCallbacks.length) {
      try { readyCallbacks.shift()() } catch (err) { console.error('[QLS] 本地数据就绪回调失败:', err) }
    }
  }

  /** 页面首次渲染必须经此入口，确保同步领域接口读到的是已载入的数据。 */
  svcStorageState.onStorageReady = callback => {
    if (ready) callback()
    else readyCallbacks.push(callback)
  }
  svcStorageState.storageReady = () => ready

  function enqueue(operation) {
    const run = writeQueue.then(operation, operation)
    writeQueue = run.catch(() => {})
    return run
  }

  function mirrorSetting(key, raw) {
    if (!KEEP_IN_LOCAL_STORAGE.has(key)) return
    try {
      if (raw == null) localStorage.removeItem(key)
      else localStorage.setItem(key, raw)
    } catch (err) {
      // 镜像失败不改变已提交事务的成功状态；下次启动从 IDB 重建。
      console.warn('[QLS] 首屏设置缓存不可用，将在数据库就绪后应用设置:', err)
    }
  }

  function queueMutation(key, raw, options) {
    const base = options && Object.hasOwn(options, 'base')
      ? (options.base == null ? null : JSON.stringify(options.base))
      : (cache.get(key) ?? null)
    const revision = (revisions.get(key) || 0) + 1
    revisions.set(key, revision)
    pending.set(key, (pending.get(key) || 0) + 1)
    setRaw(cache, key, raw)
    mirrorSetting(key, raw)
    enqueue(async () => {
      try {
        const changes = key === svcMetadata.INPROGRESS_KEY
          ? await commitScheduleMutation(base, raw)
          : new Map([[key, await commitMutation(key, base, raw, options)]])
        const saved = changes.get(key)
        setRaw(committed, key, saved)
        if (revisions.get(key) === revision) {
          setRaw(cache, key, saved)
          mirrorSetting(key, saved)
          if (saved !== raw) svcStorage.emit(svcStorage.STORE_CHANGE_EVENT, [key])
        }
        const related = []
        changes.forEach((value, changedKey) => {
          if (changedKey === key) return
          setRaw(committed, changedKey, value)
          if (!pending.get(changedKey)) setRaw(cache, changedKey, value)
          related.push(changedKey)
        })
        if (related.length) svcStorage.emit(svcStorage.STORE_CHANGE_EVENT, related)
        settleDraft(key, raw, saved)
        announce([...changes.keys()])
      } catch (err) {
        // 失败时重读已提交状态，绝不回滚到另一次失败的乐观快照。
        try {
          const records = await readKeys([key])
          setRaw(committed, key, records.get(key))
        } catch { /* 数据库不可读时保留最后已确认快照 */ }
        if (revisions.get(key) === revision) {
          setRaw(cache, key, committed.get(key))
          mirrorSetting(key, committed.get(key))
          svcStorage.emit(svcStorage.STORE_CHANGE_EVENT, [key])
        }
        writeErrors.push(err)
        console.error(`[QLS] 无法提交本地数据 ${key}:`, err)
        notify(err.message === conflict().message ? err.message : '本地数据保存失败，请检查可用空间或浏览器存储权限')
      } finally {
        pending.set(key, pending.get(key) - 1)
      }
    })
    return true
  }

  // ── 跨标签页同步 ──────────────────────────────────────
  /** 写入已落盘后广播被修改的业务键，其他页面据此刷新镜像 */
  function announce(keys) {
    const changed = keys
    if (!channel || changed.length === 0) return
    try { channel.postMessage({ from: tabId, keys: changed }) } catch { /* 通道关闭时忽略 */ }
  }

  /**
   * 收到其他页面的变更：排在本页待写入队列之后读取磁盘最终状态，再刷新镜像并通知业务层。
   * 排队读取保证本页尚未落盘的写入不会被较旧的磁盘数据短暂覆盖后再反复。
   */
  function applyRemoteChange(keys) {
    const targets = keys.filter(isBusinessKey)
    if (targets.length === 0) return Promise.resolve()
    return enqueue(async () => {
      const versions = new Map(targets.map(key => [key, revisions.get(key)]))
      const records = await readKeys(targets)
      const changed = []
      records.forEach((raw, key) => {
        setRaw(committed, key, raw)
        if (pending.get(key) > 0 || versions.get(key) !== revisions.get(key)) return
        if (raw === undefined ? cache.has(key) : cache.get(key) !== raw) {
          setRaw(cache, key, raw)
          mirrorSetting(key, raw)
          changed.push(key)
        }
      })
      if (changed.length > 0) svcStorage.emit(svcStorage.STORE_CHANGE_EVENT, changed)
    }).catch(err => console.error('[QLS] 同步其他页面的数据变更失败:', err))
  }

  function startSync() {
    if (typeof window.BroadcastChannel !== 'function') return
    try {
      channel = new window.BroadcastChannel(CHANNEL_NAME)
      // 通道不应阻止宿主（如测试进程）退出；浏览器环境无该方法
      channel.unref?.()
      channel.onmessage = event => {
        const message = event.data
        if (!message || message.from === tabId || !Array.isArray(message.keys)) return
        applyRemoteChange(message.keys.filter(key => typeof key === 'string'))
      }
    } catch (err) {
      console.warn('[QLS] 跨标签页同步不可用:', err)
      channel = null
    }
  }

  const indexedStore = {
    mode: 'indexeddb',

    version(key) { return cache.get(key) },

    get(key, fallback = null) {
      return parse(cache.get(key), fallback)
    },

    getCommitted(key, fallback = null) {
      return parse(committed.get(key), fallback)
    },

    set(key, value, options) {
      let raw
      try {
        raw = JSON.stringify(value)
        if (raw === undefined) throw new TypeError('不可序列化的数据')
      } catch (err) {
        console.error(`[QLS] 无法保存本地数据 ${key}:`, err)
        notify('本地数据保存失败，请检查数据格式或浏览器存储权限')
        return false
      }
      // 内容未变化时不落盘也不广播，避免无意义的写入与跨页面刷新回路。
      if (cache.get(key) === raw) {
        if (committed.get(key) === raw) clearDraft(key, raw)
        return true
      }
      return queueMutation(key, raw, options)
    },

    remove(key, options) {
      if (!cache.has(key)) return true
      return queueMutation(key, null, options)
    },

    has(key) {
      return cache.has(key)
    },

    keys(prefix = '') {
      return [...cache.keys()].filter(key => key.startsWith(prefix))
    },

    dump(prefixes = []) {
      const data = {}
      prefixes.forEach(prefix => {
        indexedStore.keys(prefix).forEach(key => {
          const value = indexedStore.get(key, undefined)
          if (value !== undefined) data[key] = value
        })
      })
      return data
    },

    /** 等待当前已排队的全部写入落盘（并已广播）；供测试与诊断使用 */
    flush() {
      if (flushQueue !== writeQueue) {
        flushQueue = writeQueue
        flushResult = writeQueue.then(() => {
          if (writeErrors.length) throw new AggregateError(writeErrors.splice(0), '本地数据未能全部保存')
        })
      }
      return flushResult
    },

    stage: drafts.stage,
    discardDraft: drafts.discardDraft,

    /** 内存镜像的精确 UTF-16 字节估算，供界面展示或离线诊断。 */
    estimateUsage() {
      let bytes = 0
      cache.forEach((raw, key) => { bytes += rawByteSize(key, raw) })
      return bytes
    },

    /** 浏览器实际配额为异步 API；返回 { usage, quota } 或 null。 */
    async estimateQuota() {
      try { return await navigator.storage?.estimate?.() || null } catch { return null }
    },
  }

  indexedStore.batchSet = svcIdbImport.createImporter({
    cache, committed, revisions, estimateQuota: () => indexedStore.estimateQuota(), enqueue,
    transaction, writeScheduleDays, mirrorSetting, announce, notify,
  })

  if (!window.indexedDB) {
    // 确实没有 IndexedDB 的旧浏览器与默认 jsdom 测试环境仍保留原有 localStorage 兼容模式。
    svcStorageState.onStorageReady = callback => callback()
    svcStorageState.storageReady = () => true
    return
  }

  document.documentElement.setAttribute('data-storage-loading', 'true')

  drafts.ownDrafts().then(() => migrateAndLoad())
    .then(() => {
      // 业务模块持有的是稳定的 QLS.store 外观对象，此处仅切换其后端。
      svcStorage.setStoreBackend(indexedStore)
      cache.forEach((raw, key) => committed.set(key, raw))
      startSync()
      announce(drafts.recoveredKeys)
      finishReady()
    })
    .catch(err => {
      lockPage(err)
    })
}
initialize()
