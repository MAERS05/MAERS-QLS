import { bridge as svcBridge } from './bridge.js'
import { metadata as svcMetadata } from './core.js'
import { dates as svcDates } from './date-utils.js'
import { dom as svcDom } from './dom.js'
import { storageState as svcStorageState } from './idb-store.js'
import { storage as svcStorage } from './store.js'
import { ui as svcUi } from './ui.js'

const svcBridgeUI = {}
export const bridgeUI = svcBridgeUI

function initialize() {
  /**
   * MAERS QLS — 桥接层界面 (common/js/bridge-ui.js)
   * 职责：在 Schedule 顶栏注入「QuantiLife 今日记录」按钮与浮窗，并订阅桥接数据变化刷新摘要。
   * 与数据层 bridge.js 仅通过事件（QLS.BRIDGE_CHANGED_EVENT / QLS.onStoreChange）解耦通信。
   */
  const Bridge = svcBridge
  const html = svcDom.html

  function render() {
    const container = document.getElementById('ql-bridge-items')
    if (!container) return

    const dateStr = svcDates.today()
    const bridge = Bridge.getTodayBridge(dateStr)
    const viewed = bridge.length > 0 && Bridge.isViewed(dateStr, bridge)
    document.querySelectorAll('.ql-record-btn').forEach(btn => {
      btn.classList.toggle('has-data', bridge.length > 0)
      btn.classList.toggle('viewed', viewed)
    })

    svcDom.setHTML(container, bridge.length === 0
      ? html`<div class="ql-bridge-empty">今日 QuantiLife 暂无记录</div>`
      : html`${bridge.map(item => html`
          <div class="ql-bridge-item">
            <span class="ql-bridge-name">${item.tag}</span>
            <span class="ql-bridge-hours">${item.fmtHours}</span>
          </div>`)}`)
  }

  function mount() {
    if (document.getElementById('ql-record-btn')) return

    svcDom.insertHTML(document.body, 'beforeend', html`
      <dialog class="ql-record-dialog" id="ql-record-panel" aria-labelledby="ql-record-title">
        <div class="ql-record-panel">
          <div class="ql-record-panel-header">
            <h2 class="ql-record-panel-title" id="ql-record-title">QuantiLife 今日记录</h2>
            <button type="button" class="ql-record-close" id="ql-record-close" aria-label="关闭">✕</button>
          </div>
          <div class="ql-record-date" id="ql-record-date"></div>
          <div class="ql-record-body" id="ql-bridge-items"></div>
        </div>
      </dialog>
    `)

    const panel = document.getElementById('ql-record-panel')
    const dateEl = document.getElementById('ql-record-date')
    svcUi.bindDialog(panel)
    document.getElementById('ql-record-close').addEventListener('click', () => svcUi.closeDialog(panel))

    const openPanel = () => {
      const dateStr = svcDates.today()
      dateEl.textContent = svcDates.formatDate(dateStr)
      Bridge.markViewed(dateStr)
      render()
      svcUi.openDialog(panel)
    }

    const headerActions = document.getElementById('header-tools')
    if (headerActions) {
      const btnHtml = html`
        <button type="button" class="header-icon-btn ql-record-btn" id="ql-record-btn"
                title="QuantiLife 今日记录" aria-label="QuantiLife 今日记录" aria-haspopup="dialog">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <line x1="18" y1="20" x2="18" y2="9"/>
            <line x1="12" y1="20" x2="12" y2="3"/>
            <line x1="6"  y1="20" x2="6"  y2="14"/>
          </svg>
          <span class="ql-dot"></span>
        </button>
      `
      const themeBtn = headerActions.querySelector('[data-theme-toggle]')
      if (themeBtn) svcDom.insertHTML(themeBtn, 'afterend', btnHtml)
      else svcDom.insertHTML(headerActions, 'afterbegin', btnHtml)
      document.getElementById('ql-record-btn').addEventListener('click', openPanel)
    }
    render()
  }

  // 数据层同步完成、进行中视图重绘、其他标签页改写了 QuantiLife 数据时刷新摘要
  svcStorage.on(svcMetadata.BRIDGE_CHANGED_EVENT, render)
  svcStorage.onStoreChange(keys => {
    if (keys.some(key => key.startsWith(svcMetadata.QL_PREFIX) || key.startsWith(svcMetadata.BRIDGE_VIEWED_PREFIX))) render()
  })
  svcStorageState.onStorageReady(mount)

  Object.assign(svcBridgeUI, { render })
}
initialize()
