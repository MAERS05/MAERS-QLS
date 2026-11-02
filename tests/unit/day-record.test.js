/**
 * 单日记录契约与桥接界面测试 (tests/unit/day-record.test.js)
 * 验证 common/js/day-record.js 的归一化、空记录判定、分类时长汇总与保存，
 * 以及拆分后的 bridge-ui.js 通过事件与数据层协作。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, click, plain, domainScripts } = require('../helpers/dom')

const QL_SCRIPTS = domainScripts('MAERS-QuantiLife')

test('单日记录归一化：补全结构、丢弃非法字段、保留未知字段并修正日期', () => {
  const { QLS } = createPage('index.html')
  assert.equal(QLS.normalizeDayData(null), null)
  assert.equal(QLS.normalizeDayData([]), null)

  const norm = QLS.normalizeDayData({
    date: '2026-2-3',
    basics: { steps: '1200', sleep: -5, water: 'abc' },
    diet: [{ name: '早餐', carb: '30' }, null, 'bad'],
    time: { basic: 2, unknown: 9, health: -1 },
    timeEvents: [{ name: '', h: -2, tags: [' 阅读 ', '', null], segments: [{ startHm: '09:00', endHm: '10:00' }, 'x'] }, 3],
    mood: 'nonexistent',
    moodNote: 7,
    extra: 'keep',
  })
  assert.equal(norm.date, '2026-02-03')
  assert.deepEqual(plain(norm.basics), { steps: 1200, sleep: 0, water: 0 })
  assert.equal(norm.diet.length, 1)
  assert.equal(norm.diet[0].carb, 30)
  assert.deepEqual(plain(norm.time), { basic: 2, health: 0 })
  assert.equal(norm.timeEvents.length, 1)
  assert.deepEqual([norm.timeEvents[0].name, norm.timeEvents[0].h], ['未命名', 0])
  assert.deepEqual(plain(norm.timeEvents[0].tags), ['阅读'])
  assert.deepEqual(plain(norm.timeEvents[0].segments), [{ startHm: '09:00', endHm: '10:00' }])
  assert.equal(norm.mood, null)
  assert.equal(norm.moodNote, '')
  assert.equal(norm.extra, 'keep')

  assert.equal(QLS.normalizeDayData({ date: '坏日期' }, '2026-10-01').date, '2026-10-01', '使用回退日期')
  assert.equal(QLS.normalizeDayData({ date: '坏日期' }).date, '')
})

test('空记录判定：任一有效内容均视为非空', () => {
  const { QLS } = createPage('index.html')
  const empty = QLS.createEmptyDay('2026-10-15')
  assert.equal(QLS.isDayDataEmpty(empty), true)
  assert.equal(QLS.isDayDataEmpty(null), true)
  assert.equal(QLS.isDayDataEmpty({ ...empty, basics: { steps: 1, sleep: 0, water: 0 } }), false)
  assert.equal(QLS.isDayDataEmpty({ ...empty, diet: [{ name: '  ' }] }), true, '空白饮食名不算内容')
  assert.equal(QLS.isDayDataEmpty({ ...empty, diet: [{ name: '午餐' }] }), false)
  assert.equal(QLS.isDayDataEmpty({ ...empty, timeEvents: [{ name: 'a', h: 1, tags: [] }] }), false)
  assert.equal(QLS.isDayDataEmpty({ ...empty, time: { basic: 0.5 } }), false)
  assert.equal(QLS.isDayDataEmpty({ ...empty, mood: 'good' }), false)
  assert.equal(QLS.isDayDataEmpty({ ...empty, moodNote: '  ' }), true)
  assert.equal(QLS.isDayDataEmpty({ ...empty, moodNote: '好' }), false)
})

test('分类时长汇总：同类标签只计一次、跨类各计一次，可按小数位逐步舍入', () => {
  const { QLS } = createPage('index.html')
  const tagMap = { 编程: 'career', 阅读: 'learn', 写作: 'career' }
  const events = [
    { h: 1, tags: ['编程', '写作'] },
    { h: 0.5, tags: ['编程', '阅读'] },
    { h: -3, tags: ['阅读'] },
    { h: 'x', tags: ['阅读'] },
    { h: 1, tags: ['未知标签'] },
  ]
  const totals = QLS.computeTimeTotals(events, tagMap)
  assert.equal(totals.career, 1.5, '同事件内的同类标签只计一次')
  assert.equal(totals.learn, 0.5)
  assert.equal(totals.waste, 0)
  assert.deepEqual(plain(Object.keys(totals)), plain(QLS.TIME_KEYS))

  const rounded = QLS.computeTimeTotals([{ h: 0.3333, tags: ['编程'] }, { h: 0.3333, tags: ['编程'] }], tagMap, { decimals: 2 })
  // 逐步舍入口径：0.3333 → 0.33，再累加 0.3333 → 0.66（与桥接层历史行为一致）
  assert.equal(rounded.career, 0.66)
  assert.deepEqual(plain(QLS.computeTimeTotals(undefined)), Object.fromEntries(QLS.TIME_KEYS.map(k => [k, 0])))
})

test('保存单日记录：非空写入、空记录删除键、非法数据拒绝', () => {
  const { QLS } = createPage('index.html')
  const key = `${QLS.QL_PREFIX}2026-10-15`

  assert.equal(QLS.saveDayRecord({ date: '2026-10-15', basics: { steps: 100 } }), true)
  assert.equal(QLS.store.get(key).basics.steps, 100)

  assert.equal(QLS.saveDayRecord(QLS.createEmptyDay('2026-10-15')), true)
  assert.equal(QLS.store.has(key), false, '空记录应删除对应键')

  assert.equal(QLS.saveDayRecord(null), false)
  assert.equal(QLS.saveDayRecord({ date: '坏日期', basics: { steps: 1 } }), false)
})

test('桥接界面：独立于数据层，经事件刷新摘要并支持查看标记', () => {
  const { MS, document, window } = createPage('MAERS-Schedule/index.html', { extraScripts: QL_SCRIPTS })
  const btn = document.getElementById('ql-record-btn')
  assert.ok(btn, '存储就绪后应在顶栏注入「今日记录」按钮')
  assert.equal(btn.classList.contains('has-data'), false)
  assert.match(document.getElementById('ql-bridge-items').textContent, /暂无记录/)

  const start = new window.Date()
  start.setHours(9, 0, 0, 0)
  const task = MS.startInProgressTask({ title: '读书', category: 'learn', tags: ['阅读'], now: start.getTime() })
  MS.finishInProgressTask(task.id, start.getTime() + 1800 * 1000)

  assert.equal(btn.classList.contains('has-data'), true, '数据层同步后经事件刷新红点')
  assert.equal(btn.classList.contains('viewed'), false)

  click(btn)
  assert.ok(document.getElementById('ql-record-panel').hasAttribute('open'))
  assert.match(document.getElementById('ql-bridge-items').textContent, /阅读/)
  assert.match(document.getElementById('ql-bridge-items').textContent, /30m/)
  assert.equal(btn.classList.contains('viewed'), true, '打开面板后标记为已查看')

  click(document.getElementById('ql-record-close'))
  assert.equal(document.getElementById('ql-record-panel').hasAttribute('open'), false)
})

test('桥接数据层不依赖界面：缺少 bridge-ui 的页面仍可正常同步', () => {
  const { MS, QL, window, document } = createPage('MAERS-QuantiLife/index.html', { extraScripts: domainScripts('MAERS-Schedule') })
  assert.equal(document.getElementById('ql-record-btn'), null)
  assert.equal(window.MAERS_BRIDGE_UI, undefined)

  const start = new window.Date()
  start.setHours(9, 0, 0, 0)
  const task = MS.startInProgressTask({ title: '写作', category: 'career', tags: ['写作'], now: start.getTime() })
  QL.saveTag('写作', 'career')
  MS.finishInProgressTask(task.id, start.getTime() + 3600 * 1000)
  assert.equal(QL.loadDayData(task.date).timeEvents.length, 1)
})
