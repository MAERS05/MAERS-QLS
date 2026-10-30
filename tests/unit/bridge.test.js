/**
 * 跨系统桥接层测试 (tests/unit/bridge.test.js)
 * 场景：Schedule 与 QuantiLife 同页加载（与根门户一致），验证计时任务到量化记录的同步语义。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, plain, domainScripts } = require('../helpers/dom')

const QL_SCRIPTS = domainScripts('MAERS-QuantiLife')

/** Schedule 页面 + QL 领域层，等价于双系统同页 */
const setup = () => createPage('MAERS-Schedule/index.html', { extraScripts: QL_SCRIPTS })

const at = (window, ...args) => new window.Date(...args).getTime()

test('并行计时：重叠段合并为并行事项，早结束与晚结束的差值计为单独事项', () => {
  const { MS, QL, window } = setup()
  const start = at(window, 2026, 9, 15, 9, 0, 0)
  const early = at(window, 2026, 9, 15, 9, 45, 0)
  const late  = at(window, 2026, 9, 15, 10, 0, 0)

  const a = MS.startInProgressTask({ title: '早高峰通勤', category: 'basic', tags: ['通勤'], now: start })
  const b = MS.startInProgressTask({ title: '听英语播客', category: 'learn', tags: ['听播客'], now: start + 1 })
  MS.finishInProgressTask(b.id, early)
  MS.finishInProgressTask(a.id, late)

  const day = QL.loadDayData(a.date)
  assert.equal(day.timeEvents.length, 2, '应切分为 1 条并行事件 + 1 条差值事件')

  const fused = day.timeEvents.find(e => e._isParallel)
  const pure  = day.timeEvents.find(e => !e._isParallel)
  assert.equal(fused.h, 0.75)
  assert.deepEqual(plain(fused.tags), ['通勤', '听播客'])
  assert.deepEqual([fused.segments[0].startHm, fused.segments[0].endHm], ['09:00', '09:45'])
  assert.equal(pure.h, 0.25)
  assert.deepEqual(plain(pure.tags), ['通勤'])
  assert.deepEqual([pure.segments[0].startHm, pure.segments[0].endHm], ['09:45', '10:00'])

  const totals = QL.computeTimeCategoryTotals(day.timeEvents)
  assert.deepEqual([totals.basic.fused, totals.basic.pure], [0.75, 0.25])
  assert.deepEqual([totals.learn.fused, totals.learn.pure], [0.75, 0])
})

test('跨午夜任务按自然日拆分，删除后两天记录同步清理', () => {
  const { MS, QL, window } = setup()
  const task = MS.startInProgressTask({ title: '深夜复盘', category: 'learn', tags: ['阅读'], now: at(window, 2026, 9, 15, 23, 30, 0) })
  MS.finishInProgressTask(task.id, at(window, 2026, 9, 16, 0, 30, 0))

  const day1 = QL.loadDayData('2026-10-15')
  const day2 = QL.loadDayData('2026-10-16')
  assert.ok(day1 && day2, '必须同时写入当日与次日')
  assert.deepEqual([day1.timeEvents[0].h, day1.timeEvents[0].segments[0].startHm, day1.timeEvents[0].segments[0].endHm], [0.5, '23:30', '24:00'])
  assert.deepEqual([day2.timeEvents[0].h, day2.timeEvents[0].segments[0].startHm, day2.timeEvents[0].segments[0].endHm], [0.5, '00:00', '00:30'])

  MS.deleteInProgressTask(task.id)
  assert.equal(QL.loadDayData('2026-10-15'), null)
  assert.equal(QL.loadDayData('2026-10-16'), null)
})

test('生命周期：创建 → 暂停 → 继续 → 结束 → 二次调整 → 删除', () => {
  const { MS, QL, window } = setup()
  const t = (h, m) => at(window, 2026, 9, 15, h, m, 0)

  const task = MS.startInProgressTask({ title: '架构重构', category: 'career', tags: ['编程'], now: t(9, 0) })
  MS.pauseInProgressTask(task.id, t(10, 0))
  MS.resumeInProgressTask(task.id, t(10, 30))
  const finished = MS.finishInProgressTask(task.id, t(11, 15))
  assert.equal(finished.finalHours, 1.75, '暂停期间不计入总时长')

  const settled = MS.settleInProgressTask(task.id, {
    title: '架构重构',
    tags: ['编程'],
    segments: [{ startHm: '09:00', endHm: '11:30', manualEdited: true }],
    finalHours: 2.5,
  })
  assert.equal(settled.finalHours, 2.5)
  assert.equal(QL.loadDayData(finished.date).time.career, 2.5, '二次调整必须回写量化记录')

  MS.deleteInProgressTask(task.id)
  assert.equal(MS.loadInProgressTasks().length, 0)
  assert.equal(QL.loadDayData(finished.date), null)
})

test('无标签任务仅本地计时：不污染标签库，结束后不写入量化记录', () => {
  const { MS, QL, MAERS_BRIDGE, window } = setup()
  const task = MS.startInProgressTask({ title: '临时本地计时事项', category: 'basic', tags: [], now: at(window, 2026, 9, 15, 8, 0, 0) })
  assert.deepEqual(plain(task.tags), [], '留空标签时不得用任务名兜底')
  assert.equal(MAERS_BRIDGE.getQLTags()['临时本地计时事项'], undefined)

  const done = MS.finishInProgressTask(task.id, at(window, 2026, 9, 15, 9, 0, 0))
  assert.equal(done.status, 'completed')
  assert.equal(QL.loadDayData(done.date), null)
})

test('期望列同步：清空规划期望后必须同步清零量化期望', () => {
  const { MS, QL, MAERS_BRIDGE } = setup()
  MS.saveBlock('ideal', { id: 'b_ideal', label: '期望学习', startH: 8, durationH: 3.5, category: 'learn' })
  const exp = QL.loadExpectations()
  assert.equal(MAERS_BRIDGE.syncIdealToQLExpectations(exp), true)
  assert.equal(exp.time.learn.hours, 3.5)

  MS.deleteBlock('ideal', 'b_ideal')
  assert.equal(MAERS_BRIDGE.syncIdealToQLExpectations(exp), true, '清空后再次同步仍应返回 true')
  assert.equal(exp.time.learn.hours, 0)
  assert.equal(exp.time.learn.items.length, 0)
})

test('脏数据容错：非法计时段被剔除，合法任务不受影响', () => {
  const { MS, localStorage } = setup()
  localStorage.setItem('schedule_inprogress', JSON.stringify([
    { id: 'bad', title: '坏段任务', category: 'basic', status: 'paused', segments: [{ startAt: 20, endAt: 10 }] },
    { id: 'good', title: '正常任务', category: 'basic', status: 'paused', segments: [{ startHm: '09:00', endHm: '10:00', manualEdited: true }] },
  ]))
  const tasks = MS.loadInProgressTasks()
  assert.equal(tasks.find(x => x.id === 'bad').segments.length, 0, '结束早于开始的计时段应被剔除')
  assert.equal(MS.calcSegmentsTotalHours(tasks.find(x => x.id === 'good').segments), 1)
})
