import { metadata as svcMetadata } from '../core.js'
import { dates as svcDates } from '../date-utils.js'
import { idbMerge as svcIdbMerge } from './merge.js'

const svcIdbDrafts = {}
export const idbDrafts = svcIdbDrafts

/** MAERS QLS — 编辑草稿所有权、离页标记与恢复。 */
svcIdbDrafts.createDrafts = ({ cache, tabId, notify, commitMutation, closeChannel }) => {
  const { setRaw, mergeRaw } = svcIdbMerge.merge

  const DRAFT_PREFIX = 'qls_pending_day_'
  const recoveredKeys = []

  const OWNER_LOCK_PREFIX = 'maers-qls-draft-owner:'
  let draftOwnership = 'marker'
  let pageClosing = false
  let releaseOwner = null

  /** 活跃文档持有独占锁；被冻结的页面仍保留所有权，不用心跳超时猜测死亡。 */
  function ownDrafts() {
    if (typeof navigator.locks?.request !== 'function') return Promise.resolve()
    return new Promise(resolve => {
      const lifetime = new Promise(release => { releaseOwner = release })
      const fallback = err => {
        console.warn('[QLS] 页面草稿锁不可用，仅恢复明确离页的草稿:', err)
        resolve()
      }
      try {
        navigator.locks.request(OWNER_LOCK_PREFIX + tabId, async () => {
          draftOwnership = 'lock'
          resolve()
          await lifetime
        }).catch(fallback)
      } catch (err) { fallback(err) }
    })
  }

  window.addEventListener('pagehide', event => {
    if (event.persisted) return
    pageClosing = true
    try {
      const prefix = draftKey('')
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (!key?.startsWith(prefix)) continue
        const draft = JSON.parse(localStorage.getItem(key))
        localStorage.setItem(key, JSON.stringify({ ...draft, closed: true }))
      }
    } catch { /* 无法确认离页的草稿继续保留，不允许其他页面抢先恢复。 */ }
    releaseOwner?.()
    closeChannel()
  })

  const draftKey = key => DRAFT_PREFIX + tabId + ':' + key
  function clearDraft(key, raw) {
    try {
      const saved = localStorage.getItem(draftKey(key))
      if (saved && JSON.parse(saved).raw === raw) localStorage.removeItem(draftKey(key))
    } catch { /* 保留无法确认已提交的草稿 */ }
  }

  /** 成功提交后，较新的草稿以本次提交为基线继续保留。 */
  function settleDraft(key, requested, saved) {
    try {
      const entryKey = draftKey(key)
      const draft = JSON.parse(localStorage.getItem(entryKey) || 'null')
      if (!draft) return
      if (draft.raw === requested) localStorage.removeItem(entryKey)
      else localStorage.setItem(entryKey, JSON.stringify({
        ...draft, key, base: saved, raw: mergeRaw(requested, draft.raw, saved),
      }))
    } catch { /* 冲突或缓存不可用时保留原草稿供恢复 */ }
  }

  async function recover() {
    const drafts = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(DRAFT_PREFIX)) drafts.push([key, localStorage.getItem(key)])
    }
    for (const [entryKey, source] of drafts) {
      try {
        const draft = JSON.parse(source)
        if (!draft || typeof draft.key !== 'string' || !draft.key.startsWith(svcMetadata.QL_PREFIX) ||
            !svcDates.isDateKey(draft.key.slice(svcMetadata.QL_PREFIX.length)) ||
            (draft.raw !== null && typeof draft.raw !== 'string') ||
            (draft.base !== null && typeof draft.base !== 'string')) continue
        if (typeof draft.owner !== 'string' || entryKey !== DRAFT_PREFIX + draft.owner + ':' + draft.key) {
          notify('有旧版编辑草稿未自动恢复，副本已保留')
          continue
        }
        const restore = async () => {
          if (localStorage.getItem(entryKey) !== source) return
          const raw = await commitMutation(draft.key, draft.base, draft.raw)
          setRaw(cache, draft.key, raw)
          recoveredKeys.push(draft.key)
          if (localStorage.getItem(entryKey) === source) localStorage.removeItem(entryKey)
        }
        if (draft.ownership === 'lock' && typeof navigator.locks?.request === 'function') {
          await navigator.locks.request(OWNER_LOCK_PREFIX + draft.owner, { ifAvailable: true }, async lock => {
            if (lock) await restore()
          })
        } else if (draft.closed === true) await restore()
      } catch (err) {
        console.warn('[QLS] 离页草稿尚未恢复，已保留原副本:', err)
        notify('有未恢复的编辑草稿，请检查最新记录后重试，草稿副本已保留')
      }
    }
  }

  const draftStore = {
    /** 每次编辑同步保留草稿；页面销毁不依赖异步 IDB 事务继续运行。 */
    stage(key, value, options) {
      try {
        const previous = JSON.parse(localStorage.getItem(draftKey(key)) || 'null')
        localStorage.setItem(draftKey(key), JSON.stringify({
          owner: tabId, ownership: draftOwnership, closed: pageClosing,
          key, base: options && Object.hasOwn(options, 'base')
            ? (options.base == null ? null : JSON.stringify(options.base))
            : (previous ? previous.base : (cache.get(key) ?? null)),
          raw: value == null ? null : JSON.stringify(value),
        }))
        return true
      } catch (err) {
        console.error('[QLS] 无法保留离页恢复草稿:', err)
        notify('离页恢复草稿不可用，请等待保存完成后离开')
        return false
      }
    },

    discardDraft(key) {
      try { localStorage.removeItem(draftKey(key)) } catch { /* 忽略不可用的恢复缓存 */ }
    },
  }

  return { ownDrafts, clearDraft, settleDraft, recover, recoveredKeys, stage: draftStore.stage, discardDraft: draftStore.discardDraft }
}
