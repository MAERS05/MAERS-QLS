import { metadata as svcMetadata } from './core.js'

const svcDom = {}
export const dom = svcDom

/** MAERS QLS — DOM 查询、安全 HTML 模板与图标片段。 */
// ── 4. DOM 查询与安全 HTML 模板 ─────────────────────────
svcDom.$ = (s, ctx) => (ctx || document).querySelector(s)
svcDom.$$ = (s, ctx) => (ctx || document).querySelectorAll(s)

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

/** 转义文本与属性上下文中的全部敏感字符（含引号，防止属性注入） */
svcDom.esc = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ESC_MAP[ch])

/** 已确认安全的 HTML 片段；只能由 QLS.html / QLS.raw 构造 */
class SafeHtml {
  constructor(value) { this.value = value }
  toString() { return this.value }
}

function renderValue(value) {
  if (value == null || value === false) return ''
  if (value instanceof SafeHtml) return value.value
  if (Array.isArray(value)) return value.map(renderValue).join('')
  return svcDom.esc(value)
}

/**
 * 安全 HTML 标签模板：所有插值默认转义；嵌套 html`` 片段与其数组原样拼接。
 * 用法：QLS.html`<li title="${name}">${items.map(i => QLS.html`<b>${i}</b>`)}</li>`
 */
svcDom.html = (strings, ...values) => {
  let out = strings[0]
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + strings[i + 1]
  }
  return new SafeHtml(out)
}

/** 将可信的静态 HTML（如内置 SVG 图标常量）标记为安全片段；禁止传入任何用户数据 */
svcDom.raw = (value) => new SafeHtml(String(value ?? ''))

/** 渲染 7 大时间分类 SVG 图标片段 */
svcDom.catIcon = (key, size = 15, cls = 'cat-icon') => {
  const icon = svcMetadata.TIME_META[key]?.icon
  return icon ? svcDom.html`<img src="${icon}" width="${size}" height="${size}" class="${cls}" alt="" />` : ''
}

/** 渲染心情 SVG 图标片段 */
svcDom.moodIcon = (key, size = 16, cls = 'cat-icon') => {
  const icon = svcMetadata.MOOD_META[key]?.icon
  return icon ? svcDom.html`<img src="${icon}" width="${size}" height="${size}" class="${cls}" alt="" />` : ''
}

function assertSafe(content) {
  if (!(content instanceof SafeHtml)) {
    throw new TypeError('[QLS] 仅接受 QLS.html 生成的安全 HTML 片段')
  }
}

/** 全系统写入 innerHTML 的唯一入口 */
svcDom.setHTML = (el, content) => {
  if (!el) return
  assertSafe(content)
  el.innerHTML = content.value
}

/** 全系统调用 insertAdjacentHTML 的唯一入口 */
svcDom.insertHTML = (el, position, content) => {
  if (!el) return
  assertSafe(content)
  el.insertAdjacentHTML(position, content.value)
}
