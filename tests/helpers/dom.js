/**
 * MAERS-QLS 测试辅助：基于 jsdom 的真实页面加载器 (tests/helpers/dom.js)
 * 职责：
 * 1. 读取真实 HTML，为模块入口解析 import 图，每个页面持有独立模块缓存；原生加载由 E2E 验证；
 * 2. 补齐 jsdom 未实现的浏览器 API（<dialog> 模态方法、滚动、matchMedia 等）；
 * 3. 每次调用返回独立窗口与独立 localStorage，用例之间互不污染。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const { afterEach } = require('node:test')
const { JSDOM } = require('jsdom')
const { IDBFactory } = require('fake-indexeddb')
const { createModuleLoader } = require('./modules')

const ROOT = path.resolve(__dirname, '..', '..')

/** 同页联动场景仅加载领域 API 模块，由 import 解析依赖。 */
function domainScripts(directory) {
  return [`${directory}/js/api.js`]
}

/** 当前用例创建的全部窗口；页面脚本含 setInterval，不关闭会令进程无法退出 */
const openPages = new Set()
afterEach(() => {
  for (const window of openPages) window.close()
  openPages.clear()
})

/** 补齐 jsdom 缺失的浏览器能力（须在页面脚本执行前安装） */
function installPolyfills(window) {
  const dialogProto = window.HTMLDialogElement?.prototype
  if (dialogProto && typeof dialogProto.showModal !== 'function') {
    dialogProto.showModal = function showModal() {
      this.setAttribute('open', '')
      // 模拟浏览器原生 dialog focusing steps：优先聚焦带 autofocus 的自身或后代，否则聚焦首个可聚焦控件
      const target = this.hasAttribute('autofocus')
        ? this
        : (this.querySelector('[autofocus]') || this.querySelector('input, textarea, select, button, [tabindex]:not([tabindex="-1"])'))
      target?.focus?.()
    }
    dialogProto.show = function show() { this.setAttribute('open', '') }
    dialogProto.close = function close() {
      if (!this.hasAttribute('open')) return
      this.removeAttribute('open')
      this.dispatchEvent(new window.Event('close'))
    }
  }

  const noop = () => {}
  window.Element.prototype.scrollTo ??= noop
  window.Element.prototype.scrollIntoView ??= noop
  window.scrollTo = noop
  const mqlCache = new Map()
  window.matchMedia ??= (query) => {
    if (!mqlCache.has(query)) {
      mqlCache.set(query, {
        matches: false, media: query, addEventListener: noop, removeEventListener: noop,
        addListener: noop, removeListener: noop,
      })
    }
    return mqlCache.get(query)
  }
  window.confirm = () => true
  window.alert = noop
  window.URL.createObjectURL ??= () => 'blob:mock'
  window.URL.revokeObjectURL ??= noop
}

/** 创建一个独立的内存 IndexedDB 工厂；多个页面传入同一工厂即模拟同一浏览器的多个标签页 */
const createIdbFactory = () => new IDBFactory()

/** 轮询等待条件成立（跨标签页广播为异步投递） */
async function waitFor(condition, { timeout = 2000, interval = 5 } = {}) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise(resolve => setTimeout(resolve, interval))
  }
  throw new Error('waitFor 超时：条件未在限定时间内成立')
}

/**
 * 加载页面并执行其脚本
 * @param {string} htmlRel   相对仓库根目录的 HTML 路径，如 'MAERS-Schedule/index.html'
 * @param {object} [options]
 * @param {string[]} [options.extraScripts] 追加执行的脚本（相对仓库根目录），用于模拟多系统同页场景
 * @param {Record<string, unknown>} [options.storage] 预置 localStorage 内容（值自动 JSON 序列化）
 * @param {IDBFactory} [options.indexedDB] 注入 IndexedDB 工厂（同时提供 BroadcastChannel），启用 IndexedDB 主路径；
 *   不传则与默认 jsdom 一致（无 IndexedDB，走 localStorage 降级路径）
 */
function createPage(htmlRel, { extraScripts = [], storage = {}, beforeScripts, indexedDB } = {}) {
  const htmlAbs = path.join(ROOT, htmlRel)
  const htmlDir = path.dirname(htmlAbs)
  const dirUrl = path.posix.dirname(htmlRel.replace(/\\/g, '/'))

  const dom = new JSDOM(fs.readFileSync(htmlAbs, 'utf8'), {
    url: `http://localhost/${dirUrl === '.' ? '' : `${dirUrl}/`}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    beforeParse(window) {
      installPolyfills(window)
      if (indexedDB) {
        window.indexedDB = indexedDB
        window.BroadcastChannel = BroadcastChannel
      }
    },
  })
  const { window } = dom
  openPages.add(window)
  const { document } = window

  for (const [key, value] of Object.entries(storage)) {
    window.localStorage.setItem(key, JSON.stringify(value))
  }
  beforeScripts?.(window)

  const context = dom.getInternalVMContext()
  const loader = createModuleLoader(ROOT, context)
  const declared = [...document.querySelectorAll('script[src]')]
  for (const element of declared) {
    const rel = path.relative(ROOT, path.resolve(htmlDir, element.getAttribute('src')))
    if (element.type === 'module') { loader.load(rel); continue }
    const abs = path.join(ROOT, rel)
    // 以 file:// URL 作为脚本名，Node 的测试覆盖率才会将页面脚本纳入统计
    new vm.Script(fs.readFileSync(abs, 'utf8'), { filename: pathToFileURL(abs).href }).runInContext(context)
  }
  for (const rel of extraScripts) {
    const exports = loader.load(rel)
    // Extra modules simulate another page entry within this document.
    if (exports.MS) window.MS = exports.MS
    if (exports.QL) window.QL = exports.QL
  }

  return {
    dom,
    window,
    document,
    localStorage: window.localStorage,
    QLS: window.QLS,
    QL: window.QL,
    MS: window.MS,
    MAERS_BRIDGE: window.MAERS_BRIDGE,
    /** IndexedDB 路径下等待首次数据载入完成（排在页面自身初始化回调之后） */
    ready: () => new Promise(resolve => window.QLS.onStorageReady(resolve)),
    /** 读取 localStorage 中 JSON 值 */
    read: (key) => JSON.parse(window.localStorage.getItem(key)),
    close: () => window.close(),
  }
}

/** 派发一个冒泡的鼠标点击 */
function click(el) {
  el.dispatchEvent(new el.ownerDocument.defaultView.MouseEvent('click', { bubbles: true, cancelable: true }))
}

/** 设置输入框值并派发 input 事件 */
function type(el, value) {
  el.value = value
  el.dispatchEvent(new el.ownerDocument.defaultView.Event('input', { bubbles: true }))
}

/** 将 jsdom 跨 realm 数组转换为本 realm 普通数组，便于 deepEqual 比较 */
const plain = (value) => JSON.parse(JSON.stringify(value))

module.exports = { ROOT, createPage, createIdbFactory, waitFor, click, type, plain, domainScripts }
