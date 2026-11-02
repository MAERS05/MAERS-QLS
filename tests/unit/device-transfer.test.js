'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, createIdbFactory, plain, waitFor } = require('../helpers/dom')

async function open(factory = createIdbFactory(), options = {}) {
  const page = createPage('index.html', { indexedDB: factory, ...options })
  await page.ready()
  page.transfer = page.module('common/js/device-transfer.js').deviceTransfer
  return page
}
async function seed(page, title, date = '2026-11-01') {
  page.MS.saveTaskOrGoal({ title, tier: 'short' })
  page.QL.saveDayData({ date, basics: { steps: 123 }, mood: 'good', timeEvents: [] })
  const template = page.MS.createTemplate(title)
  page.MS.saveBlock('ideal', { label: title, category: 'learn', startH: 9, durationH: 2 })
  await page.QLS.store.flush()
  return template
}
async function dbOf(factory) {
  const request = factory.open('maers-qls-data', 1)
  return new Promise(resolve => { request.onsuccess = () => resolve(request.result) })
}

test('设备覆盖：快照包含自定义列，确认后删除接收端独有记录，保留本机外观，重启和恢复都完整', async () => {
  const source = await open(), factory = createIdbFactory(), target = await open(factory)
  const template = await seed(source, '来源')
  await seed(target, '旧数据', '2026-10-01')
  target.QLS.store.set(target.QLS.THEME_KEY, 'dark')
  await target.QLS.store.flush()
  const before = await target.transfer.local()
  const outgoing = await source.transfer.outgoing()
  const prepared = target.transfer.prepare(outgoing.text)
  assert.equal(prepared.summary.templates, 1)
  assert.equal(target.MS.loadTasks()[0].title, '旧数据', '预览不能提前修改数据')
  const receipt = await target.transfer.accept(prepared, before)
  assert.equal(receipt.id, outgoing.envelope.id)
  assert.equal(target.MS.loadTasks()[0].title, '来源')
  assert.equal(target.MS.loadActiveTemplate().id, template.id)
  assert.equal(target.QL.loadDayData('2026-10-01'), null)
  assert.equal(target.QLS.store.get(target.QLS.THEME_KEY), 'dark')
  assert.equal(target.QL.loadExpectations().time.learn.hours, 2)
  assert.equal((await target.transfer.local()).recovery, true)
  // 同一传输重复回执不会再次覆盖后来保存的内容，也不会替换恢复副本。
  target.MS.saveTaskOrGoal({ title: '随后新增', tier: 'short' })
  await target.QLS.store.flush()
  assert.equal((await target.transfer.accept(prepared, before)).id, receipt.id)
  assert.equal(target.MS.loadTasks().length, 2)
  const restarted = await open(factory)
  assert.equal(restarted.MS.loadTasks().length, 2)
  await restarted.transfer.restore()
  assert.equal(restarted.MS.loadTasks()[0].title, '旧数据')
  assert.ok(restarted.QL.loadDayData('2026-10-01'))
  assert.equal(restarted.QL.loadDayData('2026-11-01'), null)
})

test('设备覆盖：空快照是真正清空；预览后发生编辑必须重新确认', async () => {
  const source = await open(), target = await open()
  await seed(target, '保留到确认')
  const prepared = target.transfer.prepare((await source.transfer.outgoing()).text)
  const preview = await target.transfer.local()
  target.MS.saveTaskOrGoal({ title: '预览后新增' })
  await target.QLS.store.flush()
  await assert.rejects(target.transfer.accept(prepared, preview), /重新确认/)
  assert.equal(target.MS.loadTasks().length, 2)
  const current = await target.transfer.local()
  const receipt = await target.transfer.accept(prepared, current)
  assert.equal(receipt.count, 0)
  assert.equal(target.MS.loadTasks().length, 0)
  assert.equal(target.MS.loadActiveTemplate(), null)
  await target.transfer.restore()
  assert.equal(target.MS.loadTasks().length, 2)
})

test('设备覆盖：覆盖后旧页不能保存，旧草稿保留但不复活', async t => {
  t.mock.method(console, 'error', () => {})
  const source = await open(), factory = createIdbFactory(), target = await open(factory)
  await seed(source, '新数据')
  const old = await open(factory)
  const key = 'quantilife_2026-10-01'
  old.QLS.store.stage(key, { date: '2026-10-01', basics: { steps: 999 } })
  const draftKey = Array.from({ length: old.localStorage.length }, (_, i) => old.localStorage.key(i)).find(key => key.startsWith('qls_pending_day_'))
  const draft = JSON.parse(old.localStorage.getItem(draftKey))
  const prepared = target.transfer.prepare((await source.transfer.outgoing()).text)
  await target.transfer.accept(prepared, await target.transfer.local())
  await waitFor(() => old.MS.loadTasks().length === 1)
  old.MS.saveTaskOrGoal({ title: '陈旧页面保存' })
  await assert.rejects(old.QLS.store.flush(), /未能全部保存/)
  const reopened = await open(factory, { storage: { [draftKey]: { ...draft, closed: true } } })
  assert.equal(reopened.MS.loadTasks().length, 1)
  assert.equal(reopened.QL.loadDayData('2026-10-01'), null)
  assert.ok(reopened.localStorage.getItem(draftKey), '覆盖前草稿应保留供人工恢复')
  await assert.rejects(old.transfer.outgoing())
})

test('设备覆盖：中途写入失败时数据、恢复副本、回执和代次整体回滚，允许重试', async t => {
  t.mock.method(console, 'error', () => {})
  const source = await open(), factory = createIdbFactory(), target = await open(factory)
  await seed(source, '新数据'); await seed(target, '原数据')
  const prepared = target.transfer.prepare((await source.transfer.outgoing()).text)
  const before = await target.transfer.local()
  const db = await dbOf(factory)
  const proto = Object.getPrototypeOf(db.transaction('keyvalue').objectStore('keyvalue')), original = proto.put
  proto.put = function (record, ...args) {
    if (record.key === '__transfer_receipt__') throw new Error('disk full')
    return original.call(this, record, ...args)
  }
  try { await assert.rejects(target.transfer.accept(prepared, before), /disk full/) }
  finally { proto.put = original; db.close() }
  const unchanged = await target.transfer.local()
  assert.equal(unchanged.baseline, before.baseline)
  assert.equal(unchanged.recovery, false)
  assert.equal(unchanged.receipt, null)
  await target.transfer.accept(prepared, before)
  assert.equal(target.MS.loadTasks()[0].title, '新数据')
})

test('设备覆盖：异常版本、未知键、坏记录和运行中计时都阻止覆盖', async () => {
  const page = await open()
  const outgoing = await page.transfer.outgoing()
  for (const extra of [{ complete: false }, { schema: 999 }, { id: 'bad' }, { data: { qls_theme: 'dark' } },
    { data: { schedule_tasks: [{ title: '' }] } }, { data: { schedule_inprogress: [{ id: 't', title: '计时', status: 'running' }] } }]) {
    assert.throws(() => page.transfer.prepare(JSON.stringify({ ...plain(outgoing.envelope), ...extra })))
  }
  assert.throws(() => page.transfer.prepare('x'.repeat(10 * 1024 * 1024 + 1)), /上限/)
  assert.throws(() => page.transfer.prepare('{}'), /版本/)
  page.MS.startInProgressTask({ title: '还在计时' })
  await page.QLS.store.flush()
  await assert.rejects(page.transfer.outgoing(), /暂停/)
  await assert.rejects(page.transfer.local(), /暂停/)
  const fallback = createPage('index.html')
  await assert.rejects(fallback.module('common/js/device-transfer.js').deviceTransfer.local(), /IndexedDB/)
  await assert.rejects(page.QLS.store.replaceSnapshot({ qls_theme: 'light' }, { baseline: '', id: 'x', checksum: 'x' }), /范围外/)
  await assert.rejects(page.QLS.store.replaceSnapshot({}, {}), /无效/)
})
