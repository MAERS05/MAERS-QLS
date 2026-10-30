'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createPage, createIdbFactory, click, type, waitFor, plain, ROOT } = require('../helpers/dom')

async function open(factory, page = 'index.html') {
  const p = createPage(page, { indexedDB: factory })
  await p.ready()
  p.MS && (p.MS.today = () => '2026-10-28')
  return p
}
const at = (day, hour) => new Date(2026, 9, day, hour).getTime()
async function complete(p, crossDay = false) {
  const task = p.MS.startInProgressTask({ title: '阅读', category: 'learn', tags: ['阅读'], now: at(28, crossDay ? 23 : 9) })
  p.MS.finishInProgressTask(task.id, at(crossDay ? 29 : 28, crossDay ? 1 : 10))
  await p.QLS.store.flush()
  return task.id
}

for (const conflict of [false, true]) {
  test(`旧计时面板：${conflict ? '同字段冲突保留输入' : '只改名称保留另一页新时长'}`, async t => {
    t.mock.method(console, 'error', () => {})
    const f = createIdbFactory(), a = await open(f, 'MAERS-Schedule/index.html')
    const id = await complete(a), b = await open(f)
    a.MS.renderInProgress()
    click(a.document.querySelector(`[data-ip-action="edit"][data-id="${id}"]`))
    const task = b.MS.loadInProgressTasks()[0]
    b.MS.settleInProgressTask(id, { ...task, finalHours: 2 })
    await b.QLS.store.flush()
    await waitFor(() => a.MS.loadInProgressTasks()[0].finalHours === 2)
    type(a.document.querySelector(conflict ? '#ip-settle-total' : '#ip-settle-title'), conflict ? '03:00' : '新名称')
    click(a.document.querySelector('#ip-settle-save'))
    if (conflict) {
      await assert.rejects(a.QLS.store.flush())
      assert.equal(a.document.querySelector('#ip-settle-modal').open, true)
      assert.equal(a.document.querySelector('#ip-settle-total').value, '03:00')
    } else await a.QLS.store.flush()
    const viewer = await open(f)
    assert.equal(viewer.MS.loadInProgressTasks()[0].finalHours, 2)
    assert.equal(viewer.QL.loadDayData('2026-10-28').time.learn, 2)
  })
}

test('旧期望面板：修改饮水保留另一页的最新步数', async () => {
  const f = createIdbFactory(), a = await open(f, 'MAERS-QuantiLife/index.html')
  a.QL.saveExpectations({ steps: 100, water: 200 })
  await a.QLS.store.flush()
  const b = await open(f)
  click(a.document.querySelector('#exp-open-btn'))
  b.QL.saveExpectations({ ...plain(b.QL.loadExpectations()), steps: 999 })
  await b.QLS.store.flush()
  await waitFor(() => a.QL.loadExpectations().steps === 999)
  type(a.document.querySelector('#exp-water'), '500')
  click(a.document.querySelector('#exp-save'))
  await a.QLS.store.flush()
  const viewer = await open(f)
  assert.equal(viewer.QL.loadExpectations().steps, 999)
  assert.equal(viewer.QL.loadExpectations().water, 500)
})

test('Schedule 导入重算新旧日期，同时保留手动记录', async () => {
  const f = createIdbFactory(), a = await open(f)
  await complete(a)
  const day = a.QL.loadDayData('2026-10-28')
  day.basics.steps = 123
  a.QL.saveDayData(day)
  await a.QLS.store.flush()
  const backup = a.MS.exportBackup().data
  await a.MS.importBackup(a.QLS.createBackup({ [a.QLS.INPROGRESS_KEY]: [] }))
  const viewer = await open(f)
  assert.equal(viewer.MS.loadInProgressTasks().length, 0)
  assert.equal(viewer.QL.loadDayData('2026-10-28').timeEvents.length, 0)
  assert.equal(viewer.QL.loadDayData('2026-10-28').basics.steps, 123)
  await viewer.MS.importBackup(backup)
  assert.equal(viewer.QL.loadDayData('2026-10-28').time.learn, 1)
})

test('任务归一化和桥接拒绝巨大时长；时间精度全部可往返', async () => {
  const a = await open(createIdbFactory())
  const task = { id: 'huge', title: '巨大时长', date: '2026-10-28', tags: ['阅读'], status: 'completed', segments: [], finalHours: 1e100 }
  const result = a.MS.prepareImportEntries(a.QLS.createBackup({ [a.QLS.INPROGRESS_KEY]: [task] }))
  assert.equal(result.entries[0].value.length, 0)
  assert.equal(a.QLS.timerEvents.extractTaskDayIntervals(task).length, 0)
  for (const step of a.QLS.TB_STEPS) {
    assert.equal(await a.MS.importBackup(a.QLS.createBackup({ [a.QLS.TB_STEP_KEY]: step })), 1)
    assert.equal(a.QLS.store.get(a.QLS.TB_STEP_KEY), step)
  }
})

test('秒表读取缓存仅随任务版本变化而重新解析历史', () => {
  const a = createPage('index.html')
  a.MS.startInProgressTask({ title: '计时', tags: [], now: at(28, 9) })
  let reads = 0
  const load = a.MS.loadInProgressTasks
  a.MS.loadInProgressTasks = () => { reads++; return load() }
  assert.equal(a.MS.loadRunningTasks().length, 1)
  a.MS.loadRunningTasks()
  assert.equal(reads, 1)
  a.MS.pauseInProgressTask(a.MS.loadRunningTasks()[0].id, at(28, 10))
  const before = reads
  assert.equal(a.MS.loadRunningTasks().length, 0)
  assert.equal(reads, before + 1)
})

test('发布资源排除点文件、备份、临时数据', t => {
  const readdir = fs.readdirSync
  t.mock.method(fs, 'readdirSync', function (dir, ...args) {
    const entries = readdir.call(this, dir, ...args)
    if (path.resolve(dir) === path.join(ROOT, 'common')) {
      for (const name of ['.private.env', 'user-backup.json', 'temp.json', 'secret.js']) entries.push({ name, isDirectory: () => false })
    }
    return entries
  })
  const { publicFiles } = require('../../scripts/build-static')
  const files = publicFiles()
  assert.ok(files.includes('common/js/core.js'))
  assert.ok(!files.some(file => /private|backup|temp\.json|secret/.test(file)))
})
