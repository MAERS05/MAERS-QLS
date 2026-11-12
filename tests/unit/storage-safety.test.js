'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, createIdbFactory, plain, type, click, waitFor } = require('../helpers/dom')

async function open(factory, options = {}, page = 'index.html') {
  const result = createPage(page, { indexedDB: factory, ...options })
  await result.ready()
  return result
}

async function database(factory) {
  const request = factory.open('maers-qls-data', 1)
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

test('并发新增任务与不同日期时间块：未等待广播也全部保留', async () => {
  const factory = createIdbFactory()
  const a = await open(factory), b = await open(factory)
  a.MS.saveTaskOrGoal({ title: '任务 A', tier: 'short' })
  b.MS.saveTaskOrGoal({ title: '任务 B', tier: 'short' })
  a.MS.saveBlock('2026-10-28', { id: 'a', label: '日程 A', startH: 9, durationH: 1 })
  b.MS.saveBlock('2026-10-29', { id: 'b', label: '日程 B', startH: 10, durationH: 1 })
  await Promise.all([a.QLS.store.flush(), b.QLS.store.flush()])
  const viewer = await open(factory)
  assert.deepEqual(plain(viewer.MS.loadTasks().map(t => t.title).sort()), ['任务 A', '任务 B'])
  assert.equal(viewer.MS.loadBlocks('2026-10-28')[0].label, '日程 A')
  assert.equal(viewer.MS.loadBlocks('2026-10-29')[0].label, '日程 B')
})

test('并发删除与更新不同任务不相互覆盖；同一字段冲突会拒绝并刷新快照', async t => {
  t.mock.method(console, 'error', () => {})
  const factory = createIdbFactory()
  const a = await open(factory)
  a.MS.saveTasks([{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }])
  await a.QLS.store.flush()
  const b = await open(factory)
  a.MS.deleteTaskOrGoal('a')
  b.MS.saveTaskOrGoal({ id: 'b', title: 'B updated' })
  await Promise.all([a.QLS.store.flush(), b.QLS.store.flush()])
  const c = await open(factory), d = await open(factory)
  assert.deepEqual(plain(c.MS.loadTasks().map(t => t.title)), ['B updated'])
  c.MS.saveTaskOrGoal({ id: 'b', title: 'C edit' })
  d.MS.saveTaskOrGoal({ id: 'b', title: 'D edit' })
  const results = await Promise.allSettled([c.QLS.store.flush(), d.QLS.store.flush()])
  assert.equal(results.filter(r => r.status === 'rejected').length, 1)
  const viewer = await open(factory)
  assert.equal(viewer.MS.loadTasks()[0].title, 'C edit')
  assert.equal(d.MS.loadTasks()[0].title, 'C edit', '被拒绝的页面应回到已提交状态')
})

test('并发完成计时：保留两个任务并用最新任务重新计算并行事件和分类汇总', async () => {
  const factory = createIdbFactory()
  const a = await open(factory), b = await open(factory)
  const now = new Date(2026, 9, 28, 9).getTime()
  for (const [page, title, hours] of [[a, '计时 A', 1], [b, '计时 B', 2]]) {
    const task = page.MS.startInProgressTask({ title, category: 'learn', tags: ['阅读'], now })
    page.MS.finishInProgressTask(task.id, now + hours * 3600000)
  }
  await Promise.all([a.QLS.store.flush(), b.QLS.store.flush()])
  const viewer = await open(factory)
  const record = viewer.QL.loadDayData('2026-10-28')
  assert.equal(viewer.MS.loadInProgressTasks().length, 2)
  assert.equal(record.timeEvents.length, 2)
  assert.ok(record.timeEvents.some(event => event._syncTaskIds.length === 2))
  assert.equal(record.time.learn, 2, '前一小时并行、后一小时单独进行，合计两小时')
})

test('导入：首屏 localStorage 镜像失败不造成半提交，全部条目从 IDB 恢复', async t => {
  t.mock.method(console, 'warn', () => {})
  const factory = createIdbFactory()
  const a = await open(factory)
  const proto = a.window.Storage.prototype, original = proto.setItem
  proto.setItem = function (key, value) {
    if (key === a.QLS.QL_ENTRY_KEY) throw new Error('mirror unavailable')
    return original.call(this, key, value)
  }
  try {
    assert.equal(await a.QLS.store.batchSet([
      { key: a.QLS.TASKS_KEY, value: [{ id: 'a', title: '导入任务' }] },
      { key: a.QLS.QL_ENTRY_KEY, value: 'report' },
    ]), 2)
    assert.equal(a.QLS.store.get(a.QLS.QL_ENTRY_KEY), 'report')
  } finally { proto.setItem = original }
  const b = await open(factory, { storage: { [a.QLS.QL_ENTRY_KEY]: 'index' } })
  assert.equal(b.QLS.store.get(a.QLS.QL_ENTRY_KEY), 'report')
  assert.equal(b.read(a.QLS.QL_ENTRY_KEY), 'report', '重启时重建陈旧首屏镜像')
  assert.equal(b.MS.loadTasks()[0].title, '导入任务')
})

test('导入：任一 IDB 写入失败时，业务数据、设置和内存全部保持原值', async t => {
  t.mock.method(console, 'error', () => {})
  const factory = createIdbFactory(), a = await open(factory)
  await a.QLS.store.batchSet([
    { key: 'schedule_keep', value: 'old' }, { key: a.QLS.QL_ENTRY_KEY, value: 'index' },
  ])
  const db = await database(factory)
  const store = db.transaction('keyvalue').objectStore('keyvalue')
  const proto = Object.getPrototypeOf(store), original = proto.put
  proto.put = function (value, ...args) {
    if (value.key === a.QLS.QL_ENTRY_KEY) throw new Error('disk full')
    return original.call(this, value, ...args)
  }
  try {
    assert.equal(await a.QLS.store.batchSet([
      { key: 'schedule_keep', value: 'new' }, { key: a.QLS.QL_ENTRY_KEY, value: 'report' },
    ]), 0)
  } finally { proto.put = original; db.close() }
  assert.equal(a.QLS.store.get('schedule_keep'), 'old')
  const b = await open(factory)
  assert.equal(b.QLS.store.get('schedule_keep'), 'old')
  assert.equal(b.QLS.store.get(a.QLS.QL_ENTRY_KEY), 'index')
})

test('连续保存失败：flush 拒绝，回滚到已提交状态，并允许同值重试', async t => {
  t.mock.method(console, 'error', () => {})
  const factory = createIdbFactory(), a = await open(factory)
  const db = await database(factory), proto = Object.getPrototypeOf(db), original = proto.transaction
  proto.transaction = function (name, mode, ...args) {
    if (mode === 'readwrite') throw new Error('storage unavailable')
    return original.call(this, name, mode, ...args)
  }
  try {
    a.QLS.store.set('schedule_failed', 'first failed')
    a.QLS.store.set('schedule_failed', 'second failed')
    const results = await Promise.allSettled([a.QLS.store.flush(), a.QLS.store.flush()])
    assert.ok(results.every(r => r.status === 'rejected'))
    assert.equal(a.QLS.store.has('schedule_failed'), false)
  } finally { proto.transaction = original; db.close() }
  a.QLS.store.set('schedule_failed', 'second failed')
  await a.QLS.store.flush()
  assert.equal((await open(factory)).QLS.store.get('schedule_failed'), 'second failed')
})

test('成功提示：事务失败不显示已保存，重试成功后才显示', async t => {
  t.mock.method(console, 'error', () => {})
  const factory = createIdbFactory(), a = await open(factory)
  const shown = []
  a.QLS.showToast = message => shown.push(message)
  const db = await database(factory), proto = Object.getPrototypeOf(db), original = proto.transaction
  proto.transaction = function (name, mode, ...args) {
    if (mode === 'readwrite') throw new Error('storage unavailable')
    return original.call(this, name, mode, ...args)
  }
  try {
    a.QLS.store.set('schedule_confirmation', 'value')
    assert.equal(await a.QLS.showSavedToast('已保存'), false)
    assert.equal(shown.includes('已保存'), false)
  } finally { proto.transaction = original; db.close() }
  a.QLS.store.set('schedule_confirmation', 'value')
  assert.equal(await a.QLS.showSavedToast('已保存'), true)
  assert.equal(shown.filter(message => message === '已保存').length, 1)
})

test('离页恢复降级：没有 Web Locks 时，仅恢复明确标记已离页的草稿', async () => {
  const factory = createIdbFactory()
  const a = await open(factory, {}, 'MAERS-QuantiLife/index.html')
  type(a.document.querySelector('#input-steps'), '1234')
  // 模拟离页时数据库无法写入，恢复必须来自保留的草稿副本。
  a.QL.saveDayData = () => false
  a.window.dispatchEvent(new a.window.Event('pagehide'))
  const drafts = Object.fromEntries(Object.keys(a.localStorage).map(key => [key, JSON.parse(a.localStorage.getItem(key))]))
  assert.ok(Object.keys(drafts).some(key => key.startsWith('qls_pending_day_')))
  a.close()
  const b = await open(factory, { storage: drafts }, 'MAERS-QuantiLife/index.html')
  assert.equal(b.QL.loadDayData(b.QLS.today()).basics.steps, 1234)
  assert.equal(b.document.querySelector('#input-steps').value, '1234')
  assert.equal(Object.keys(b.localStorage).some(key => key.startsWith('qls_pending_day_')), false)
})

test('离页草稿：成功保存后清理，保存为空的记录不会在重启时复活', async () => {
  const factory = createIdbFactory()
  const a = await open(factory, {}, 'MAERS-QuantiLife/index.html')
  type(a.document.querySelector('#input-steps'), '1234')
  click(a.document.querySelector('#save-btn'))
  await a.QLS.store.flush()
  assert.equal(Object.keys(a.localStorage).some(key => key.startsWith('qls_pending_day_')), false)
  type(a.document.querySelector('#input-steps'), '5678')
  type(a.document.querySelector('#input-steps'), '')
  click(a.document.querySelector('#save-btn'))
  await a.QLS.store.flush()
  assert.equal(Object.keys(a.localStorage).some(key => key.startsWith('qls_pending_day_')), false)
  assert.equal((await open(factory)).QLS.store.get(a.QLS.QL_PREFIX + a.QLS.today()), null)
})

test('两个记录页：广播到达后保存仍只修改本页编辑的字段', async () => {
  const factory = createIdbFactory()
  const a = await open(factory, {}, 'MAERS-QuantiLife/index.html')
  const b = await open(factory, {}, 'MAERS-QuantiLife/index.html')
  type(a.document.querySelector('#input-steps'), '8000')
  type(b.document.querySelector('#input-water'), '1500')
  click(a.document.querySelector('#save-btn'))
  await a.QLS.store.flush()
  await waitFor(() => b.QL.loadDayData(b.QLS.today())?.basics.steps === 8000)
  assert.equal(b.document.querySelector('#input-water').value, '1500')
  click(b.document.querySelector('#save-btn'))
  await b.QLS.store.flush()
  const data = (await open(factory)).QL.loadDayData(a.QLS.today())
  assert.equal(data.basics.steps, 8000)
  assert.equal(data.basics.water, 1500)
})

test('提交期间继续输入：后续修改以新提交状态为基线，不会误判冲突或丢失', async () => {
  const factory = createIdbFactory()
  const a = await open(factory, {}, 'MAERS-QuantiLife/index.html')
  const flush = a.QLS.store.flush
  let release
  const gate = new Promise(resolve => { release = resolve })
  a.QLS.store.flush = () => flush().then(() => gate)
  type(a.document.querySelector('#input-steps'), '1000')
  click(a.document.querySelector('#save-btn'))
  await flush()
  type(a.document.querySelector('#input-steps'), '2000')
  release()
  await new Promise(resolve => setTimeout(resolve, 0))
  a.QLS.store.flush = flush
  assert.equal(a.document.querySelector('#input-steps').value, '2000')
  click(a.document.querySelector('#save-btn'))
  await flush()
  assert.equal((await open(factory)).QL.loadDayData(a.QLS.today()).basics.steps, 2000)
})

test('仅恢复量化备份后编辑基础数据，不会删除缺少 Schedule 源任务的历史同步事件', async () => {
  const factory = createIdbFactory(), seed = await open(factory)
  const date = seed.QLS.today()
  await seed.QLS.store.batchSet([
    { key: seed.QLS.INPROGRESS_KEY, value: [] },
    { key: seed.QLS.TAGS_KEY, value: { 阅读: 'learn' } },
    { key: seed.QLS.QL_PREFIX + date, value: {
      ...plain(seed.QLS.createEmptyDay(date)),
      timeEvents: [{ name: '历史同步事件', h: 1, tags: ['阅读'], _isSync: true, _syncId: 'old' }],
    } },
  ])
  const page = await open(factory, {}, 'MAERS-QuantiLife/index.html')
  type(page.document.querySelector('#input-steps'), '1000')
  click(page.document.querySelector('#save-btn'))
  await page.QLS.store.flush()
  const day = page.QL.loadDayData(date)
  assert.equal(day.timeEvents[0].name, '历史同步事件')
  assert.equal(day.time.learn, 1)
})
