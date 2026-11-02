import { metadata as svcMetadata } from './core.js'
import { dom as svcDom } from './dom.js'
import { storage as svcStorage } from './store.js'

const svcTheme = {}
export const theme = svcTheme

/** MAERS QLS — 主题状态、按钮与系统主题订阅。 */
// ── 12. 主题管理（默认跟随系统，按当前视觉状态动态流转三态循环） ──
const SYSTEM_SVG = svcDom.raw('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>')
const SUN_SVG = svcDom.raw('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>')
const MOON_SVG = svcDom.raw('<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>')

const THEME_MODE_META = {
  system: { icon: SYSTEM_SVG, name: '跟随系统' },
  dark:   { icon: MOON_SVG,   name: '深色模式' },
  light:  { icon: SUN_SVG,    name: '浅色模式' },
}

const darkMql = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : null

/** 获取当前持久化的主题模式配置（'system' | 'dark' | 'light'，默认 'system'） */
svcTheme.getThemeMode = () => {
  const mode = svcStorage.store.get(svcMetadata.THEME_KEY)
  return mode === 'light' || mode === 'dark' ? mode : 'system'
}

/** 获取宿主系统当前偏好的视觉主题（'dark' | 'light'） */
const getSystemTheme = () => (darkMql?.matches ? 'dark' : 'light')

/** 获取当前实际生效的视觉主题（'dark' | 'light'） */
svcTheme.getEffectiveTheme = () => {
  const mode = svcTheme.getThemeMode()
  return mode === 'dark' || mode === 'light' ? mode : getSystemTheme()
}

/**
 * 动态计算下一跳主题模式：
 * - system 下：直接切往与当前系统相反的主题（确保首次点击立即反转视觉明暗）；
 * - 相反主题下：切往与当前系统相同的显式主题；
 * - 相同主题下：回归 system（跟随系统）。
 */
const getNextThemeMode = (mode = svcTheme.getThemeMode()) => {
  const sys = getSystemTheme()
  const opp = sys === 'dark' ? 'light' : 'dark'
  if (mode === 'system') return opp
  if (mode === opp) return sys
  return 'system'
}

svcTheme.updateThemeButtons = () => {
  const mode = svcTheme.getThemeMode()
  const next = getNextThemeMode(mode)
  const isDark = svcTheme.getEffectiveTheme() === 'dark'
  const { icon, name } = THEME_MODE_META[mode] || THEME_MODE_META.system
  const nextName = (THEME_MODE_META[next] || THEME_MODE_META.system).name
  const label = `当前：${name}（点击切换为${nextName}）`
  document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
    btn.setAttribute('aria-label', label)
    btn.setAttribute('title', label)
    btn.setAttribute('data-theme-mode', mode)
    svcDom.setHTML(btn, icon)
  })
  const themeMeta = document.querySelector('meta[name="theme-color"]')
  if (themeMeta) themeMeta.setAttribute('content', isDark ? '#141619' : '#f3efe6')
}

svcTheme.applyTheme = () => {
  document.documentElement.setAttribute('data-theme', svcTheme.getEffectiveTheme())
  document.documentElement.setAttribute('data-theme-mode', svcTheme.getThemeMode())
  svcTheme.updateThemeButtons()
}

svcTheme.setThemeMode = (mode) => {
  const valid = mode === 'light' || mode === 'dark' ? mode : 'system'
  svcStorage.store.set(svcMetadata.THEME_KEY, valid)
  svcTheme.applyTheme()
  return valid
}

svcTheme.toggleTheme = () => svcTheme.setThemeMode(getNextThemeMode())

svcTheme.initTheme = () => {
  document.documentElement.setAttribute('data-theme', svcTheme.getEffectiveTheme())
  document.documentElement.setAttribute('data-theme-mode', svcTheme.getThemeMode())
  darkMql?.addEventListener?.('change', () => svcTheme.applyTheme())
  window.addEventListener?.('storage', (e) => {
    if (e.key === svcMetadata.THEME_KEY) svcTheme.applyTheme()
  })
  svcStorage.onStoreChange(keys => { if (keys.includes(svcMetadata.THEME_KEY)) svcTheme.applyTheme() })
  const bind = () => {
    svcTheme.updateThemeButtons()
    document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
      if (btn.dataset.themeBound) return
      btn.dataset.themeBound = '1'
      btn.addEventListener('click', () => svcTheme.toggleTheme())
    })
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind)
  else bind()
}

svcTheme.initTheme()
