'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, createIdbFactory, click } = require('../helpers/dom')

test('午夜边界：23:46–23:59 分钟精度保存、读取和备份导入保持不变', async () => {
  const page = createPage('MAERS-Schedule/index.html')
  for (const minute of [46, 50, 59]) {
    page.MS.saveBlock('2026-10-28', {
      id: 'late-' + minute, label: '午夜前', startH: 23 + minute / 60, durationH: 1 / 60,
    })
  }
  const restored = createPage('MAERS-Schedule/index.html')
  await restored.MS.importBackup(page.MS.exportBackup().data)
  for (const [index, minute] of [46, 50, 59].entries()) {
    assert.equal(page.MS.loadBlocks('2026-10-28')[index].startH, 23 + minute / 60)
    assert.equal(restored.MS.loadBlocks('2026-10-28')[index].startH, 23 + minute / 60)
  }
  page.MS.openBlockModal({ dateStr: '2026-10-29', startH: 23 + 59 / 60 })
  page.document.querySelector('#tb-block-label').value = '最后一分钟'
  page.document.querySelector('#tb-block-start').value = '23:59'
  page.document.querySelector('#tb-block-end').value = '00:00'
  click(page.document.querySelector('#tb-block-save'))
  const [block] = page.MS.loadBlocks('2026-10-29')
  assert.equal(block.startH, 23 + 59 / 60)
  assert.ok(Math.abs(block.durationH - 1 / 60) < 1e-10)
})

test('最终时长：缩短可跨多个分段，零值不入账，小于一分钟不被放大', () => {
  const page = createPage('index.html')
  const base = {
    id: 'segments', title: '多段计时', date: '2026-10-28', status: 'completed', tags: ['learn'],
    segments: [
      { manualEdited: true, startHm: '09:00', endHm: '11:00' },
      { manualEdited: true, startHm: '13:00', endHm: '15:00' },
    ],
  }
  for (const finalHours of [0, 0.01, 1, 2, 3, 4, 5]) {
    const events = page.MAERS_BRIDGE.sliceParallelTasksToEvents([{ ...base, finalHours }], base.date)
    assert.ok(Math.abs(events.reduce((total, event) => total + event.h, 0) - finalHours) < 1e-6, String(finalHours))
    if (finalHours === 1) assert.deepEqual([events[0].segments[0].startHm, events[0].segments[0].endHm], ['09:00', '10:00'])
  }
})

for (const action of ['delete', 'shorten', 'untag', 'move']) {
  test(`跨多个午夜 ${action}：清理所有旧覆盖日，保留手动记录`, async () => {
    const page = createPage('index.html', { indexedDB: createIdbFactory() })
    await page.ready()
    const { MS, QL, QLS } = page
    const start = new Date(2026, 9, 20, 9).getTime()
    const task = MS.startInProgressTask({ title: '跨三天', category: 'learn', tags: ['阅读'], now: start })
    MS.finishInProgressTask(task.id, start + 72 * 3600000)
    await QLS.store.flush()
    assert.equal(QL.loadDayData('2026-10-23').timeEvents.length, 1)
    const data = QL.loadDayData('2026-10-23')
    data.basics.steps = 3456
    QL.saveDayData(data)
    await QLS.store.flush()
    if (action === 'delete') MS.deleteInProgressTask(task.id)
    else if (action === 'untag') MS.updateInProgressTask(task.id, { title: task.title, tags: [] })
    else MS.settleInProgressTask(task.id, {
      title: task.title, tags: task.tags, finalHours: 1,
      segments: action === 'move'
        ? [{ startAt: start + 5 * 86400000, endAt: start + 5 * 86400000 + 3600000 }]
        : MS.loadInProgressTasks()[0].segments,
    })
    await QLS.store.flush()
    const last = QL.loadDayData('2026-10-23')
    assert.equal(last.basics.steps, 3456)
    assert.equal(last.timeEvents.length, 0)
    assert.equal(QL.loadDayData('2026-10-21'), null)
    assert.equal(QL.loadDayData('2026-10-22'), null)
    if (action === 'shorten') assert.equal(QL.loadDayData('2026-10-20').time.learn, 1)
    if (action === 'move') assert.equal(QL.loadDayData('2026-10-25').time.learn, 1)
    const viewer = createPage('index.html', { indexedDB: page.window.indexedDB })
    await viewer.ready()
    assert.equal(viewer.QL.loadDayData('2026-10-23').timeEvents.length, 0, '磁盘同样清理完毕')
  })
}

function history(page, count) {
  return Array.from({ length: count }, (_, index) => {
    const start = new Date(2024, 0, 1 + index, 9)
    return {
      id: 'history-' + index, title: '历史计时', date: page.QLS.dateKey(start),
      status: 'completed', tags: ['learn'], finalHours: 1,
      segments: [{ startAt: start.getTime(), endAt: start.getTime() + 3600000 }],
    }
  })
}

test('历史同步：1000 个不同日期的任务只提取一次区间；增量修改只写覆盖日', () => {
  const page = createPage('index.html')
  const list = history(page, 1000)
  const projection = page.QLS.timerEvents, extract = projection.extractTaskDayIntervals
  let calls = 0
  projection.extractTaskDayIntervals = function (...args) { calls++; return extract.apply(this, args) }
  page.MAERS_BRIDGE.syncDayFromSchedule(list.at(-1).date, list)
  assert.equal(calls, list.length)
  assert.equal(page.QL.loadDayData(list.at(-1).date).time.learn, 1)
  const set = page.QLS.store.set
  const written = []
  page.QLS.store.set = (...args) => { written.push(args[0]); return set(...args) }
  calls = 0
  list.at(-1).title = '已更名'
  page.MAERS_BRIDGE.syncDayFromSchedule(list.at(-1).date, list, [list.at(-1)])
  assert.equal(calls, list.length + 1)
  assert.deepEqual(written, [page.QLS.QL_PREFIX + list.at(-1).date])
})

test('IDB 同步：同批多个日期共享最新任务区间索引，不在每次事务中重扫历史', async () => {
  const page = createPage('index.html', { indexedDB: createIdbFactory() })
  await page.ready()
  const list = history(page, 80)
  page.MS.saveInProgressTasks(list)
  await page.QLS.store.flush()
  const projection = page.QLS.timerEvents, extract = projection.extractTaskDayIntervals
  let calls = 0
  projection.extractTaskDayIntervals = function (...args) { calls++; return extract.apply(this, args) }
  page.MAERS_BRIDGE.syncDayFromSchedule(list.at(-1).date, list)
  await page.QLS.store.flush()
  assert.equal(calls, list.length, '任务事务已生成日记录，相同同步结果无需再次提交和重建索引')
  assert.equal(page.QL.loadDayData(list.at(-1).date).time.learn, 1)
})

test('陈旧页面删除旧任务：并发新增的其他计时事件仍保留', async () => {
  const factory = createIdbFactory()
  const options = { indexedDB: factory, beforeScripts(win) { win.BroadcastChannel = undefined } }
  const a = createPage('index.html', options)
  await a.ready()
  const start = new Date(2026, 9, 28, 9).getTime()
  const first = a.MS.startInProgressTask({ title: '将删除', category: 'learn', tags: ['阅读'], now: start })
  a.MS.finishInProgressTask(first.id, start + 3600000)
  await a.QLS.store.flush()
  const b = createPage('index.html', options)
  await b.ready()
  const second = b.MS.startInProgressTask({ title: '并发保留', category: 'learn', tags: ['阅读'], now: start + 2 * 3600000 })
  b.MS.finishInProgressTask(second.id, start + 3 * 3600000)
  await b.QLS.store.flush()
  a.MS.deleteInProgressTask(first.id)
  await a.QLS.store.flush()
  const viewer = createPage('index.html', options)
  await viewer.ready()
  const events = viewer.QL.loadDayData('2026-10-28').timeEvents
  assert.equal(events.length, 1)
  assert.equal(events[0].name, '并发保留')
})
