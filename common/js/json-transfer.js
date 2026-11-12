import { metadata as svcMetadata } from './core.js'
import { ui as svcUi } from './ui.js'
import { storage } from './store.js'
import { transferFormat } from './transfer-format.js'
import { transferPolicy } from './transfer-policy.js'

const svcJsonTransfer = {}
export const jsonTransfer = svcJsonTransfer

/** MAERS QLS — 备份信封、JSON 下载与文件读取。 */
// ── 6. 备份信封 ───────────────────────────────────────
/** 将导出数据包装为带应用标识与版本号的信封 */
svcJsonTransfer.createBackup = (data) => ({
  app: svcMetadata.BACKUP_APP,
  version: svcMetadata.BACKUP_VERSION,
  exportedAt: new Date().toISOString(),
  data,
})

/**
 * 解析备份文件：校验信封标识（app === 'MAERS-QLS'）与版本号。
 * 返回 null 表示文件结构无效或版本高于当前程序。
 */
svcJsonTransfer.unwrapBackup = (json) => {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  if (json.app !== svcMetadata.BACKUP_APP) return null
  if (!Number.isInteger(json.version) || json.version > svcMetadata.BACKUP_VERSION) return null
  const data = json.data
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null
}

svcJsonTransfer.isEmptyBackup = json => {
  const data = svcJsonTransfer.unwrapBackup(json)
  return data !== null && Object.keys(data).length === 0
}

/** 替换先清空所选子系统；主页同时选择两个子系统。返回 null 表示保存失败。 */
svcJsonTransfer.importEntries = async (entries, mode, prefixes) => {
  transferPolicy.validate(mode)
  const store = storage.store
  if (mode === 'replace' && store.mode === 'indexeddb') {
    try {
      const local = await store.transferSnapshot()
      const data = Object.fromEntries(Object.entries(local.data).filter(([key]) => !prefixes.some(prefix => key.startsWith(prefix))))
      entries.forEach(({ key, value }) => { data[key] = value })
      const text = JSON.stringify(data)
      const quota = await store.estimateQuota()
      if (quota?.quota && Number.isFinite(quota.usage) && quota.usage + transferFormat.bytes(text).length * 2 > quota.quota) {
        throw new Error('本地可用空间不足，原数据未更改')
      }
      await store.replaceSnapshot(data, { baseline: local.baseline, id: svcMetadata.uid('import_'),
        checksum: transferFormat.checksum(transferFormat.bytes(text)), syncSchedule: true })
      return { count: entries.length }
    } catch (error) {
      svcUi.showToast('导入失败：' + error.message)
      return null
    }
  }
  if (entries.length === 0 && mode !== 'replace') return { count: 0 }
  const count = await store.batchSet(entries, { mode, replacePrefixes: mode === 'replace' ? prefixes : [] })
  return count > 0 ? { count: entries.length } : null
}

svcJsonTransfer.chooseImportMode = ({ empty = false } = {}) => new Promise(resolve => {
  const dialog = document.createElement('dialog')
  dialog.className = 'modal-dialog data-import-dialog'
  dialog.id = 'data-import-dialog'
  dialog.setAttribute('aria-labelledby', 'data-import-title')
  dialog.innerHTML = `<section class="data-import-panel">
    <h2 id="data-import-title">导入数据</h2>
    <p id="data-import-scope" class="data-mode-help" aria-live="polite"></p>
    <div class="data-mode-field"><label for="data-import-mode">数据处理方式</label>
      <select id="data-import-mode" aria-describedby="data-import-scope"></select>
    </div>
    <div class="data-import-actions"><button type="button" id="data-import-cancel">取消</button>
      <button type="button" id="data-import-accept" class="data-import-primary">确认替换</button></div>
  </section>`
  const select = dialog.querySelector('select')
  Object.entries(transferPolicy.modes).forEach(([value, label]) => select.add(new Option(label, value)))
  const scopeText = {
    replace: '不保留本机数据',
    'merge-skip': '保留本机数据并跳过与本机冲突部分',
    'merge-overwrite': '保留本机数据并覆盖与本机冲突部分',
  }
  const scope = dialog.querySelector('#data-import-scope')
  const accept = dialog.querySelector('#data-import-accept')
  const update = () => {
    scope.textContent = '导入范围：' + scopeText[select.value]
    accept.textContent = select.value === 'replace' ? (empty ? '确认清空' : '确认替换') : '确认合并'
  }
  select.addEventListener('change', update)
  let selected = null
  accept.addEventListener('click', () => { selected = select.value; svcUi.closeDialog(dialog) })
  dialog.querySelector('#data-import-cancel').addEventListener('click', () => svcUi.closeDialog(dialog))
  svcUi.bindDialog(dialog, { lightDismiss: false, onClose: () => { dialog.remove(); resolve(selected) } })
  update(); document.body.append(dialog); svcUi.openDialog(dialog)
})

// ── 11. JSON 备份下载与文件读取 ────────────────────────
svcJsonTransfer.downloadJson = (filename, data) => {
  const content = JSON.stringify(data, null, 2)
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  // 延迟 60 秒释放，防止移动端浏览器在用户点击下载确认弹窗前提前回收 Blob URL
  window.setTimeout(() => URL.revokeObjectURL(url), 60000)
}

/** 文件选择与拖放共用读取、大小校验和导入确认流程。 */
svcJsonTransfer.bindJsonFileInput = (fileInputEl, onParsed, onError, dropTarget = null) => {
  if (!fileInputEl) return
  let importing = false
  const fail = (msg, err) => {
    if (onError) onError(err || new Error(msg))
    else svcUi.showToast(msg)
  }
  const readFile = async file => {
    if (!file) return
    if (importing) { fail('请先完成或取消当前导入'); return }
    if (file.size > svcMetadata.MAX_IMPORT_BYTES) {
      fail('❌ 文件过大，备份文件不应超过 10MB')
      return
    }
    importing = true
    try {
      await onParsed(JSON.parse(await file.text()))
    } catch (err) {
      fail('❌ 文件格式错误，请选择有效的 JSON 备份文件', err)
    } finally {
      importing = false
    }
  }
  fileInputEl.addEventListener('change', () => {
    const file = fileInputEl.files[0]
    fileInputEl.value = ''
    void readFile(file)
  })
  if (!dropTarget) return
  dropTarget.dataset.jsonDrop = 'true'
  dropTarget.title += '（支持拖入 JSON 备份文件）'
  let dragDepth = 0
  const isFileDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files')
  const clearDrag = () => { dragDepth = 0; dropTarget.classList.remove('is-file-dragover') }
  dropTarget.addEventListener('dragenter', event => {
    if (!isFileDrag(event)) return
    event.preventDefault(); dragDepth++; dropTarget.classList.add('is-file-dragover')
  })
  dropTarget.addEventListener('dragover', event => {
    if (!isFileDrag(event)) return
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy'
  })
  dropTarget.addEventListener('dragleave', () => { if (--dragDepth <= 0) clearDrag() })
  dropTarget.addEventListener('drop', event => {
    if (!isFileDrag(event)) return
    event.preventDefault(); event.stopPropagation(); clearDrag()
    const files = event.dataTransfer.files
    if (files.length !== 1) { fail('请一次导入一个 JSON 备份文件'); return }
    void readFile(files[0])
  })
  document.addEventListener('dragover', event => { if (isFileDrag(event)) event.preventDefault() })
  document.addEventListener('drop', event => {
    if (!isFileDrag(event)) return
    event.preventDefault(); clearDrag(); fail('请将备份文件拖到导入按钮上')
  })
  window.addEventListener('blur', clearDrag)
}
