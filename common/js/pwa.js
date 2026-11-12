const svcPwa = {}
export const pwa = svcPwa

/** MAERS QLS — Service Worker 注册。 */
const CORE_SCRIPT_URL = import.meta.url

// ── 13. PWA Service Worker 注册 ────────────────────────
if ('serviceWorker' in navigator && /^https?:$/i.test(window.location?.protocol || '') && CORE_SCRIPT_URL) {
  window.addEventListener('load', () => {
    try {
      const swUrl = new URL('../../sw.js', CORE_SCRIPT_URL)
      const scope = new URL('../../', CORE_SCRIPT_URL).pathname
      navigator.serviceWorker.register(swUrl.href, { scope }).catch(() => {})
    } catch { /* 忽略非标环境异常 */ }
  })
}
