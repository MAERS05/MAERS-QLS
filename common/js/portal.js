import { quantiTransfer as svcQuantiTransfer } from '../../MAERS-QuantiLife/js/data-transfer.js'
import { scheduleTransfer as svcScheduleTransfer } from '../../MAERS-Schedule/js/data-transfer.js'
import { metadata as svcMetadata } from './core.js'
import { dates as svcDates } from './date-utils.js'
import { dom as svcDom } from './dom.js'
import { storageState as svcStorageState } from './idb-store.js'
import { jsonTransfer as svcJsonTransfer } from './json-transfer.js'
import { storage as svcStorage } from './store.js'
import { ui as svcUi } from './ui.js'

const svcPortal = {}
export const portal = svcPortal

/**
 * MAERS QLS — 门户页全局备份与默认入口设置控制器 (common/js/portal.js)
 * 职责：
 * 1. 导出两个子系统的全部数据为单一备份信封；导入时交由各子系统领域层逐键校验与规范化；
 * 2. 管理并持久化 Schedule（规划表 / 时间轴 / 进行中）与 QuantiLife（量化记录 / 报告）的默认入口配置。
 */
const $ = svcDom.$
const $$ = svcDom.$$
const store = svcStorage.store
const createBackup = svcJsonTransfer.createBackup
const QL_PREFIX = svcMetadata.QL_PREFIX
const MS_PREFIX = svcMetadata.MS_PREFIX
const SCH_ENTRY_KEY = svcMetadata.SCH_ENTRY_KEY
const QL_ENTRY_KEY = svcMetadata.QL_ENTRY_KEY
const today = svcDates.today
const downloadJson = svcJsonTransfer.downloadJson
const bindJsonFileInput = svcJsonTransfer.bindJsonFileInput
const showToast = svcUi.showToast

const SCH_VALID = new Set(['timeblock', 'timeline', 'inprogress'])
const QL_HREFS = {
  index:  'MAERS-QuantiLife/index.html',
  report: 'MAERS-QuantiLife/report.html',
}

function closeAllEntryPopovers() {
  $$('.entry-settings').forEach(wrap => {
    wrap.classList.remove('open')
    wrap.closest('.launcher-card-shell')?.classList.remove('is-open')
    wrap.querySelector('.entry-settings-btn')?.setAttribute('aria-expanded', 'false')
    const pop = wrap.querySelector('.entry-settings-popover')
    if (pop) pop.hidden = true
  })
}

function syncEntryUI() {
  const schVal = store.get(SCH_ENTRY_KEY, 'timeblock')
  const activeSch = SCH_VALID.has(schVal) ? schVal : 'timeblock'
  const qlVal = store.get(QL_ENTRY_KEY, 'index')
  const activeQl = QL_HREFS[qlVal] ? qlVal : 'index'

  $$('.entry-opt[data-entry-app="sch"]').forEach(btn => {
    const on = btn.dataset.entryVal === activeSch
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-pressed', String(on))
  })
  $$('.entry-opt[data-entry-app="ql"]').forEach(btn => {
    const on = btn.dataset.entryVal === activeQl
    btn.classList.toggle('active', on)
    btn.setAttribute('aria-pressed', String(on))
  })

  const qlLink = $('#link-ql')
  if (qlLink) qlLink.setAttribute('href', QL_HREFS[activeQl])
}

document.addEventListener('click', e => {
  const toggleBtn = e.target.closest('[data-entry-toggle]')
  if (toggleBtn) {
    const wrap = toggleBtn.closest('.entry-settings')
    const pop = wrap?.querySelector('.entry-settings-popover')
    const willOpen = pop ? pop.hidden : false
    closeAllEntryPopovers()
    if (wrap && pop && willOpen) {
      wrap.classList.add('open')
      wrap.closest('.launcher-card-shell')?.classList.add('is-open')
      toggleBtn.setAttribute('aria-expanded', 'true')
      pop.hidden = false
    }
    return
  }

  const optBtn = e.target.closest('.entry-opt')
  if (optBtn) {
    const app = optBtn.dataset.entryApp
    const val = optBtn.dataset.entryVal
    if (app === 'sch' && SCH_VALID.has(val)) store.set(SCH_ENTRY_KEY, val)
    else if (app === 'ql' && QL_HREFS[val]) store.set(QL_ENTRY_KEY, val)
    syncEntryUI()
    closeAllEntryPopovers()
    return
  }

  if (!e.target.closest('.entry-settings')) closeAllEntryPopovers()
})

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeAllEntryPopovers()
})

function formatLastBackup(isoString) {
  if (!isoString) return '从未'
  const exportDate = new Date(isoString)
  if (isNaN(exportDate.getTime())) return '从未'
  const now = new Date()
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const exportMidnight = new Date(exportDate.getFullYear(), exportDate.getMonth(), exportDate.getDate()).getTime()
  const diffDays = Math.max(0, Math.floor((todayMidnight - exportMidnight) / (24 * 60 * 60 * 1000)))
  return `${diffDays}天前`
}

function updateLastExportUI() {
  const el = $('#backup-status')
  if (!el) return
  const raw = store.get(svcMetadata.LAST_EXPORT_KEY)
  el.textContent = `上次导出备份: ${formatLastBackup(raw)}`
}

syncEntryUI()
updateLastExportUI()

svcStorageState.onStorageReady(() => {
  syncEntryUI()
  updateLastExportUI()

  // 全局备份导出：完整键名 + 信封格式，可被任一子系统单独导入（不弹 Toast，交由浏览器原生下载弹窗提示）
  $('#qls-export-btn').addEventListener('click', () => {
    downloadJson(`qls-backup-${today()}.json`, createBackup(store.dump([QL_PREFIX, MS_PREFIX])))
    store.set(svcMetadata.LAST_EXPORT_KEY, new Date().toISOString())
    updateLastExportUI()
  })

  // 全局备份导入：各子系统只认领自己的已知键，未知键与非法值被忽略
  const importFile = $('#qls-import-file')
  $('#qls-import-btn').addEventListener('click', () => importFile.click())
  bindJsonFileInput(importFile, async (json) => {
    // 跨系统原子导入：两个子系统的条目合并后一次性 batchSet，中途失败全部回滚
    const ql = svcQuantiTransfer.prepareImportEntries(json)
    const ms = svcScheduleTransfer.prepareImportEntries(json)
    const allEntries = [...ql.entries, ...ms.entries]
    if (allEntries.length === 0) {
      showToast('⚠️ 备份文件中没有可识别的 QLS 数据')
      return
    }
    // 写入失败时 batchSet 已自行提示具体原因并完成回滚，此处不再追加提示
    const count = await store.batchSet(allEntries)
    if (count === 0) return
    syncEntryUI()
    updateLastExportUI()
    showToast(`📥 已恢复 ${count} 条 QLS 数据记录`)
  })
})
