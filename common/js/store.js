import { localStorageModule as svcLocalStorageModule } from './store-local.js'
import { ui as svcUi } from './ui.js'

const svcStorage = {}
export const storage = svcStorage

/** MAERS QLS — 稳定存储门面与页面内存储变更事件。 */
const localBackend = svcLocalStorageModule.localStoreBackend

/**
 * 存储外观：对象身份永远不变，业务模块可安全解构 `const { store } = QLS`；
 * 具体读写委托给当前后端，后端经 QLS.setStoreBackend 一次性切换。
 */
let backend = localBackend
let rejectedWrite = false
svcStorage.store = {
  get mode() { return backend.mode },
  get locked() { return backend.locked === true },
  get: (...args) => backend.get(...args),
  getCommitted: (...args) => backend.getCommitted ? backend.getCommitted(...args) : backend.get(...args),
  set: (...args) => {
    const accepted = backend.set(...args)
    if (!accepted) rejectedWrite = true
    return accepted
  },
  remove: (...args) => {
    const accepted = backend.remove(...args)
    if (!accepted) rejectedWrite = true
    return accepted
  },
  version: key => backend.version ? backend.version(key) : localStorage.getItem(key),
  has: (...args) => backend.has(...args),
  keys: (...args) => backend.keys(...args),
  dump: (...args) => backend.dump(...args),
  batchSet: (...args) => backend.batchSet(...args),
  estimateUsage: (...args) => backend.estimateUsage(...args),
  estimateQuota: (...args) => backend.estimateQuota(...args),
  flush: () => {
    if (rejectedWrite) {
      rejectedWrite = false
      return Promise.reject(new Error('本地数据写入未被受理'))
    }
    return backend.flush ? backend.flush() : Promise.resolve()
  },
  stage: (key, value, options) => backend.stage ? backend.stage(key, value, options) :
    (value == null ? backend.remove(key) : backend.set(key, value)),
  discardDraft: key => backend.discardDraft?.(key),
}
svcStorage.setStoreBackend = (next) => { backend = next || localBackend }
/** 成功提示只能在持久化完成后显示；具体失败原因由存储后端提示。 */
svcStorage.showSavedToast = message => svcStorage.store.flush().then(() => {
  svcUi.showToast(message)
  return true
}, () => false)

// ── 5.1 事件总线与存储变更订阅 ─────────────────────────
/** 页面内事件总线：基于 window 自定义事件，供模块在不直接依赖彼此的前提下通信 */
svcStorage.on = (name, handler) => {
  const listener = (event) => handler(event.detail)
  window.addEventListener(name, listener)
  return () => window.removeEventListener(name, listener)
}
svcStorage.emit = (name, detail) => {
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

/**
 * 订阅「其他页面 / 标签页」对业务数据的修改（本页自身的写入不会触发）。
 * 回调参数为被修改的存储键数组；返回取消订阅函数。
 */
svcStorage.STORE_CHANGE_EVENT = 'qls:store-change'
svcStorage.onStoreChange = (handler) => svcStorage.on(svcStorage.STORE_CHANGE_EVENT, handler)
