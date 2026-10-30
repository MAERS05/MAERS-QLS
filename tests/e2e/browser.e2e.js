/**
 * 真实浏览器端到端测试 (tests/e2e/browser.e2e.js)
 * jsdom 无法覆盖的能力：真实 IndexedDB、BroadcastChannel 跨标签页、Service Worker 离线运行、原生 <dialog>。
 * 使用系统已安装的 Chrome / Edge（playwright-core，不下载浏览器）；找不到浏览器时自动跳过。
 * 运行：npm run test:e2e（可用 E2E_CHANNEL=chrome|msedge 指定浏览器）
 */

'use strict'

const test = require('node:test')
const { before, after } = test
const assert = require('node:assert/strict')
const net = require('node:net')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { chromium } = require('playwright-core')

const ROOT = path.resolve(__dirname, '..', '..')
const CHANNELS = [process.env.E2E_CHANNEL, 'chrome', 'msedge'].filter(Boolean)

let server = null
let browser = null
let baseUrl = ''

/** 获取一个空闲端口 */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

async function waitForServer(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return } catch { /* 服务尚未就绪 */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('开发服务器启动超时')
}

/** 轮询异步条件直至为真，超时抛错 */
async function waitUntil(condition, timeoutMs, message, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  throw new Error(message)
}

async function launchBrowser() {
  for (const channel of CHANNELS) {
    try { return await chromium.launch({ channel, headless: true }) } catch { /* 尝试下一个浏览器 */ }
  }
  return null
}

before(async () => {
  browser = await launchBrowser()
  if (!browser) return
  const port = await freePort()
  server = spawn(process.execPath, ['scripts/dev-server.js', '--no-open'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  })
  baseUrl = `http://127.0.0.1:${port}`
  await waitForServer(`${baseUrl}/`)
})

/** 停止开发服务器并等待进程退出，端口释放后请求才会真正失败 */
async function stopServer() {
  if (!server || server.exitCode !== null) return
  const exited = new Promise(resolve => server.once('exit', resolve))
  server.kill()
  await exited
}

after(async () => {
  await browser?.close()
  await stopServer()
})

/** 打开页面并等待 IndexedDB 数据载入完成 */
async function openPage(context, pathname) {
  const page = await context.newPage()
  await page.goto(`${baseUrl}${pathname}`)
  await page.waitForFunction(() => window.QLS?.storageReady?.() && !document.documentElement.hasAttribute('data-storage-loading'))
  return page
}

const skipIfNoBrowser = (t) => {
  if (browser) return false
  t.skip('未找到可用的 Chrome / Edge')
  return true
}

/** 断言直接读取真实 IndexedDB，避免把乐观缓存当作落盘成功的证据。 */
async function readDiskValue(page, key) {
  return page.evaluate(async storageKey => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('maers-qls-data', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise((resolve, reject) => {
        const request = database.transaction('keyvalue').objectStore('keyvalue').get(storageKey)
        request.onsuccess = () => resolve(request.result ? JSON.parse(request.result.raw) : null)
        request.onerror = () => reject(request.error)
      })
    } finally { database.close() }
  }, key)
}

test('真实 IndexedDB：数据在刷新后保留，业务键不写入 localStorage', async (t) => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext()
  try {
    const page = await openPage(context, '/MAERS-QuantiLife/index.html')
    assert.equal(await page.evaluate(() => window.QLS.store.mode), 'indexeddb')

    await page.evaluate(async () => {
      window.QLS.store.set('quantilife_2026-10-15', { date: '2026-10-15', basics: { steps: 4321 } })
      await window.QLS.store.flush()
    })
    await page.reload()
    await page.waitForFunction(() => window.QLS?.storageReady?.())
    assert.equal(await page.evaluate(() => window.QLS.store.get('quantilife_2026-10-15').basics.steps), 4321)
    assert.equal(await page.evaluate(() => localStorage.getItem('quantilife_2026-10-15')), null)
  } finally {
    await context.close()
  }
})

test('真实 BroadcastChannel：Schedule 结束计时后，另一标签页的 QuantiLife 记录页自动出现同步事件', async (t) => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext()
  try {
    const ql = await openPage(context, '/MAERS-QuantiLife/index.html')
    const schedule = await openPage(context, '/MAERS-Schedule/index.html')

    await schedule.evaluate(() => {
      const start = new Date()
      start.setHours(9, 0, 0, 0)
      const task = window.MS.startInProgressTask({ title: '端到端计时', category: 'learn', tags: ['阅读'], now: start.getTime() })
      window.MS.finishInProgressTask(task.id, start.getTime() + 3600 * 1000)
    })

    await ql.waitForFunction(() => window.QL.timeDetail.getEvents().some(ev => ev._isSync && ev.name === '端到端计时'), null, { timeout: 5000 })
    // 页面可见内容同步更新：时间卡片出现已记录时长
    await ql.waitForFunction(() => document.body.textContent.includes('1h'), null, { timeout: 5000 })
  } finally {
    await context.close()
  }
})

test('真实 <dialog>：任务弹窗以模态方式打开，Esc 关闭', async (t) => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext()
  try {
    const page = await openPage(context, '/MAERS-Schedule/index.html')
    await page.click('.view-tab[data-view="timeline"]')
    await page.click('.timeline-inline-add[data-tier="short"]')
    assert.equal(await page.evaluate(() => document.querySelector('#task-modal').matches(':modal')), true)
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(() => document.querySelector('#task-modal').open), false)
  } finally {
    await context.close()
  }
})

test('真实 IndexedDB 并发：没有广播时同时新增的任务全部保留', async (t) => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext()
  try {
    await context.addInitScript(() => { window.BroadcastChannel = undefined })
    const a = await openPage(context, '/MAERS-Schedule/index.html')
    const b = await openPage(context, '/MAERS-Schedule/index.html')
    await Promise.all([
      a.evaluate(async () => {
        window.MS.saveTaskOrGoal({ title: '并发任务 A', tier: 'short' })
        await window.QLS.store.flush()
      }),
      b.evaluate(async () => {
        window.MS.saveTaskOrGoal({ title: '并发任务 B', tier: 'short' })
        await window.QLS.store.flush()
      }),
    ])
    const viewer = await openPage(context, '/MAERS-Schedule/index.html')
    assert.deepEqual(await viewer.evaluate(() => window.MS.loadTasks().map(task => task.title).sort()), ['并发任务 A', '并发任务 B'])
  } finally { await context.close() }
})

test('真实离页恢复：输入后立即关闭，重新打开仍保留修改', async (t) => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const page = await openPage(context, '/MAERS-QuantiLife/index.html')
    await page.evaluate(() => {
      const input = document.querySelector('#input-steps')
      input.value = '6789'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      if (!Object.keys(localStorage).some(key => key.startsWith('qls_pending_day_'))) throw new Error('输入未立即生成恢复草稿')
    })
    await page.close()
    // 延迟领域脚本，验证 IndexedDB 提前就绪也不会跳过草稿恢复。
    await context.route('**/common/js/day-record.js', async route => {
      await new Promise(resolve => setTimeout(resolve, 150))
      await route.continue()
    })
    const restored = await openPage(context, '/MAERS-QuantiLife/index.html')
    assert.equal(await restored.inputValue('#input-steps'), '6789')
  } finally { await context.close() }
})

test('真实静态服务：大小写绕过与根目录开发文件均返回拒绝', async t => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext()
  try {
    for (const pathname of ['/Tests/qls-test-data.json', '/Scripts/dev-server.js', '/NODE_MODULES/jsdom/package.json', '/package.json']) {
      assert.equal((await context.request.get(baseUrl + pathname)).status(), 403, pathname)
    }
    assert.equal((await context.request.get(baseUrl + '/common/js/core.js')).status(), 200)
  } finally { await context.close() }
})

test('真实午夜时间块：保存 23:59–00:00 后刷新仍保持最后一分钟', async t => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext()
  try {
    const page = await openPage(context, '/MAERS-Schedule/index.html')
    await page.evaluate(() => window.MS.openBlockModal({ dateStr: '2026-10-28', startH: 23 + 59 / 60, durationH: 1 / 60 }))
    await page.fill('#tb-block-label', '午夜前一分钟')
    await page.click('#tb-block-save')
    await page.evaluate(() => window.QLS.store.flush())
    await page.reload()
    await page.waitForFunction(() => window.QLS?.storageReady?.())
    assert.equal(await page.evaluate(() => window.MS.loadBlocks('2026-10-28')[0].startH), 23 + 59 / 60)
  } finally { await context.close() }
})

test('真实任务弹窗：收到广播后只改备注，保留另一页已保存的新标题', async t => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const a = await openPage(context, '/MAERS-Schedule/index.html')
    const task = await a.evaluate(async () => {
      const task = window.MS.saveTaskOrGoal({ title: '旧标题', tier: 'short' })
      await window.QLS.store.flush()
      return task
    })
    const b = await openPage(context, '/MAERS-Schedule/index.html')
    await a.evaluate(id => window.MS.openModal(id), task.id)
    await b.evaluate(async id => {
      window.MS.saveTaskOrGoal({ id, title: '另一页的新标题' })
      await window.QLS.store.flush()
    }, task.id)
    await a.waitForFunction(id => window.MS.loadTasks().find(task => task.id === id)?.title === '另一页的新标题', task.id)
    await a.fill('#modal-notes', '只修改备注')
    await a.click('#modal-save')
    await a.evaluate(() => window.QLS.store.flush())
    const tasks = await readDiskValue(a, 'schedule_tasks')
    assert.equal(tasks[0].title, '另一页的新标题')
    assert.equal(tasks[0].notes, '只修改备注')
  } finally { await context.close() }
})

test('真实连续保存：1000 提交期间再保存 2000，重试后界面与磁盘仍为 2000', async t => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const page = await openPage(context, '/MAERS-QuantiLife/index.html')
    const key = await page.evaluate(() => {
      const input = document.querySelector('#input-steps')
      for (const value of ['1000', '2000']) {
        input.value = value
        input.dispatchEvent(new Event('input', { bubbles: true }))
        document.querySelector('#save-btn').click()
      }
      return window.QLS.QL_PREFIX + window.QLS.today()
    })
    await waitUntil(async () => (await readDiskValue(page, key))?.basics.steps === 2000, 5000, '第二次输入未能落盘')
    assert.equal(await page.inputValue('#input-steps'), '2000')
    await page.click('#save-btn')
    await page.evaluate(() => window.QLS.store.flush())
    assert.equal(await page.inputValue('#input-steps'), '2000')
    assert.equal((await readDiskValue(page, key)).basics.steps, 2000)
  } finally { await context.close() }
})

test('真实草稿所有权：打开 B 不提交活跃 A 的草稿，A 随后保存 2000 成功', async t => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    // 拉长自动保存等待窗口，稳定验证“输入后但尚未提交”的真实页面状态。
    await context.addInitScript(() => {
      const schedule = window.setTimeout.bind(window)
      window.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 800 ? 60000 : delay, ...args)
    })
    const a = await openPage(context, '/MAERS-QuantiLife/index.html')
    await a.fill('#input-steps', '1000')
    const key = await a.evaluate(() => window.QLS.QL_PREFIX + window.QLS.today())
    const b = await openPage(context, '/MAERS-QuantiLife/index.html')
    assert.equal(await readDiskValue(b, key), null, 'B 不得代替仍活跃的 A 提交草稿')
    await a.fill('#input-steps', '2000')
    await a.click('#save-btn')
    await waitUntil(async () => (await readDiskValue(a, key))?.basics.steps === 2000, 5000, '活跃草稿的后续输入保存失败')
    await a.click('#save-btn')
    await a.evaluate(() => window.QLS.store.flush())
    assert.equal(await a.inputValue('#input-steps'), '2000')
    assert.equal((await readDiskValue(a, key)).basics.steps, 2000)
  } finally { await context.close() }
})

test('真实保存失败重试：2000 写入失败后仍保留输入，再次保存落盘为 2000', async t => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const page = await openPage(context, '/MAERS-QuantiLife/index.html')
    const result = await page.evaluate(async () => {
      const key = window.QLS.QL_PREFIX + window.QLS.today()
      const put = IDBObjectStore.prototype.put
      let fail = true
      IDBObjectStore.prototype.put = function (record, ...args) {
        if (fail && record.key === key && JSON.parse(record.raw)?.basics?.steps === 2000) {
          fail = false
          throw new DOMException('injected second write failure', 'QuotaExceededError')
        }
        return put.call(this, record, ...args)
      }
      try {
        const input = document.querySelector('#input-steps')
        for (const value of ['1000', '2000']) {
          input.value = value
          input.dispatchEvent(new Event('input', { bubbles: true }))
          document.querySelector('#save-btn').click()
        }
        return { key, saved: await window.QL.flushEditor(), input: input.value }
      } finally { IDBObjectStore.prototype.put = put }
    })
    assert.equal(result.saved, false)
    assert.equal(result.input, '2000')
    assert.equal((await readDiskValue(page, result.key)).basics.steps, 1000)
    await page.click('#save-btn')
    assert.equal(await page.evaluate(() => window.QL.flushEditor()), true)
    assert.equal(await page.inputValue('#input-steps'), '2000')
    assert.equal((await readDiskValue(page, result.key)).basics.steps, 2000)
  } finally { await context.close() }
})

test('真实崩溃恢复：没有离页标记，页面销毁释放所有权后才能恢复草稿', async t => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    await context.addInitScript(() => {
      const schedule = window.setTimeout.bind(window)
      window.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 800 ? 60000 : delay, ...args)
    })
    const page = await openPage(context, '/MAERS-QuantiLife/index.html')
    await page.fill('#input-steps', '3456')
    const key = await page.evaluate(() => window.QLS.QL_PREFIX + window.QLS.today())
    assert.equal(await readDiskValue(page, key), null)
    const client = await context.newCDPSession(page)
    const crashed = page.waitForEvent('crash')
    void client.send('Page.crash').catch(() => {})
    await crashed
    await page.close()
    const restored = await openPage(context, '/MAERS-QuantiLife/index.html')
    assert.equal((await readDiskValue(restored, key)).basics.steps, 3456)
    assert.equal(await restored.inputValue('#input-steps'), '3456')
  } finally { await context.close() }
})

test('真实时间块弹窗：旧名称读书、另一页改学习，本页保存备注后磁盘仍为学习', async t => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const a = await openPage(context, '/MAERS-Schedule/index.html')
    await a.evaluate(async () => {
      window.MS.saveBlock('2026-10-28', { id: 'reading', label: '读书', startH: 9, durationH: 1 })
      await window.QLS.store.flush()
      window.MS.openBlockModal({ dateStr: '2026-10-28', block: window.MS.loadBlocks('2026-10-28')[0] })
    })
    const b = await openPage(context, '/MAERS-Schedule/index.html')
    await b.evaluate(async () => {
      window.MS.saveBlock('2026-10-28', { ...window.MS.loadBlocks('2026-10-28')[0], label: '学习' })
      await window.QLS.store.flush()
    })
    await a.waitForFunction(() => window.MS.loadBlocks('2026-10-28')[0].label === '学习')
    await a.fill('#tb-block-notes', '只改备注')
    await a.click('#tb-block-save')
    await a.waitForFunction(() => !document.querySelector('#tb-modal').open)
    const key = await a.evaluate(() => window.QLS.TIMEBLOCK_KEY)
    const block = (await readDiskValue(a, key))['2026-10-28'][0]
    assert.equal(block.label, '学习')
    assert.equal(block.notes, '只改备注')
  } finally { await context.close() }
})

test('真实量化写入失败：任务完成与一小时记录整体回滚，刷新重试后一次入账', async t => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const page = await openPage(context, '/MAERS-Schedule/index.html')
    const fixture = await page.evaluate(async () => {
      const start = new Date()
      start.setHours(9, 0, 0, 0)
      const task = window.MS.startInProgressTask({ title: '一小时阅读', category: 'learn', tags: ['阅读'], now: start.getTime() })
      window.MS.pauseInProgressTask(task.id, start.getTime() + 3600000)
      await window.QLS.store.flush()
      const key = window.QLS.QL_PREFIX + task.date
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (record, ...args) {
        if (record.key === key) {
          IDBObjectStore.prototype.put = put
          throw new DOMException('injected day write failure', 'QuotaExceededError')
        }
        return put.call(this, record, ...args)
      }
      return { id: task.id, dayKey: key, tasksKey: window.QLS.INPROGRESS_KEY }
    })
    await page.click('.view-tab[data-view="inprogress"]')
    await page.click(`[data-ip-action="finish"][data-id="${fixture.id}"]`)
    assert.equal(await page.evaluate(() => window.QLS.store.flush().then(() => true, () => false)), false)
    assert.equal((await readDiskValue(page, fixture.tasksKey))[0].status, 'paused')
    assert.equal(await readDiskValue(page, fixture.dayKey), null)
    await page.reload()
    await page.waitForFunction(() => window.QLS?.storageReady?.())
    await page.click('.view-tab[data-view="inprogress"]')
    await page.click(`[data-ip-action="finish"][data-id="${fixture.id}"]`)
    await page.evaluate(() => window.QLS.store.flush())
    assert.equal((await readDiskValue(page, fixture.tasksKey))[0].status, 'completed')
    const day = await readDiskValue(page, fixture.dayKey)
    assert.equal(day.time.learn, 1)
    assert.equal(day.timeEvents.length, 1)
  } finally { await context.close() }
})

test('真实累计 30 小时：打开调整面板直接保存，刷新后仍为 30 小时', async t => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const page = await openPage(context, '/MAERS-Schedule/index.html')
    const fixture = await page.evaluate(async () => {
      const start = new Date()
      start.setHours(9, 0, 0, 0)
      const task = window.MS.startInProgressTask({ title: '三十小时', category: 'learn', tags: ['阅读'], now: start.getTime() })
      window.MS.finishInProgressTask(task.id, start.getTime() + 30 * 3600000)
      await window.QLS.store.flush()
      return { id: task.id, key: window.QLS.INPROGRESS_KEY }
    })
    await page.click('.view-tab[data-view="inprogress"]')
    await page.click(`[data-ip-action="edit"][data-id="${fixture.id}"]`)
    assert.equal(await page.inputValue('#ip-settle-total'), '30:00')
    await page.click('#ip-settle-save')
    await page.evaluate(() => window.QLS.store.flush())
    await page.reload()
    await page.waitForFunction(() => window.QLS?.storageReady?.())
    assert.equal((await readDiskValue(page, fixture.key))[0].finalHours, 30)
  } finally { await context.close() }
})

test('真实跨日分段：28 日创建、29 日结束时间调至 10:30，29 日记 1.5 小时', async t => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const page = await openPage(context, '/MAERS-Schedule/index.html')
    const id = await page.evaluate(async () => {
      window.MS.today = () => '2026-10-28'
      const at = (day, hour) => new Date(2026, 9, day, hour).getTime()
      const task = window.MS.startInProgressTask({ title: '跨日阅读', category: 'learn', tags: ['阅读'], now: at(28, 9) })
      window.MS.pauseInProgressTask(task.id, at(28, 10))
      window.MS.resumeInProgressTask(task.id, at(29, 9))
      window.MS.finishInProgressTask(task.id, at(29, 10))
      await window.QLS.store.flush()
      return task.id
    })
    await page.click('.view-tab[data-view="inprogress"]')
    await page.click(`[data-ip-action="edit"][data-id="${id}"]`)
    await page.click('[data-seg-field="endHm"][data-seg-idx="1"]')
    for (let minute = 0; minute < 30; minute++) await page.locator('#qls-wp-m').press('ArrowDown')
    await page.click('#qls-wheel-picker .wp-confirm')
    assert.equal(await page.inputValue('#ip-settle-total'), '02:30')
    await page.click('#ip-settle-save')
    await page.evaluate(() => window.QLS.store.flush())
    assert.equal((await readDiskValue(page, 'quantilife_2026-10-28')).time.learn, 1)
    assert.equal((await readDiskValue(page, 'quantilife_2026-10-29')).time.learn, 1.5)
  } finally { await context.close() }
})

test('真实 Service Worker：预缓存完成后断网仍可打开各子系统页面', async (t) => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext()
  try {
    const page = await openPage(context, '/')
    // 等待 SW 激活并接管页面，且清单内每个资源都已进入缓存（逐项核对，不依赖条目数量）
    // 注意：page.waitForFunction 不会等待异步谓词，因此在 Node 侧轮询 evaluate 结果
    await waitUntil(() => page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      if (registration?.active?.state !== 'activated' || !navigator.serviceWorker.controller) return false
      const names = (await caches.keys()).filter(name => name.startsWith('maers-qls-'))
      if (names.length !== 1) return false
      const cache = await caches.open(names[0])
      const text = await (await fetch('/precache-manifest.js')).text()
      const manifest = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
      for (const url of [...manifest.shell, ...manifest.rest]) {
        if (!(await cache.match(new URL(url, location.origin + '/')))) return false
      }
      return true
    }), 30000, 'Service Worker 未在期限内完成预缓存')

    // 真实断网：关闭服务器（Chromium 的 setOffline 会在 SW 介入前拦截导航，无法代表真实离线）
    await stopServer()
    for (const pathname of ['/', '/MAERS-Schedule/index.html', '/MAERS-QuantiLife/index.html', '/MAERS-QuantiLife/report.html']) {
      const offlinePage = await context.newPage()
      const failures = []
      offlinePage.on('requestfailed', request => failures.push(request.url()))
      await offlinePage.goto(`${baseUrl}${pathname}`)
      await offlinePage.waitForFunction(() => window.QLS?.storageReady?.(), null, { timeout: 10000 })
      assert.deepEqual(failures.filter(url => url.startsWith(baseUrl)), [], `${pathname} 离线时存在加载失败的资源`)
      await offlinePage.close()
    }
  } finally {
    await context.close()
  }
})
