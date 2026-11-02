'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, createIdbFactory, click, type, waitFor } = require('../helpers/dom')

async function open(factory, path = 'MAERS-QuantiLife/index.html', options = {}) {
  const page = createPage(path, { indexedDB: factory, ...options })
  await page.ready()
  return page
}

function sharedStorage() {
  const entries = new Map()
  return {
    get length() { return entries.size },
    key(index) { return [...entries.keys()][index] ?? null },
    getItem(key) { return entries.get(String(key)) ?? null },
    setItem(key, value) { entries.set(String(key), String(value)) },
    removeItem(key) { entries.delete(String(key)) },
  }
}

for (const goal of [false, true]) {
  test(`弹窗打开快照：${goal ? '愿景' : '任务'}收到广播后保存备注，不覆盖远端标题`, async () => {
    const factory = createIdbFactory()
    const a = await open(factory, 'MAERS-Schedule/index.html')
    const entity = a.MS.saveTaskOrGoal({ title: '原始标题', isGoal: goal })
    await a.QLS.store.flush()
    const b = await open(factory, 'MAERS-Schedule/index.html')
    if (goal) a.MS.openGoalModal(entity.id)
    else a.MS.openModal(entity.id)
    b.MS.saveTaskOrGoal({ id: entity.id, title: '远端标题', isGoal: goal })
    await b.QLS.store.flush()
    const key = goal ? a.QLS.GOALS_KEY : a.QLS.TASKS_KEY
    await waitFor(() => a.QLS.store.get(key)?.[0].title === '远端标题')
    type(a.document.querySelector(goal ? '#goal-notes' : '#modal-notes'), '本页备注')
    click(a.document.querySelector(goal ? '#goal-save' : '#modal-save'))
    await a.QLS.store.flush()
    const result = a.QLS.store.getCommitted(key)[0]
    assert.equal(result.title, '远端标题')
    assert.equal(result.notes, '本页备注')
  })
}

test('同字段冲突：弹窗保留本页输入，不关闭且不报告成功', async t => {
  t.mock.method(console, 'error', () => {})
  const factory = createIdbFactory()
  const a = await open(factory, 'MAERS-Schedule/index.html')
  const entity = a.MS.saveTaskOrGoal({ title: '原始标题' })
  await a.QLS.store.flush()
  const b = await open(factory, 'MAERS-Schedule/index.html')
  a.MS.openModal(entity.id)
  b.MS.saveTaskOrGoal({ id: entity.id, title: '远端标题' })
  await b.QLS.store.flush()
  await waitFor(() => a.MS.loadTasks()[0].title === '远端标题')
  type(a.document.querySelector('#modal-task-title'), '本页标题')
  click(a.document.querySelector('#modal-save'))
  await assert.rejects(a.QLS.store.flush())
  assert.equal(a.document.querySelector('#task-modal').open, true)
  assert.equal(a.document.querySelector('#modal-task-title').value, '本页标题')
  assert.equal(a.QLS.store.getCommitted(a.QLS.TASKS_KEY)[0].title, '远端标题')
})

test('连续保存：第二次点击发生在首次确认之前，两个请求串行提交并可重复保存', async () => {
  const page = await open(createIdbFactory())
  const flush = page.QLS.store.flush
  let release
  const gate = new Promise(resolve => { release = resolve })
  page.QLS.store.flush = () => flush().then(() => gate)
  type(page.document.querySelector('#input-steps'), '1000')
  click(page.document.querySelector('#save-btn'))
  type(page.document.querySelector('#input-steps'), '2000')
  click(page.document.querySelector('#save-btn'))
  await flush()
  const key = page.QLS.QL_PREFIX + page.QLS.today()
  assert.equal(page.QLS.store.getCommitted(key).basics.steps, 1000)
  assert.equal(page.QLS.store.get(key).basics.steps, 1000, '第二次请求不得先留下乐观快照')
  release()
  await page.QL.flushEditor()
  page.QLS.store.flush = flush
  assert.equal(page.document.querySelector('#input-steps').value, '2000')
  assert.equal(page.QLS.store.getCommitted(key).basics.steps, 2000)
  await page.QL.flushEditor()
  assert.equal(page.document.querySelector('#input-steps').value, '2000')
  assert.equal(page.QLS.store.getCommitted(key).basics.steps, 2000)
})

test('连续保存的后次提交失败：保留 2000，原样重试后成功落盘', async t => {
  t.mock.method(console, 'error', () => {})
  const factory = createIdbFactory(), page = await open(factory)
  const key = page.QLS.QL_PREFIX + page.QLS.today()
  const database = await new Promise(resolve => {
    const request = factory.open('maers-qls-data', 1)
    request.onsuccess = () => resolve(request.result)
  })
  const proto = Object.getPrototypeOf(database.transaction('keyvalue').objectStore('keyvalue'))
  const put = proto.put
  let fail = true
  proto.put = function (record, ...args) {
    if (fail && record.key === key && JSON.parse(record.raw)?.basics?.steps === 2000) {
      fail = false
      throw new Error('injected second write failure')
    }
    return put.call(this, record, ...args)
  }
  try {
    for (const value of ['1000', '2000']) {
      type(page.document.querySelector('#input-steps'), value)
      click(page.document.querySelector('#save-btn'))
    }
    assert.equal(await page.QL.flushEditor(), false)
    assert.equal(page.document.querySelector('#input-steps').value, '2000')
    assert.equal(page.QLS.store.getCommitted(key).basics.steps, 1000)
    assert.equal(await page.QL.flushEditor(), true)
    assert.equal(page.document.querySelector('#input-steps').value, '2000')
    assert.equal(page.QLS.store.getCommitted(key).basics.steps, 2000)
  } finally { proto.put = put; database.close() }
})

test('草稿所有权降级：活跃页面草稿不恢复，明确离页后才恢复', async () => {
  const factory = createIdbFactory(), area = sharedStorage()
  const options = { beforeScripts(win) {
    Object.defineProperty(win, 'localStorage', { value: area })
    const schedule = win.setTimeout.bind(win)
    win.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 800 ? 60000 : delay, ...args)
  } }
  const a = await open(factory, undefined, options)
  type(a.document.querySelector('#input-steps'), '1000')
  const b = await open(factory, undefined, options)
  const key = a.QLS.QL_PREFIX + a.QLS.today()
  assert.equal(b.QLS.store.getCommitted(key), null)
  type(a.document.querySelector('#input-steps'), '2000')
  a.QL.saveDayData = () => false
  a.window.dispatchEvent(new a.window.Event('pagehide'))
  a.close()
  const c = await open(factory, undefined, options)
  assert.equal(c.QLS.store.getCommitted(key).basics.steps, 2000)
  assert.equal(c.document.querySelector('#input-steps').value, '2000')
})

test('没有所有权信息的旧草稿保持副本，不自动提交', async () => {
  const factory = createIdbFactory()
  const key = 'quantilife_2026-10-28'
  const draftKey = 'qls_pending_day_legacy:' + key
  const page = await open(factory, undefined, { storage: { [draftKey]: {
    key, base: null, raw: JSON.stringify({ date: '2026-10-28', basics: { steps: 1000 } }),
  } } })
  assert.equal(page.QLS.store.getCommitted(key), null)
  assert.ok(page.localStorage.getItem(draftKey))
})

test('Web Lock 所有权：持锁时跳过恢复，释放后恢复闭页草稿', async () => {
  const held = new Set()
  const locks = { request(name, options, callback) {
    if (typeof options === 'function') { callback = options; options = {} }
    if (held.has(name) && options.ifAvailable) return Promise.resolve(callback(null))
    assert.equal(held.has(name), false, '唯一文档锁不应互相阻塞')
    held.add(name)
    return Promise.resolve().then(() => callback({ name, mode: 'exclusive' })).finally(() => held.delete(name))
  } }
  const factory = createIdbFactory(), area = sharedStorage()
  const options = { beforeScripts(win) {
    Object.defineProperty(win, 'localStorage', { value: area })
    Object.defineProperty(win.navigator, 'locks', { value: locks })
    const schedule = win.setTimeout.bind(win)
    win.setTimeout = (callback, delay, ...args) => schedule(callback, delay === 800 ? 60000 : delay, ...args)
  } }
  const a = await open(factory, undefined, options)
  type(a.document.querySelector('#input-steps'), '1000')
  const b = await open(factory, undefined, options)
  const key = a.QLS.QL_PREFIX + a.QLS.today()
  assert.equal(b.QLS.store.getCommitted(key), null)
  a.QL.saveDayData = () => false
  a.window.dispatchEvent(new a.window.Event('pagehide'))
  a.close()
  const c = await open(factory, undefined, options)
  assert.equal(c.QLS.store.getCommitted(key).basics.steps, 1000)
})

test('草稿锁权限失败：降级保留草稿，不锁死可正常使用的 IndexedDB', async t => {
  t.mock.method(console, 'warn', () => {})
  const page = await open(createIdbFactory(), undefined, { beforeScripts(win) {
    Object.defineProperty(win.navigator, 'locks', { value: { request() { throw new Error('locks denied') } } })
  } })
  assert.equal(page.QLS.store.mode, 'indexeddb')
  type(page.document.querySelector('#input-steps'), '2000')
  assert.equal(await page.QL.flushEditor(), true)
  assert.equal(page.QLS.store.getCommitted(page.QLS.QL_PREFIX + page.QLS.today()).basics.steps, 2000)
})
