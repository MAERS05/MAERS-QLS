'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, createIdbFactory, click, type, waitFor } = require('../helpers/dom')

async function open(factory) {
  const page = createPage('MAERS-Schedule/index.html', { indexedDB: factory })
  await page.ready()
  page.MS.today = () => '2026-10-28'
  return page
}

function openAdjustment(page, id) {
  page.MS.renderInProgress()
  click(page.document.querySelector(`[data-ip-action="edit"][data-id="${id}"]`))
  assert.equal(page.document.querySelector('#ip-settle-modal').open, true)
}

const at = (date, hour) => new Date(2026, 9, date, hour).getTime()

for (const sameField of [false, true]) {
  test(`时间块旧弹窗：${sameField ? '同字段冲突保留输入' : '只改备注保留另一标签页的新名称'}`, async t => {
    t.mock.method(console, 'error', () => {})
    const factory = createIdbFactory(), a = await open(factory)
    a.MS.saveBlock('2026-10-28', { id: 'reading', label: '读书', startH: 9, durationH: 1 })
    await a.QLS.store.flush()
    const b = await open(factory)
    a.MS.openBlockModal({ dateStr: '2026-10-28', block: a.MS.loadBlocks('2026-10-28')[0] })
    b.MS.saveBlock('2026-10-28', { ...b.MS.loadBlocks('2026-10-28')[0], label: '学习' })
    await b.QLS.store.flush()
    await waitFor(() => a.MS.loadBlocks('2026-10-28')[0].label === '学习')
    type(a.document.querySelector(sameField ? '#tb-block-label' : '#tb-block-notes'), sameField ? '写作' : '本页备注')
    click(a.document.querySelector('#tb-block-save'))
    if (sameField) {
      await assert.rejects(a.QLS.store.flush())
      assert.equal(a.document.querySelector('#tb-modal').open, true)
      assert.equal(a.document.querySelector('#tb-block-label').value, '写作')
    } else await a.QLS.store.flush()
    const viewer = await open(factory)
    const block = viewer.MS.loadBlocks('2026-10-28')[0]
    assert.equal(block.label, '学习')
    assert.equal(block.notes, sameField ? '' : '本页备注')
  })
}

for (const crossDay of [false, true]) {
  test(`完成任务原子性：${crossDay ? '第二天' : '当天'}量化写入失败时，任务和所有日记录均回滚，重试只记一次`, async t => {
    t.mock.method(console, 'error', () => {})
    const factory = createIdbFactory(), page = await open(factory)
    const task = page.MS.startInProgressTask({ title: '阅读', category: 'learn', tags: ['阅读'], now: at(28, crossDay ? 23 : 9) })
    await page.QLS.store.flush()
    const dayKey = page.QLS.QL_PREFIX + (crossDay ? '2026-10-29' : '2026-10-28')
    const database = await new Promise(resolve => {
      const request = factory.open('maers-qls-data', 1)
      request.onsuccess = () => resolve(request.result)
    })
    const proto = Object.getPrototypeOf(database.transaction('keyvalue').objectStore('keyvalue'))
    const put = proto.put
    proto.put = function (record, ...args) {
      if (record.key === dayKey) throw new Error('injected quantification failure')
      return put.call(this, record, ...args)
    }
    const end = at(crossDay ? 29 : 28, crossDay ? 1 : 10)
    try {
      page.MS.finishInProgressTask(task.id, end)
      await assert.rejects(page.QLS.store.flush())
    } finally { proto.put = put; database.close() }
    const viewer = await open(factory)
    assert.equal(viewer.MS.loadInProgressTasks()[0].status, 'running')
    for (const date of ['2026-10-28', '2026-10-29']) {
      assert.equal(viewer.QLS.store.getCommitted(viewer.QLS.QL_PREFIX + date), null)
    }
    viewer.MS.finishInProgressTask(task.id, end)
    await viewer.QLS.store.flush()
    const reopened = await open(factory)
    assert.equal(reopened.MS.loadInProgressTasks()[0].status, 'completed')
    assert.equal(reopened.QLS.store.getCommitted(dayKey).time.learn, 1)
    assert.equal(reopened.QLS.store.getCommitted(dayKey).timeEvents.length, 1)
  })
}

for (const hours of [30, 48.5]) {
  test(`累计 ${hours} 小时：打开调整面板直接保存，时长不截短，刷新后保持`, async () => {
    const factory = createIdbFactory(), page = await open(factory)
    const start = at(28, 9)
    const task = page.MS.startInProgressTask({ title: '多日计时', category: 'learn', tags: ['阅读'], now: start })
    page.MS.finishInProgressTask(task.id, start + hours * 3600000)
    await page.QLS.store.flush()
    openAdjustment(page, task.id)
    assert.equal(page.document.querySelector('#ip-settle-total').value, hours === 30 ? '30:00' : '48:30')
    click(page.document.querySelector('#ip-settle-save'))
    await page.QLS.store.flush()
    const viewer = await open(factory)
    assert.equal(viewer.MS.loadInProgressTasks()[0].finalHours, hours)
    const total = viewer.QLS.store.keys(viewer.QLS.QL_PREFIX)
      .reduce((sum, key) => sum + (viewer.QLS.store.getCommitted(key)?.time?.learn || 0), 0)
    assert.equal(total, hours)
  })
}

test('累计时长可手动输入 30:30；非法输入不能把已有时长变为零', async () => {
  const page = await open(createIdbFactory())
  const task = page.MS.startInProgressTask({ title: '累计', tags: [], now: at(28, 9) })
  page.MS.finishInProgressTask(task.id, at(28, 10))
  await page.QLS.store.flush()
  openAdjustment(page, task.id)
  type(page.document.querySelector('#ip-settle-total'), '30:99')
  click(page.document.querySelector('#ip-settle-save'))
  assert.equal(page.document.querySelector('#ip-settle-modal').open, true)
  assert.equal(page.MS.loadInProgressTasks()[0].finalHours, 1)
  type(page.document.querySelector('#ip-settle-total'), '30:30')
  click(page.document.querySelector('#ip-settle-save'))
  await page.QLS.store.flush()
  assert.equal(page.MS.loadInProgressTasks()[0].finalHours, 30.5)
})

test('28 日创建、29 日继续：调整 09:00–10:00 为 10:30 后仍计入 29 日', async () => {
  const factory = createIdbFactory(), page = await open(factory)
  const task = page.MS.startInProgressTask({ title: '跨日阅读', category: 'learn', tags: ['阅读'], now: at(28, 9) })
  page.MS.pauseInProgressTask(task.id, at(28, 10))
  page.MS.resumeInProgressTask(task.id, at(29, 9))
  page.MS.finishInProgressTask(task.id, at(29, 10))
  await page.QLS.store.flush()
  openAdjustment(page, task.id)
  page.MS.pickClock = (_, options) => options.onPick('10:30')
  click(page.document.querySelector('[data-seg-field="endHm"][data-seg-idx="1"]'))
  assert.equal(page.document.querySelector('#ip-settle-total').value, '02:30')
  click(page.document.querySelector('#ip-settle-save'))
  await page.QLS.store.flush()
  const viewer = await open(factory)
  assert.equal(viewer.QLS.store.getCommitted('quantilife_2026-10-28').time.learn, 1)
  assert.equal(viewer.QLS.store.getCommitted('quantilife_2026-10-29').time.learn, 1.5)
  assert.equal(viewer.MS.loadInProgressTasks()[0].segments[1].date, '2026-10-29')
})

test('旧手动段仍用原时间戳定位日期，午夜结束边界不重复偏移一天', () => {
  const page = createPage('MAERS-Schedule/index.html')
  const task = { id: 'old', title: '阅读', date: '2026-10-28', status: 'completed', tags: ['阅读'],
    segments: [{ startAt: at(29, 23), endAt: at(30, 0), startHm: '23:00', endHm: '24:00', manualEdited: true }] }
  const events = page.MAERS_BRIDGE.sliceParallelTasksToEvents([task], '2026-10-29')
  assert.equal(events[0].h, 1)
})
