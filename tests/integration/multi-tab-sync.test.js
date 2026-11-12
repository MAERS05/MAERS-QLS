/**
 * 多标签页同步集成测试 (tests/integration/multi-tab-sync.test.js)
 * 以真实页面 + 共享 IndexedDB 模拟同一浏览器的多个标签页，验证：
 * Schedule 结束计时 → 已打开的 QuantiLife 记录页 / 报告页自动更新；
 * 其他标签页修改 Schedule 数据 → 当前视图刷新（弹窗编辑中延后）；
 * 未保存的编辑与最新同步事件合并，保存时不会抹掉其他标签页刚同步的计时记录。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, createIdbFactory, waitFor, click, type, domainScripts } = require('../helpers/dom')

const QL_SCRIPTS = domainScripts('MAERS-QuantiLife')

async function open(htmlRel, factory, options = {}) {
  const page = createPage(htmlRel, { indexedDB: factory, ...options })
  await page.ready()
  return page
}

/** Schedule 页（附带 QL 领域层，等价于双系统同页，桥接层才能解析标签库） */
const openSchedule = (factory) => open('MAERS-Schedule/index.html', factory, { extraScripts: QL_SCRIPTS })

/** 今天 09:00–10:00 完成一个带标签的计时任务，返回其日期键 */
function completeTodayTask(schedule, title = '深度学习', tags = ['阅读']) {
  const start = new schedule.window.Date()
  start.setHours(9, 0, 0, 0)
  const task = schedule.MS.startInProgressTask({ title, category: 'learn', tags, now: start.getTime() })
  schedule.MS.finishInProgressTask(task.id, start.getTime() + 3600 * 1000)
  return task.date
}

const syncedEvents = (ql) => ql.QL.timeDetail.getEvents().filter(ev => ev._isSync)

test('Schedule 结束计时后，已打开的 QuantiLife 记录页自动出现同步事件', async () => {
  const factory = createIdbFactory()
  const ql = await open('MAERS-QuantiLife/index.html', factory)
  const schedule = await openSchedule(factory)
  assert.equal(syncedEvents(ql).length, 0)

  completeTodayTask(schedule)
  await waitFor(() => syncedEvents(ql).length === 1)
  assert.equal(syncedEvents(ql)[0].name, '深度学习')
})

test('未保存的编辑与最新同步事件合并：保存后既保留本页输入，也保留其他标签页同步的计时记录', async () => {
  const factory = createIdbFactory()
  const ql = await open('MAERS-QuantiLife/index.html', factory)
  const schedule = await openSchedule(factory)

  // 用户正在输入步数（自动保存尚未触发）
  const steps = ql.document.querySelector('#input-steps')
  type(steps, '8000')

  const dateKey = completeTodayTask(schedule)
  await waitFor(() => syncedEvents(ql).length === 1)
  assert.equal(steps.value, '8000', '收到外部变更时不得覆盖用户正在输入的内容')

  click(ql.document.querySelector('#save-btn'))
  await ql.QLS.store.flush()
  const saved = ql.QL.loadDayData(dateKey)
  assert.equal(saved.basics.steps, 8000)
  assert.equal(saved.timeEvents.filter(ev => ev._isSync).length, 1, '保存不得抹掉其他标签页同步的计时记录')
  assert.ok(saved.time.learn > 0, '分类时长应包含同步事件')
})

test('陈旧页面状态不会抹掉同步事件：页面尚未收到通知时保存，仍以存储中最新同步事件为准', async () => {
  const factory = createIdbFactory()
  const ql = await open('MAERS-QuantiLife/index.html', factory)
  const schedule = await openSchedule(factory)

  completeTodayTask(schedule)
  await schedule.QLS.store.flush()
  await waitFor(() => ql.QL.loadDayData(ql.QLS.today())?.timeEvents.length === 1)

  // 模拟本页尚未刷新界面（内存中的事件仍为空）：直接保存
  ql.QL.timeDetail.clear()
  type(ql.document.querySelector('#mood-note'), '今天不错')
  click(ql.document.querySelector('#save-btn'))
  await ql.QLS.store.flush()

  const saved = ql.QL.loadDayData(ql.QLS.today())
  assert.equal(saved.moodNote, '今天不错')
  assert.equal(saved.timeEvents.filter(ev => ev._isSync).length, 1)
})

test('其他标签页保存空白表单后，记录页自动清空对应内容', async () => {
  const factory = createIdbFactory()
  const ql = await open('MAERS-QuantiLife/index.html', factory)
  const other = await open('MAERS-QuantiLife/index.html', factory)

  type(other.document.querySelector('#input-steps'), '5000')
  click(other.document.querySelector('#save-btn'))
  await other.QLS.store.flush()
  await waitFor(() => ql.document.querySelector('#input-steps').value === '5000')

  type(other.document.querySelector('#input-steps'), '')
  click(other.document.querySelector('#save-btn'))
  await other.QLS.store.flush()
  await waitFor(() => ql.document.querySelector('#input-steps').value === '')
})

test('报告页：其他标签页写入当日记录后自动重绘', async () => {
  const factory = createIdbFactory()
  const report = await open('MAERS-QuantiLife/report.html', factory)
  assert.ok(report.document.querySelector('#report-content .empty-state'), '无数据时展示空状态')

  const ql = await open('MAERS-QuantiLife/index.html', factory)
  type(ql.document.querySelector('#input-steps'), '6000')
  click(ql.document.querySelector('#save-btn'))
  await ql.QLS.store.flush()

  await waitFor(() => !report.document.querySelector('#report-content .empty-state'))
})

test('Schedule：其他标签页新增任务后当前视图自动刷新', async () => {
  const factory = createIdbFactory()
  const viewer = await open('MAERS-Schedule/index.html', factory)
  const editor = await open('MAERS-Schedule/index.html', factory)
  click(viewer.document.querySelector('.view-tab[data-view="timeline"]'))

  editor.MS.saveTaskOrGoal({ title: '跨标签页新任务', tier: 'short', quadrant: 'do' })
  await editor.QLS.store.flush()
  await waitFor(() => viewer.document.querySelector('#view-timeline').textContent.includes('跨标签页新任务'))
})

test('Schedule：弹窗编辑期间延后刷新，弹窗关闭后补刷新', async () => {
  const factory = createIdbFactory()
  const viewer = await open('MAERS-Schedule/index.html', factory)
  const editor = await open('MAERS-Schedule/index.html', factory)
  click(viewer.document.querySelector('.view-tab[data-view="timeline"]'))

  const dialog = viewer.document.querySelector('#task-modal')
  viewer.MS.openModal(null, 'short')
  assert.ok(dialog.open || dialog.hasAttribute('open'), '任务弹窗应处于打开状态')

  editor.MS.saveTaskOrGoal({ title: '延后出现的任务', tier: 'short', quadrant: 'do' })
  await editor.QLS.store.flush()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.equal(viewer.document.querySelector('#view-timeline').textContent.includes('延后出现的任务'), false, '弹窗打开期间不应刷新视图')

  viewer.MS.closeDialog(dialog)
  await waitFor(() => viewer.document.querySelector('#view-timeline').textContent.includes('延后出现的任务'))
})

test('QuantiLife 标签库：其他标签页新增标签后本页内存标签库同步', async () => {
  const factory = createIdbFactory()
  const a = await open('MAERS-QuantiLife/index.html', factory)
  const b = await open('MAERS-QuantiLife/index.html', factory)

  b.QL.saveTag('跨页标签', 'career')
  await b.QLS.store.flush()
  await waitFor(() => a.QL.TAG_META['跨页标签'] === 'career')
})
