/**
 * 公共核心层单元测试 (tests/unit/core.test.js)
 * 覆盖：安全 HTML 模板、存储层、备份信封、日期时钟工具、数据规范化、原生 dialog 辅助。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, click, plain } = require('../helpers/dom')

/** 以门户页加载完整公共模块，创建隔离环境。 */
const setup = () => createPage('MAERS-QuantiLife/report.html')

test('安全 HTML 模板：插值默认转义，嵌套片段原样拼接，setHTML 拒绝裸字符串', () => {
  const { QLS, document } = setup()
  const evil = '<img src=x onerror="alert(1)">\'"'
  const out = QLS.html`<p title="${evil}">${evil}</p>`.toString()
  assert.ok(!out.includes('<img'), '插值内容中的标签必须被转义')
  assert.ok(out.includes('&lt;img'))
  assert.ok(out.includes('&quot;') && out.includes('&#39;'), '属性上下文的引号必须被转义')

  const nested = QLS.html`<ul>${['a', 'b'].map(v => QLS.html`<li>${v}</li>`)}</ul>`.toString()
  assert.equal(nested, '<ul><li>a</li><li>b</li></ul>')

  const host = document.createElement('div')
  assert.throws(() => QLS.setHTML(host, '<b>raw</b>'), /仅接受 QLS\.html/, '裸字符串不得写入 innerHTML')
  QLS.setHTML(host, QLS.html`<b>${'ok'}</b>`)
  assert.equal(host.innerHTML, '<b>ok</b>')
})

test('存储层：读写、默认值、前缀枚举与脏 JSON 容错', () => {
  const { QLS, localStorage } = setup()
  const { store } = QLS
  assert.equal(store.get('missing', 'fallback'), 'fallback')
  assert.equal(store.set('quantilife_a', { v: 1 }), true)
  assert.deepEqual(plain(store.get('quantilife_a')), { v: 1 })
  assert.equal(store.has('quantilife_a'), true)

  localStorage.setItem('quantilife_dirty', '{not json')
  // 脏数据会触发预期内的告警，用例内静音
  const originalWarn = console.warn
  console.warn = () => {}
  try {
    assert.equal(store.get('quantilife_dirty', 'safe'), 'safe', '无法解析的数据应回退到默认值')
  } finally {
    console.warn = originalWarn
  }

  store.set('schedule_x', 1)
  assert.deepEqual(plain(store.keys('quantilife_').sort()), ['quantilife_a', 'quantilife_dirty'])
  assert.deepEqual(plain(Object.keys(store.dump(['schedule_']))), ['schedule_x'], 'dump 仅导出可解析且匹配前缀的数据')

  store.remove('quantilife_a')
  assert.equal(store.has('quantilife_a'), false)
})

test('存储层：写入失败提示通用原因，批量写入连同失败条目完整回滚', async () => {
  const { QLS, localStorage, window } = setup()
  const proto = Object.getPrototypeOf(localStorage)
  const originalSetItem = proto.setItem
  const originalError = console.error
  const toasts = []
  QLS.showToast = message => toasts.push(message)
  console.error = () => {}

  try {
    Object.defineProperty(proto, 'setItem', {
      configurable: true,
      value(key, value) {
        if (key === 'single_fail') throw new Error('storage unavailable')
        return originalSetItem.call(this, key, value)
      },
    })
    assert.equal(QLS.store.set('single_fail', { v: 1 }), false)
    await new Promise(resolve => window.setTimeout(resolve, 0))
    assert.match(toasts.pop(), /可用空间或浏览器存储权限/, '失败提示不得武断归因于空间不足')

    originalSetItem.call(localStorage, 'first', JSON.stringify('old-first'))
    originalSetItem.call(localStorage, 'failed', JSON.stringify('old-failed'))
    Object.defineProperty(proto, 'setItem', {
      configurable: true,
      value(key, value) {
        if (key === 'failed') {
          // 模拟非标准实现：写入已经发生，但仍抛出了异常。
          originalSetItem.call(this, key, value)
          throw new Error('quota exceeded')
        }
        return originalSetItem.call(this, key, value)
      },
    })
    assert.equal(QLS.store.batchSet([
      { key: 'first', value: 'new-first' },
      { key: 'failed', value: 'new-failed' },
    ]), 0)
    assert.equal(localStorage.getItem('first'), JSON.stringify('old-first'))
    assert.equal(localStorage.getItem('failed'), JSON.stringify('old-failed'), '抛错的当前条目也必须恢复')
  } finally {
    Object.defineProperty(proto, 'setItem', { configurable: true, value: originalSetItem })
    console.error = originalError
  }
})

test('备份信封：版本与应用标识严格校验', () => {
  const { QLS } = setup()
  const wrapped = plain(QLS.createBackup({ k: 1 }))
  assert.equal(wrapped.app, 'MAERS-QLS')
  assert.deepEqual(plain(QLS.unwrapBackup(wrapped)), { k: 1 })

  assert.equal(QLS.unwrapBackup({ app: 'MAERS-QLS', version: QLS.BACKUP_VERSION + 1, data: {} }), null, '高版本备份必须拒绝')
  assert.equal(QLS.unwrapBackup({ app: 'MAERS-QLS', version: 1, data: [] }), null, 'data 非对象必须拒绝')
  assert.equal(QLS.unwrapBackup(null), null)
  assert.equal(QLS.unwrapBackup([]), null)
  assert.equal(QLS.unwrapBackup({ quantilife_2026: 1 }), null, '无信封的裸对象必须拒绝')
})

test('日期与时钟：严格校验、边界值与四舍五入', () => {
  const { QLS, window } = setup()
  const D = window.Date // 必须使用窗口内的 Date，否则 instanceof 判断跨 realm 失效
  assert.equal(QLS.isDateKey('2026-02-29'), false, '非闰年 2 月 29 日不得被自动进位')
  assert.equal(QLS.isDateKey('2028-02-29'), true)
  assert.equal(QLS.isDateKey('2026-13-01'), false)
  assert.equal(QLS.normalizeDateKey('2026-3-5'), '2026-03-05')
  assert.equal(QLS.normalizeDateKey('garbage'), '')

  const local = QLS.parseDateKey('2026-10-15')
  assert.deepEqual([local.getFullYear(), local.getMonth(), local.getDate()], [2026, 9, 15], '必须按本地时区解析')

  assert.equal(QLS.parseClock('24:00').value, '24:00', '24:00 可作为当日结束边界')
  assert.equal(QLS.parseClock('24:01'), null)
  assert.equal(QLS.parseClock('9:60'), null)
  assert.equal(QLS.clockToHours('09:30'), 9.5)
  assert.equal(QLS.clockToHours('bad'), 0)

  assert.equal(QLS.fmtH(0.999), '1h', '四舍五入后不应显示 0h60m')
  assert.equal(QLS.fmtH(1.75), '1h45m')
  assert.equal(QLS.fmtH(0), '0m')
  assert.equal(QLS.fmtClock(9.999), '10:00', '四舍五入后不应显示 09:60')
  assert.equal(QLS.fmtClock(30), '24:00', '超出范围应夹紧到 24:00')

  assert.match(QLS.formatDateCN(new D(2026, 9, 15)), /^2026年10月15日 周/)
  assert.equal(QLS.formatDate('2026-10-15'), '10月15日')
  assert.equal(QLS.getDaysInRange(new D(2026, 9, 14), new D(2026, 9, 16)).length, 3)
})

test('数据契约：饮食条目数值归一化，分类色彩与标签解析一致', () => {
  const { QLS } = setup()
  const diet = QLS.normalizeDietItem({ name: '燕麦', cal: '320', carb: '58.5', protein: 11 })
  assert.deepEqual(plain(diet), { name: '燕麦', carb: 58.5, protein: 11, fat: 0, cal: 320 })

  for (const key of QLS.TIME_KEYS) {
    assert.equal(QLS.categoryFromLegacyColor(QLS.TIME_META[key].color), key, `${key} 的颜色必须可反查回分类`)
  }
  assert.equal(new Set(QLS.TIME_KEYS.map(k => QLS.TIME_META[k].color)).size, QLS.TIME_KEYS.length, '分类颜色必须互不重复')

  assert.equal(QLS.resolveTagCategory('编程', { 编程: 'career' }), 'career')
  assert.equal(QLS.resolveTagCategory('learn'), 'learn', '分类 key 本身可直接解析')
  assert.equal(QLS.resolveTagCategory('学习内养'), 'learn', '不含「类」字的中文名可解析')
  assert.equal(QLS.resolveTagCategory('未登记'), null)
})

test('uid 唯一性：同一毫秒连续生成不碰撞', () => {
  const { QLS } = setup()
  const ids = new Set(Array.from({ length: 500 }, () => QLS.uid('t_')))
  assert.equal(ids.size, 500)
})

test('dialog 辅助：开关、onClose 收尾与背景点击关闭', () => {
  const { QLS, document, window } = setup()
  const dlg = document.createElement('dialog')
  dlg.innerHTML = '<button id="inner">x</button>'
  document.body.appendChild(dlg)

  let closed = 0
  QLS.bindDialog(dlg, { onClose: () => { closed++ } })
  QLS.bindDialog(dlg, { onClose: () => { closed += 100 } }) // 重复绑定必须被忽略

  QLS.openDialog(dlg, { focus: '#inner' })
  assert.equal(dlg.open, true)
  QLS.closeDialog(dlg)
  assert.equal(dlg.open, false)
  assert.equal(closed, 1, 'close 事件只触发一次 onClose，重复绑定无效')

  // 背景点击：按下与松开均发生在 dialog 自身上才关闭
  QLS.openDialog(dlg)
  dlg.dispatchEvent(new window.Event('pointerdown', { bubbles: true }))
  click(dlg)
  assert.equal(dlg.open, false, '背景点击应关闭弹窗')

  QLS.openDialog(dlg)
  click(dlg.querySelector('#inner'))
  assert.equal(dlg.open, true, '点击面板内部不得关闭弹窗')
})

test('主题：默认跟随系统，按系统当前明暗状态动态决定下一跳并同步 data-theme', () => {
  const { window, QLS, document, localStorage } = setup()
  const mql = window.matchMedia('(prefers-color-scheme: dark)')

  // 1. 系统为浅色时：system(light) → dark → light → system
  assert.equal(QLS.getThemeMode(), 'system', '默认模式应为跟随系统')
  assert.equal(document.documentElement.getAttribute('data-theme-mode'), 'system')
  assert.equal(QLS.getEffectiveTheme(), 'light')
  assert.equal(QLS.toggleTheme(), 'dark', '系统浅色时首次点击应直接切往深色')
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark')
  assert.equal(document.documentElement.getAttribute('data-theme-mode'), 'dark')
  assert.equal(JSON.parse(localStorage.getItem(QLS.THEME_KEY)), 'dark')
  assert.equal(QLS.toggleTheme(), 'light', '第二次点击切往显式浅色')
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light')
  assert.equal(document.documentElement.getAttribute('data-theme-mode'), 'light')
  assert.equal(QLS.toggleTheme(), 'system', '第三次点击回归跟随系统')
  assert.equal(document.documentElement.getAttribute('data-theme-mode'), 'system')
  assert.equal(JSON.parse(localStorage.getItem(QLS.THEME_KEY)), 'system')

  // 2. 系统为深色时：system(dark) → light → dark → system
  mql.matches = true
  QLS.applyTheme()
  assert.equal(QLS.getEffectiveTheme(), 'dark')
  assert.equal(QLS.toggleTheme(), 'light', '系统深色时首次点击应直接切往浅色')
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light')
  assert.equal(QLS.toggleTheme(), 'dark', '第二次点击切往显式深色')
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark')
  assert.equal(QLS.toggleTheme(), 'system', '第三次点击回归跟随系统')
})


test('存储层降级路径：IDB 不可用时走 localStorage，读写结果一致', () => {
  // jsdom 不提供 indexedDB，idb-store.js 自动回退至 localStorage 实现。
  // 本用例验证降级路径下 store.set / get / remove / keys 行为与 IDB 路径一致。
  const { QLS } = setup()
  const { store } = QLS

  assert.equal(store.set('quantilife_fallback', { v: 42 }), true)
  assert.deepEqual(plain(store.get('quantilife_fallback')), { v: 42 })
  assert.equal(store.has('quantilife_fallback'), true)

  store.set('schedule_fallback', 'hello')
  const keys = store.keys('schedule_').sort()
  assert.ok(keys.includes('schedule_fallback'), 'keys() 能枚举降级写入的键')

  store.remove('quantilife_fallback')
  assert.equal(store.has('quantilife_fallback'), false)
  assert.equal(store.get('quantilife_fallback', 'gone'), 'gone')
})

test('数据优先保护：支持 IndexedDB 但初始化受阻失败时，锁定页面并拒绝向空 localStorage 写入业务数据', async () => {
  const originalError = console.error
  console.error = () => {}
  try {
    const page = createPage('index.html', {
      beforeScripts(win) {
        win.indexedDB = {
          open() {
            const req = {}
            Promise.resolve().then(() => req.onblocked?.())
            return req
          },
        }
      },
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    const { QLS, document, localStorage } = page
    assert.equal(QLS.storageReady(), false, 'IDB 失败时不得触发就绪状态')
    assert.equal(QLS.store.locked, true, '存储层应进入锁定状态')
    assert.equal(document.documentElement.getAttribute('data-storage-locked'), 'true', '根节点应标记锁定属性')
    assert.ok(document.querySelector('.storage-lock-overlay'), '页面应挂载锁定提示遮罩')

    assert.equal(QLS.store.set('schedule_timeblocks', { '2026-10-20': [] }), false, '禁止向空 localStorage 写入业务表')
    assert.equal(localStorage.getItem('schedule_timeblocks'), null, 'localStorage 中不得产生残缺业务记录')
  } finally {
    console.error = originalError
  }
})
