import { dom as svcDom } from './dom.js'
import { storageState as svcStorageState } from './idb-store.js'
import { storage as svcStorage } from './store.js'
import { ui as svcUi } from './ui.js'

const svcProjectGuide = {}
export const projectGuide = svcProjectGuide

function initialize() {
  /** 主页项目使用说明弹窗（含首次访问黄点提示） */
  const $ = svcDom.$
const openDialog = svcUi.openDialog
const bindDialog = svcUi.bindDialog
const store = svcStorage.store
  const GUIDE_SEEN_KEY = 'qls_guide_seen'
  const dialog = $('#project-guide-dialog')
  const btn = $('#project-guide-btn')
  if (!dialog || !btn) return

  bindDialog(dialog)

  // 首次访问时在按钮右上角显示未读黄点
  function syncBadge() {
    btn.classList.toggle('has-badge', !store.get(GUIDE_SEEN_KEY))
  }

  btn.addEventListener('click', () => {
    store.set(GUIDE_SEEN_KEY, true)
    syncBadge()
    openDialog(dialog)
  })

  dialog.querySelectorAll('[data-guide-close]').forEach((button) => {
    button.addEventListener('click', () => dialog.close())
  })

  // 仅在异步存储就绪后刷新徽标状态，避免 IndexedDB 尚未载入时误判为未读导致黄点闪烁
  svcStorageState.onStorageReady(syncBadge)
}
initialize()
