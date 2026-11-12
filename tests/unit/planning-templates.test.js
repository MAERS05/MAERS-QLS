'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, createIdbFactory, plain, waitFor } = require('../helpers/dom')

const block = (id, category = 'career', durationH = 3) => ({ id, label: id, startH: 9, durationH, category })
async function open(factory, options = {}) {
  const page = createPage('index.html', { indexedDB: factory, ...options })
  await page.ready()
  return page
}

for (const indexed of [false, true]) {
  test(`自定义列（${indexed ? 'IndexedDB' : '兼容存储'}）：默认占位，切换独立时间块并保留实际日期和其他量化目标`, async () => {
    const page = await open(indexed ? createIdbFactory() : undefined)
    const { MS, QL, QLS } = page
    assert.equal(MS.loadActiveTemplate(), null)
    assert.equal(MS.saveBlock('ideal', block('不可写占位')), null)
    assert.equal(MS.deleteBlock('ideal', '不存在'), false)
    assert.equal(MS.saveBlocksFromEditor({ origDate: 'ideal', targetDates: ['ideal'], block: block('占位') }, null), false)
    assert.equal(MS.selectTemplate('不存在'), false)
    assert.equal(MS.deleteTemplate('不存在'), false)
    assert.equal(MS.createTemplate('  '), null)
    assert.equal(MS.createTemplate('长'.repeat(25)), null)

    QL.saveExpectations({ steps: 9000, water: 2000, sleep: 8, mood: 'great', diet: [{ name: '早餐' }] })
    MS.saveBlock('2026-11-01', block('实际安排', 'learn', 1))
    const work = MS.createTemplate(' 工作 ')
    assert.ok(work)
    assert.equal(MS.createTemplate('工作'), null)
    MS.saveBlock('ideal', block('研发'))
    await QLS.store.flush()
    assert.equal(QL.loadExpectations().time.career.hours, 3)

    const holiday = MS.createTemplate('假期')
    MS.saveBlocksFromEditor({ origDate: 'ideal', targetDates: ['ideal'], block: block('运动', 'health', 2) }, QLS.store.get(QLS.TIMEBLOCK_KEY))
    await QLS.store.flush()
    assert.equal(QL.loadExpectations().time.career.hours, 0)
    assert.equal(QL.loadExpectations().time.health.hours, 2)
    MS.selectTemplate(work.id)
    await QLS.store.flush()
    assert.deepEqual(plain(MS.loadBlocks('ideal').map(item => item.label)), ['研发'])
    assert.equal(QL.loadExpectations().time.career.hours, 3)
    assert.equal(QL.loadExpectations().steps, 9000)
    assert.equal(QL.loadExpectations().water, 2000)
    assert.equal(QL.loadExpectations().mood, 'great')
    assert.equal(MS.loadBlocks('2026-11-01')[0].label, '实际安排')

    MS.saveBlock('2026-11-02', block('另一实际安排'))
    await QLS.store.flush()
    assert.equal(QL.loadExpectations().time.career.hours, 3)
    MS.deleteBlock('ideal', '研发')
    await QLS.store.flush()
    assert.equal(QL.loadExpectations().time.career.hours, 0)
    MS.deleteTemplate(work.id)
    await QLS.store.flush()
    assert.equal(MS.loadActiveTemplate().id, holiday.id)
    assert.equal(QL.loadExpectations().time.health.hours, 2)
    MS.deleteTemplate(holiday.id)
    await QLS.store.flush()
    assert.equal(MS.loadActiveTemplate(), null)
    assert.equal(QL.loadExpectations().time.health.hours, 0)
    assert.equal(QL.loadExpectations().steps, 9000)
  })
}

test('自定义列：旧备份迁入原期望，新备份保留所有模板和选中状态', async () => {
  const page = await open(createIdbFactory())
  const { MS, QL, QLS } = page
  assert.equal(await MS.importBackup(QLS.createBackup({ schedule_timeblocks: {
    ideal: [{ ...block('旧学习', 'learn', 2), category: undefined, color: '#7371c0' }],
    '2026-11-01': [block('实际计划')],
  } })), 1)
  assert.equal(MS.loadActiveTemplate().name, '原期望')
  assert.equal(QL.loadExpectations().time.learn.hours, 2)
  const holiday = MS.createTemplate('假期')
  MS.saveBlock('ideal', block('锻炼', 'health', 1.5))
  await QLS.store.flush()
  const exported = MS.exportBackup().data
  const restored = await open(createIdbFactory())
  assert.ok(await restored.MS.importBackup(exported))
  assert.equal(restored.MS.loadActiveTemplate().id, holiday.id)
  assert.equal(restored.MS.loadTemplates().items.length, 2)
  assert.equal(restored.QL.loadExpectations().time.health.hours, 1.5)
  assert.equal(restored.MS.loadBlocks('2026-11-01')[0].label, '实际计划')
})

test('自定义列：旧页面编辑原方案时，保留另一页新选中的方案和量化时间', async () => {
  const factory = createIdbFactory()
  const a = await open(factory)
  const work = a.MS.createTemplate('工作')
  a.MS.saveBlock('ideal', block('研发'))
  const holiday = a.MS.createTemplate('假期')
  a.MS.saveBlock('ideal', block('锻炼', 'health', 2))
  a.MS.selectTemplate(work.id)
  await a.QLS.store.flush()
  const base = plain(a.QLS.store.getCommitted(a.QLS.TIMEBLOCK_KEY))
  const b = await open(factory)
  b.MS.selectTemplate(holiday.id)
  await b.QLS.store.flush()
  a.MS.saveBlock('ideal', block('研发', 'career', 4), { base })
  await a.QLS.store.flush()
  const viewer = await open(factory)
  assert.equal(viewer.MS.loadActiveTemplate().id, holiday.id)
  assert.equal(viewer.QL.loadExpectations().time.health.hours, 2)
  viewer.MS.selectTemplate(work.id)
  await viewer.QLS.store.flush()
  assert.equal(viewer.QL.loadExpectations().time.career.hours, 4)
})

test('自定义列：量化写入失败时方案与时间块整体回滚，重试后两者一起落盘', async t => {
  t.mock.method(console, 'error', () => {})
  const factory = createIdbFactory()
  const page = await open(factory)
  const work = page.MS.createTemplate('工作')
  page.MS.saveBlock('ideal', block('研发'))
  const holiday = page.MS.createTemplate('假期')
  await page.QLS.store.flush()
  page.MS.selectTemplate(work.id)
  await page.QLS.store.flush()

  const request = factory.open('maers-qls-data', 1)
  const db = await new Promise(resolve => { request.onsuccess = () => resolve(request.result) })
  const proto = Object.getPrototypeOf(db.transaction('keyvalue').objectStore('keyvalue'))
  const original = proto.put
  proto.put = function (value, ...args) {
    if (value.key === page.QLS.EXPECTATIONS_KEY) throw new Error('quota failure')
    return original.call(this, value, ...args)
  }
  try {
    page.MS.selectTemplate(holiday.id)
    await assert.rejects(page.QLS.store.flush())
  } finally { proto.put = original; db.close() }
  const unchanged = await open(factory)
  assert.equal(unchanged.MS.loadActiveTemplate().id, work.id)
  assert.equal(unchanged.QL.loadExpectations().time.career.hours, 3)
  page.MS.selectTemplate(holiday.id)
  await page.QLS.store.flush()
  await waitFor(() => unchanged.MS.loadActiveTemplate().id === holiday.id)
  assert.equal(unchanged.QL.loadExpectations().time.career.hours, 0)
})

test('自定义列：旧 localStorage 搬迁时保留模板，空期望列仍是默认占位', async () => {
  const migrated = await open(createIdbFactory(), { storage: { schedule_timeblocks: { ideal: [block('旧安排')] } } })
  assert.equal(migrated.MS.loadActiveTemplate().name, '原期望')
  assert.equal(migrated.MS.loadBlocks('ideal')[0].label, '旧安排')
  assert.equal(migrated.QLS.store.get(migrated.QLS.TIMEBLOCK_KEY).ideal, undefined)
  const empty = await open(createIdbFactory(), { storage: { schedule_timeblocks: { ideal: [] } } })
  assert.equal(empty.MS.loadActiveTemplate(), null)
})
