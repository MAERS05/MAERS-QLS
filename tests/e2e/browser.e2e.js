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

test('真实自定义列：默认提示、弹窗创建切换、量化名称与时间联动，刷新后保留', async t => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  try {
    const schedule = await openPage(context, '/MAERS-Schedule/index.html')
    const quanti = await openPage(context, '/MAERS-QuantiLife/index.html')
    assert.equal(await quanti.textContent('#exp-active-name'), '默认')
    await quanti.click('#exp-open-btn')
    assert.match(await quanti.textContent('#toast'), /未发现schedule里的自定义列/)
    assert.equal(await quanti.locator('#exp-overlay').evaluate(dialog => dialog.open), false)
    await schedule.click('.tb-day-body[data-date="ideal"]', { position: { x: 8, y: 20 } })
    assert.match(await schedule.textContent('#toast'), /请点击默认框创建自定义后添加/)

    await schedule.click('#tb-toggle-ideal')
    await schedule.fill('#tb-template-name', '工作')
    await schedule.click('#tb-template-add')
    await schedule.waitForFunction(() => document.querySelector('#tb-template-name').value === '' && !document.querySelector('#tb-template-add').disabled)
    const workId = await schedule.evaluate(() => window.MS.loadActiveTemplate().id)
    await schedule.click(`[data-template-select="${workId}"]`)
    await schedule.waitForFunction(() => !document.querySelector('#tb-templates-modal').open)
    await schedule.evaluate(() => window.MS.openBlockModal({ dateStr: 'ideal', startH: 9, durationH: 2 }))
    await schedule.fill('#tb-block-label', '工作安排')
    await schedule.click('#tb-block-save')
    await schedule.waitForFunction(() => !document.querySelector('#tb-modal').open)
    await quanti.waitForFunction(() => document.querySelector('#exp-active-name').textContent === '工作' && window.QL.loadExpectations().time.basic.hours === 2)

    await schedule.click('#tb-toggle-ideal')
    await schedule.fill('#tb-template-name', '假期')
    await schedule.click('#tb-template-add')
    await schedule.waitForFunction(() => document.querySelector('#tb-template-name').value === '' && !document.querySelector('#tb-template-add').disabled)
    await quanti.waitForFunction(() => document.querySelector('#exp-active-name').textContent === '假期' && window.QL.loadExpectations().time.basic.hours === 0)
    if (process.env.E2E_ARTIFACTS) await schedule.screenshot({ path: path.join(process.env.E2E_ARTIFACTS, 'custom-columns-mobile.png') })
    await schedule.click(`[data-template-select="${workId}"]`)
    await schedule.waitForFunction(() => !document.querySelector('#tb-templates-modal').open)
    await schedule.reload()
    await schedule.waitForFunction(() => window.QLS?.storageReady?.())
    assert.equal(await schedule.textContent('.tb-ideal-title'), '工作')
    const data = await readDiskValue(schedule, 'schedule_timeblocks')
    assert.equal(data._templates.activeId, workId)
    assert.equal(data._templates.items.length, 2)
    assert.equal((await readDiskValue(schedule, 'quantilife_expectations')).time.basic.hours, 2)
    await quanti.waitForFunction(() => document.querySelector('#exp-active-name').textContent === '工作')
    await quanti.click('#exp-open-btn')
    assert.equal(await quanti.textContent('#exp-title'), '工作')
    if (process.env.E2E_ARTIFACTS) {
      await quanti.locator('#exp-overlay').evaluate(async dialog => {
        await Promise.all(dialog.getAnimations({ subtree: true }).map(animation => animation.finished))
      })
      await quanti.screenshot({ path: path.join(process.env.E2E_ARTIFACTS, 'custom-targets-mobile.png') })
    }
  } finally { await context.close() }
})

test('真实自定义列保存失败：不留下半套量化数据，名称保留并可重试', async t => {
  if (skipIfNoBrowser(t)) return
  const context = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const page = await openPage(context, '/MAERS-Schedule/index.html')
    await page.click('#tb-toggle-ideal')
    await page.fill('#tb-template-name', '生活')
    await page.evaluate(() => {
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (record, ...args) {
        if (record.key === window.QLS.EXPECTATIONS_KEY) {
          IDBObjectStore.prototype.put = put
          throw new DOMException('injected template projection failure', 'QuotaExceededError')
        }
        return put.call(this, record, ...args)
      }
    })
    await page.click('#tb-template-add')
    await page.waitForFunction(() => !document.querySelector('#tb-template-add').disabled && document.querySelector('#toast')?.textContent.includes('保存失败'))
    assert.equal(await page.inputValue('#tb-template-name'), '生活')
    assert.equal(await page.locator('#tb-templates-modal').evaluate(dialog => dialog.open), true)
    assert.equal(await readDiskValue(page, 'schedule_timeblocks'), null)
    assert.equal(await readDiskValue(page, 'quantilife_expectations'), null)
    await page.click('#tb-template-add')
    await page.waitForFunction(() => document.querySelector('#tb-template-name').value === '')
    assert.equal((await readDiskValue(page, 'schedule_timeblocks'))._templates.items[0].name, '生活')
    assert.ok((await readDiskValue(page, 'quantilife_expectations')).time)
    if (process.env.E2E_ARTIFACTS) await page.screenshot({ path: path.join(process.env.E2E_ARTIFACTS, 'custom-columns-desktop.png') })
  } finally { await context.close() }
})

async function pairDevices(sender, receiver) {
  await sender.click('#qls-transfer-btn')
  await receiver.click('#qls-transfer-btn')
  await sender.click('[data-transfer-mode="code"]')
  await receiver.click('[data-transfer-mode="code"]')
  await receiver.click('[data-transfer-role="receive"]')
  await sender.waitForFunction(() => document.querySelector('#transfer-local-code').value.startsWith('QLS1.'))
  await receiver.fill('#transfer-remote-code', await sender.inputValue('#transfer-local-code'))
  await receiver.click('#transfer-connect')
  await receiver.waitForFunction(() => document.querySelector('#transfer-local-code').value.startsWith('QLS1.'))
  await sender.fill('#transfer-remote-code', await receiver.inputValue('#transfer-local-code'))
  await sender.click('#transfer-connect')
  await sender.waitForFunction(() => document.querySelector('#transfer-status').textContent.includes('已连接'))
  await receiver.waitForFunction(() => document.querySelector('#transfer-status').textContent.includes('已连接'))
}

test('真实设备互传：两个独立浏览器数据区交换连接码，离线直传大段中文，确认覆盖后可恢复', async t => {
  if (skipIfNoBrowser(t)) return
  const sendContext = await browser.newContext({ serviceWorkers: 'block' })
  const receiveContext = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  try {
    const sender = await openPage(sendContext, '/')
    const receiver = await openPage(receiveContext, '/')
    await sender.evaluate(async () => {
      window.MS.saveTaskOrGoal({ title: '发送端任务' })
      window.MS.createTemplate('工作')
      window.MS.saveBlock('ideal', { label: '阅读', category: 'learn', startH: 9, durationH: 2 })
      window.QL.saveDayData({ date: '2026-11-02', basics: { steps: 8000 }, moodNote: '中文互传数据。'.repeat(20000), timeEvents: [] })
      await window.QLS.store.flush()
    })
    await receiver.evaluate(async () => {
      window.MS.saveTaskOrGoal({ title: '接收端原任务' })
      window.QL.saveDayData({ date: '2026-10-01', basics: { steps: 99 }, timeEvents: [] })
      await window.QLS.store.flush()
    })
    // 页面装载后阻断 HTTP 请求；连接码和业务数据交换不依赖信令或其他网络服务。
    await sendContext.route('**/*', route => route.abort())
    await receiveContext.route('**/*', route => route.abort())
    await pairDevices(sender, receiver)
    await sender.click('#transfer-send')
    await receiver.waitForFunction(() => !document.querySelector('#transfer-preview').hidden)
    assert.equal((await readDiskValue(receiver, 'schedule_tasks'))[0].title, '接收端原任务', '确认前不能覆盖')
    if (process.env.E2E_ARTIFACTS) await receiver.screenshot({ path: path.join(process.env.E2E_ARTIFACTS, 'device-transfer-receive-mobile.png') })
    await receiver.click('#transfer-accept')
    await receiver.waitForFunction(() => document.querySelector('#transfer-status').textContent.includes('已覆盖并保存'))
    await sender.waitForFunction(() => document.querySelector('#transfer-status').textContent.includes('对方已确认并保存'))
    assert.equal((await readDiskValue(receiver, 'schedule_tasks'))[0].title, '发送端任务')
    assert.equal(await readDiskValue(receiver, 'quantilife_2026-10-01'), null)
    assert.equal((await readDiskValue(receiver, 'quantilife_2026-11-02')).moodNote.length, '中文互传数据。'.repeat(20000).length)
    assert.equal((await readDiskValue(receiver, 'schedule_timeblocks'))._templates.items[0].name, '工作')
    assert.equal((await readDiskValue(receiver, 'quantilife_expectations')).time.learn.hours, 2)
    receiver.once('dialog', dialog => dialog.accept())
    await receiver.click('#transfer-restore')
    await receiver.waitForFunction(() => document.querySelector('#transfer-status').textContent.includes('已恢复到'))
    assert.equal((await readDiskValue(receiver, 'schedule_tasks'))[0].title, '接收端原任务')
    assert.ok(await readDiskValue(receiver, 'quantilife_2026-10-01'))
    assert.equal(await readDiskValue(receiver, 'quantilife_2026-11-02'), null)
  } finally { await sendContext.close(); await receiveContext.close() }
})

test('真实设备互传：保存失败不产生半覆盖，接收端保留预览并能再次确认', async t => {
  if (skipIfNoBrowser(t)) return
  const a = await browser.newContext({ serviceWorkers: 'block' }), b = await browser.newContext({ serviceWorkers: 'block' })
  try {
    const sender = await openPage(a, '/'), receiver = await openPage(b, '/')
    await sender.evaluate(async () => { window.MS.saveTaskOrGoal({ title: '发送数据' }); await window.QLS.store.flush() })
    await receiver.evaluate(async () => { window.MS.saveTaskOrGoal({ title: '原数据' }); await window.QLS.store.flush() })
    await pairDevices(sender, receiver)
    await sender.click('#transfer-send')
    await receiver.waitForFunction(() => !document.querySelector('#transfer-preview').hidden)
    await receiver.evaluate(() => {
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (record, ...args) {
        if (record.key === '__transfer_receipt__') { IDBObjectStore.prototype.put = put; throw new DOMException('空间不足', 'QuotaExceededError') }
        return put.call(this, record, ...args)
      }
    })
    await receiver.click('#transfer-accept')
    await receiver.waitForFunction(() => document.querySelector('#transfer-status').classList.contains('error'))
    assert.equal((await readDiskValue(receiver, 'schedule_tasks'))[0].title, '原数据')
    assert.equal(await readDiskValue(receiver, '__transfer_recovery__'), null)
    assert.equal(await receiver.locator('#transfer-preview').evaluate(element => element.hidden), false)
    await receiver.click('#transfer-accept')
    await sender.waitForFunction(() => document.querySelector('#transfer-status').textContent.includes('对方已确认并保存'))
    assert.equal((await readDiskValue(receiver, 'schedule_tasks'))[0].title, '发送数据')
  } finally { await a.close(); await b.close() }
})

test('公共配对实测：官方 PeerJS 短码配对、双方确认、直传及刷新后点击设备重连', async t => {
  if (!process.env.E2E_PUBLIC_PAIRING) { t.skip('设置 E2E_PUBLIC_PAIRING=1 才连接官方公共服务'); return }
  if (skipIfNoBrowser(t)) return
  const a = await browser.newContext({ serviceWorkers: 'block' }), b = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } })
  try {
    for (const context of [a, b]) await context.addInitScript(() => {
      const NativePeer = window.RTCPeerConnection
      window.pairingPeerConnections = []
      window.RTCPeerConnection = class extends NativePeer {
        constructor(config) { super(config); window.pairingPeerConnections.push(this) }
      }
    })
    const sender = await openPage(a, '/'), receiver = await openPage(b, '/')
    const errors = []
    sender.on('pageerror', e => errors.push(e.message)); receiver.on('pageerror', e => errors.push(e.message))
    async function online(page) {
      await page.click('#qls-transfer-btn')
      try { await page.waitForFunction(() => document.querySelector('#transfer-status').textContent.includes('已连接公共配对服务'), null, { timeout: 25000 }) }
      catch (error) { throw new Error('公共服务未就绪：' + await page.textContent('#transfer-status'), { cause: error }) }
    }
    await online(sender); await online(receiver)
    await sender.fill('#transfer-public-name', '配对测试电脑'); await sender.click('#transfer-public-rename')
    await receiver.fill('#transfer-public-name', '配对测试手机'); await receiver.click('#transfer-public-rename')
    await sender.evaluate(async () => { window.MS.saveTaskOrGoal({ title: '公共配对直传' }); await window.QLS.store.flush() })
    await receiver.click('[data-transfer-role="receive"]')
    await receiver.waitForFunction(() => /^\d{3}$/.test(document.querySelector('#transfer-public-local-code').textContent))
    if (process.env.E2E_ARTIFACTS) await receiver.screenshot({ path: path.join(process.env.E2E_ARTIFACTS, 'peerjs-code-mobile.png') })
    await sender.fill('#transfer-public-remote-code', await receiver.textContent('#transfer-public-local-code'))
    await sender.click('#transfer-public-connect')
    await sender.locator('#transfer-public-request').waitFor({ state: 'visible' })
    await receiver.locator('#transfer-public-request').waitFor({ state: 'visible' })
    await sender.click('#transfer-public-approve'); await receiver.click('#transfer-public-approve')
    try { await sender.waitForFunction(() => document.querySelector('#transfer-status').textContent.includes('已连接，可以发送'), null, { timeout: 20000 }) }
    catch(error) { throw new Error('配对后未连接：' + await sender.textContent('#transfer-status') + ' / ' + await receiver.textContent('#transfer-status'), { cause: error }) }
    const originalReceiver = await readDiskValue(receiver, 'qls_paired_devices')
    assert.equal(originalReceiver.peers.length, 1)
    await sender.click('#transfer-send')
    await receiver.locator('#transfer-preview').waitFor({ state: 'visible' }); await receiver.click('#transfer-accept')
    await sender.waitForFunction(() => document.querySelector('#transfer-status').textContent.includes('对方已确认并保存'))
    assert.equal((await readDiskValue(receiver, 'schedule_tasks'))[0].title, '公共配对直传')
    assert.equal((await readDiskValue(receiver, 'qls_paired_devices')).id, originalReceiver.id)
    await sender.click('#transfer-close'); await receiver.click('#transfer-close')
    await sender.reload(); await receiver.reload()
    await sender.waitForFunction(() => window.QLS?.storageReady()); await receiver.waitForFunction(() => window.QLS?.storageReady())
    await online(sender); await online(receiver)
    await sender.locator('#transfer-public-devices button').filter({ hasText: '配对测试手机' }).click()
    await sender.waitForFunction(() => document.querySelector('#transfer-status').textContent.includes('已连接，可以发送'))
    assert.equal(await receiver.locator('#transfer-public-request').isVisible(), false)
    assert.equal((await readDiskValue(receiver, 'qls_paired_devices')).id, originalReceiver.id)
    assert.equal(errors.length, 0, errors.join('\n'))
    // PeerJS briefly constructs and closes a capability probe; inspect the live application connections.
    for (const page of [sender, receiver]) assert.equal(await page.evaluate(() => {
      const live = window.pairingPeerConnections.filter(pc => pc.connectionState !== 'closed')
      return live.length > 0 && live.every(pc => !pc.getConfiguration().iceServers?.length)
    }), true, '实际应用连接均显式禁用 STUN/TURN')
    if (process.env.E2E_ARTIFACTS) await receiver.screenshot({ path: path.join(process.env.E2E_ARTIFACTS, 'peerjs-paired-mobile.png') })
  } finally { await a.close(); await b.close() }
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
