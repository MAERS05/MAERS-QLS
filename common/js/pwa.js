import { ui as svcUi } from './ui.js'

const svcPwa = {}
export const pwa = svcPwa

/** MAERS QLS — Service Worker 注册与版本更新提示。 */
const CORE_SCRIPT_URL = import.meta.url

// ── 13. PWA Service Worker 注册 ────────────────────────
if ('serviceWorker' in navigator && /^https?:$/i.test(window.location?.protocol || '') && CORE_SCRIPT_URL) {
  // 仅当页面加载时已有 SW 控制，随后控制权发生变化才说明发布了新版本（首次安装的 claim 不提示）
  const hadController = !!navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController) svcUi.showToast('🔄 已发布新版本，刷新页面即可使用')
  })
  window.addEventListener('load', () => {
    try {
      const swUrl = new URL('../../sw.js', CORE_SCRIPT_URL)
      const scope = new URL('../../', CORE_SCRIPT_URL).pathname
      navigator.serviceWorker.register(swUrl.href, { scope }).catch(() => {})
    } catch { /* 忽略非标环境异常 */ }
  })
}
