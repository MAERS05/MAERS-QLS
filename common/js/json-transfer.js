import { metadata as svcMetadata } from './core.js'
import { ui as svcUi } from './ui.js'

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

/** 绑定 JSON 文件选择框；超出体积上限或解析失败时走 onError（默认 Toast 提示） */
svcJsonTransfer.bindJsonFileInput = (fileInputEl, onParsed, onError) => {
  if (!fileInputEl) return
  const fail = (msg, err) => {
    if (onError) onError(err || new Error(msg))
    else svcUi.showToast(msg)
  }
  fileInputEl.addEventListener('change', async () => {
    const file = fileInputEl.files[0]
    fileInputEl.value = ''
    if (!file) return
    if (file.size > svcMetadata.MAX_IMPORT_BYTES) {
      fail('❌ 文件过大，备份文件不应超过 10MB')
      return
    }
    try {
      onParsed(JSON.parse(await file.text()))
    } catch (err) {
      fail('❌ 文件格式错误，请选择有效的 JSON 备份文件', err)
    }
  })
}
