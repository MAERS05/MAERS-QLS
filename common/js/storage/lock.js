import { dom as svcDom } from '../dom.js'
import { storage as svcStorage } from '../store.js'

const svcIdbLock = {}
export const idbLock = svcIdbLock

/** MAERS QLS — 数据库不可用时的锁定后端与保护提示。 */
svcIdbLock.createLock = ({ localStorageBackend, KEEP_IN_LOCAL_STORAGE, notify }) => {
  /**
   * 数据优先保护：支持 IndexedDB 的环境中若初始化失败，锁定全部业务键读写，
   * 杜绝应用在空的 localStorage 上继续写入，防止后续恢复时覆盖或猜测合并整张数据表。
   */
  const lockedStore = {
    mode: 'locked',
    locked: true,
    get(key, fallback = null) {
      return KEEP_IN_LOCAL_STORAGE.has(key) ? localStorageBackend.get(key, fallback) : fallback
    },
    set(key, value) {
      if (KEEP_IN_LOCAL_STORAGE.has(key)) return localStorageBackend.set(key, value)
      notify('本地数据库已锁定保护，请关闭冲突页面后重试')
      return false
    },
    remove(key) {
      if (KEEP_IN_LOCAL_STORAGE.has(key)) return localStorageBackend.remove(key)
      notify('本地数据库已锁定保护，请关闭冲突页面后重试')
      return false
    },
    has(key) {
      return KEEP_IN_LOCAL_STORAGE.has(key) ? localStorageBackend.has(key) : false
    },
    keys(prefix = '') {
      const keys = []
      KEEP_IN_LOCAL_STORAGE.forEach(key => { if (key.startsWith(prefix) && localStorageBackend.has(key)) keys.push(key) })
      return keys
    },
    dump() {
      return {}
    },
    estimateUsage() {
      return 0
    },
    async estimateQuota() {
      return null
    },
    async batchSet() {
      notify('本地数据库已锁定保护，请关闭冲突页面后重试')
      return 0
    },
  }

  function lockPage(err) {
    console.error('[QLS] IndexedDB 初始化失败，已锁定页面以保护本地数据:', err)
    svcStorage.setStoreBackend(lockedStore)
    document.documentElement.removeAttribute('data-storage-loading')
    document.documentElement.setAttribute('data-storage-locked', 'true')

    const mountLockBanner = () => {
      if (!document.body || document.querySelector('.storage-lock-overlay')) return
      const overlay = document.createElement('div')
      overlay.className = 'storage-lock-overlay'
      overlay.setAttribute('role', 'alertdialog')
      overlay.setAttribute('aria-modal', 'true')
      overlay.setAttribute('aria-label', '本地数据保护锁定')
      svcDom.setHTML(overlay, svcDom.html`
        <div class="storage-lock-card">
          <h2 class="storage-lock-title">⚠️ 本地数据库暂时无法访问</h2>
          <p class="storage-lock-desc">为保护您已有的日程与量化数据不被空状态覆盖，当前页面已锁定并禁止写入。请关闭其他正在运行的冲突页面或检查浏览器存储权限后重试。</p>
          <button type="button" class="storage-lock-retry">重新加载页面</button>
        </div>
      `)
      overlay.querySelector('.storage-lock-retry')?.addEventListener('click', () => {
        window.location?.reload?.()
      })
      document.body.appendChild(overlay)
    }

    if (document.body) mountLockBanner()
    else document.addEventListener('DOMContentLoaded', mountLockBanner, { once: true })
  }

  return { lockPage }
}
