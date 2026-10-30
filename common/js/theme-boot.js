/**
 * MAERS QLS — 主题预加载脚本 (common/js/theme-boot.js)
 * 在 <head> 中同步执行，于首帧绘制前设置 data-theme，避免明暗主题闪烁。
 * 独立为外部文件以满足 CSP script-src 'self'（禁止内联脚本）。
 */
;(function () {
  'use strict'
  let mode = 'system'
  try {
    const saved = JSON.parse(localStorage.getItem('qls_theme'))
    if (saved === 'light' || saved === 'dark' || saved === 'system') mode = saved
  } catch (err) {
    // 存储不可用或数据损坏时回退跟随系统
  }
  const sysDark = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
  const theme = mode === 'dark' || (mode === 'system' && sysDark) ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', theme)
  document.documentElement.setAttribute('data-theme-mode', mode)
})()
