import { metadata as svcMetadata } from './core.js'
import { ui as svcUi } from './ui.js'

const svcLocalStorageModule = {}
export const localStorageModule = svcLocalStorageModule

/** MAERS QLS — localStorage 兼容后端与原子批量写入。 */
// ── 5. 统一存储层（外观 + 可替换后端）────────────────────
/**
 * localStorage 后端：所有值以 JSON 序列化存取；读失败返回 fallback，写失败返回 false，
 * 由调用方保持内存状态，避免一次持久化异常让交互流程崩溃。
 * 后端之间必须保持同一组方法签名：get / set / remove / has / keys / dump / batchSet / estimateUsage / estimateQuota。
 */
const localBackend = {
  mode: 'localstorage',

  get(key, fallback = null) {
    try {
      const raw = localStorage.getItem(key)
      return raw == null ? fallback : JSON.parse(raw)
    } catch (err) {
      console.warn(`[QLS] 无法读取本地数据 ${key}:`, err)
      return fallback
    }
  },

  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
      return true
    } catch (err) {
      console.error(`[QLS] 无法保存本地数据 ${key}:`, err)
      // 存储写入失败也可能由隐私模式、浏览器权限等引起，不应武断归因于空间。
      setTimeout(() => svcUi.showToast?.('⚠️ 本地数据保存失败，请检查可用空间或浏览器存储权限'), 0)
      return false
    }
  },

  remove(key) {
    try {
      localStorage.removeItem(key)
      return true
    } catch (err) {
      console.error(`[QLS] 无法删除本地数据 ${key}:`, err)
      return false
    }
  },

  has(key) {
    try {
      return localStorage.getItem(key) !== null
    } catch {
      return false
    }
  },

  /** 列出以 prefix 开头的全部键 */
  keys(prefix = '') {
    const out = []
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k && k.startsWith(prefix)) out.push(k)
      }
    } catch (err) {
      console.warn('[QLS] 无法枚举本地数据:', err)
    }
    return out
  },

  /** 导出指定前缀下的全部可解析数据，供备份使用 */
  dump(prefixes = []) {
    const data = {}
    prefixes.forEach(prefix => {
      localBackend.keys(prefix).forEach(k => {
        const v = localBackend.get(k, undefined)
        if (v !== undefined) data[k] = v
      })
    })
    return data
  },

  /**
   * 原子批量写入：序列化与空间预检均在写入前完成；任一写入失败则恢复全部快照，
   * 包括抛错的当前条目（即使某个浏览器实现先写入后抛错也不会留下半成品）。
   * entries: [{ key, value }]，返回成功写入的条数（全部成功时等于 entries.length，否则为 0）。
   */
  batchSet(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return 0
    const fail = (message, err) => {
      if (err) console.error(`[QLS] ${message}:`, err)
      setTimeout(() => svcUi.showToast?.(`⚠️ ${message}`), 0)
      return 0
    }

    // 同一 key 在一批内只保留最终值，快照则始终保留批量写入前的原值。
    const snapshots = new Map()
    const prepared = new Map()
    try {
      for (const entry of entries) {
        if (!entry || typeof entry.key !== 'string' || !entry.key) {
          return fail('导入失败：备份数据格式无效，原数据未更改')
        }
        if (!snapshots.has(entry.key)) snapshots.set(entry.key, localStorage.getItem(entry.key))
        const serialized = JSON.stringify(entry.value)
        if (serialized === undefined) return fail('导入失败：备份数据格式无效，原数据未更改')
        prepared.set(entry.key, serialized)
      }
    } catch (err) {
      return fail('导入失败：无法读取或处理本地数据，原数据未更改', err)
    }

    // 预估导入后的总量。这个保守阈值可避免接近配额时先写入一部分再失败。
    const usage = localBackend.estimateUsage()
    if (usage >= 0) {
      let projected = usage
      prepared.forEach((serialized, key) => {
        const oldRaw = snapshots.get(key)
        projected += (key.length + serialized.length) * 2
        if (oldRaw !== null) projected -= (key.length + oldRaw.length) * 2
      })
      if (projected > svcMetadata.LOCAL_STORAGE_BUDGET_BYTES) {
        return fail('导入失败：本地可用空间不足，原数据未更改')
      }
    }

    try {
      prepared.forEach((serialized, key) => localStorage.setItem(key, serialized))
    } catch (err) {
      console.error('[QLS] 批量写入失败，正在回滚:', err)
      // 不能只还原先前成功的条目：抛错的 setItem 在非标准实现中也可能已产生写入。
      for (const [key, oldRaw] of snapshots) {
        try {
          if (oldRaw === null) localStorage.removeItem(key)
          else localStorage.setItem(key, oldRaw)
        } catch { /* 回滚失败只能交由浏览器保留现状 */ }
      }
      return fail('导入失败：本地数据未更改，请检查可用空间或浏览器存储权限')
    }
    return entries.length
  },

  /** 估算当前 localStorage 已用字节数（遍历全部键值对） */
  estimateUsage() {
    try {
      let bytes = 0
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        bytes += (k?.length || 0) * 2 + (localStorage.getItem(k)?.length || 0) * 2
      }
      return bytes
    } catch {
      return -1
    }
  },

  async estimateQuota() {
    return null
  },
}

svcLocalStorageModule.localStoreBackend = localBackend
