/**
 * QuantiLife 集成测试 (tests/integration/quantilife.test.js)
 * 以真实记录页 HTML 与脚本验证：饮食/心情保存、标签库与明细、排行面板、期望设定。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, click, type, plain, domainScripts } = require('../helpers/dom')

/** 记录页 + Schedule 领域层（同页用于生成联动数据） */
const setup = (options = {}) => createPage('MAERS-QuantiLife/index.html', {
  extraScripts: domainScripts('MAERS-Schedule'),
  ...options,
})

/** 返回「今天」某时刻的毫秒时间戳（使用页面窗口内的 Date） */
const todayAt = (window, h, m = 0) => {
  const d = new window.Date()
  return new window.Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m, 0).getTime()
}

/** 创建一组当日并行计时数据并载入记录页 */
function seedParallelDay({ MS, QL, window }) {
  const a = MS.startInProgressTask({ title: '任务一', category: 'learn', tags: ['阅读'], now: todayAt(window, 14, 0) })
  const b = MS.startInProgressTask({ title: '任务二', category: 'career', tags: ['编程'], now: todayAt(window, 14, 0) + 1 })
  MS.finishInProgressTask(b.id, todayAt(window, 14, 30))
  const done = MS.finishInProgressTask(a.id, todayAt(window, 15, 0))
  QL.timeDetail.setEventsFromDayData(QL.loadDayData(done.date))
  return done.date
}

test('饮食记录：新增行、宏量变化自动计算热量并更新汇总', () => {
  const { document } = setup()
  assert.equal(document.querySelectorAll('#food-list .food-item').length, 1, '启动时应保证至少一行')

  const row = document.querySelector('#food-list .food-item')
  type(row.querySelector('[data-field="carb"]'), '50')
  type(row.querySelector('[data-field="protein"]'), '20')
  type(row.querySelector('[data-field="fat"]'), '10')
  assert.equal(row.querySelector('[data-field="cal"]').value, String(50 * 4 + 20 * 4 + 10 * 9), '热量 = 碳水×4 + 蛋白×4 + 脂肪×9')
  assert.equal(document.getElementById('sum-carb').textContent, '50.0')
  assert.equal(document.getElementById('sum-cal').textContent, '370')

  click(document.getElementById('add-food-btn'))
  assert.equal(document.querySelectorAll('#food-list .food-item').length, 2)
  click(document.querySelector('#food-list .food-item [data-remove]'))
  assert.equal(document.querySelectorAll('#food-list .food-item').length, 1)
})

test('保存与日期切换：手动保存持久化，切换日期自动保存并载入目标日', () => {
  const { QL, document } = setup()
  type(document.getElementById('input-steps'), '8000')
  click(document.querySelector('#mood-selector .mood-btn[data-mood="great"]'))
  assert.equal(document.querySelector('.mood-btn[data-mood="great"]').getAttribute('aria-checked'), 'true')

  click(document.getElementById('save-btn'))
  const today = QL.today()
  const saved = QL.loadDayData(today)
  assert.equal(saved.basics.steps, 8000)
  assert.equal(saved.mood, 'great')

  click(document.getElementById('prev-day'))
  assert.equal(document.getElementById('input-steps').value, '', '昨天无记录，输入框应清空')
  click(document.getElementById('next-day'))
  assert.equal(document.getElementById('input-steps').value, '8000', '切回今天应载入已保存数据')
})

test('空白表单保存：移除空记录', () => {
  const { QL, document } = setup()
  type(document.getElementById('input-water'), '1500')
  click(document.getElementById('save-btn'))
  assert.ok(QL.loadDayData(QL.today()))

  type(document.getElementById('input-water'), '')
  click(document.getElementById('save-btn'))
  assert.equal(QL.loadDayData(QL.today()), null)
  assert.equal(document.getElementById('input-water').value, '')
})

test('标签库面板：明细只读展示并行事项，标签可新增、折叠展开与删除', () => {
  const page = setup()
  const { QL, document } = page
  seedParallelDay(page)

  QL.timeDetail.openTagManage()
  const dlg = document.getElementById('time-detail-overlay')
  assert.equal(dlg.open, true)
  assert.equal(document.getElementById('td-add-form').hidden, false, '标签视图应显示')
  assert.equal(document.getElementById('td-list-view').hidden, true, '排行视图应隐藏')

  const list = document.getElementById('td-record-details-list')
  assert.ok(list.textContent.includes('任务一') && list.textContent.includes('任务二'), '明细应展示当日记录')
  assert.equal(list.querySelector('[data-del-idx], .record-item-del'), null, '明细为只读，不得出现删除入口')

  // 新增标签
  type(document.getElementById('new-tag-learn'), '算法刷题')
  click(document.querySelector('[data-add-cat="learn"]'))
  assert.equal(QL.TAG_META['算法刷题'], 'learn')
  assert.equal(document.querySelector('#tag-cat-body-learn').classList.contains('open'), true, '新增后该分类保持展开')

  // 折叠/展开：aria-expanded 与 .open 同步
  const header = document.querySelector('.tag-cat-header[data-cat="career"]')
  assert.equal(header.getAttribute('aria-expanded'), 'false')
  click(header)
  assert.equal(header.getAttribute('aria-expanded'), 'true')
  assert.equal(document.getElementById('tag-cat-body-career').classList.contains('open'), true)
  click(header)
  assert.equal(document.getElementById('tag-cat-body-career').classList.contains('open'), false)

  // 删除标签（confirm 已被 polyfill 为 true）
  click(document.querySelector('[data-del-tag="算法刷题"]'))
  assert.equal(QL.TAG_META['算法刷题'], undefined)

  // 记录明细折叠按钮
  const toggle = document.getElementById('td-toggle-details-btn')
  click(toggle)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')
  assert.equal(list.classList.contains('open'), true)

  click(document.getElementById('td-back'))
  assert.equal(dlg.open, false, '返回按钮应关闭面板')
})

test('时间排行面板：总览默认包含并行并渲染大类条，支持下钻标签与仅并行组合视图', () => {
  const page = setup()
  const { document, window } = page
  seedParallelDay(page)

  click(document.getElementById('td-overview-btn'))
  const dlg = document.getElementById('time-detail-overlay')
  assert.equal(dlg.open, true)
  assert.equal(document.getElementById('td-overlay-title').textContent, '总览')
  assert.equal(document.querySelector('input[name="tdMode"]:checked').value, 'include', '默认选中包含并行')
  assert.ok(document.querySelectorAll('#td-bars .td-bar-item.td-bar-clickable').length > 0, '总览应渲染可下钻的大类排行条')
  assert.equal(document.querySelectorAll('#td-bars .bar-text-inner').length, 0, '条形图内部不显示时长文字')
  assert.equal(document.getElementById('td-empty').hidden, true)
  assert.equal(document.getElementById('td-add-form').hidden, true, '排行视图应隐藏标签视图')

  // 点击大类下钻到标签排行（内部不重复渲染返回按钮），点击顶部返回回到总览
  click(document.querySelector('#td-bars .td-bar-clickable[data-cat="learn"]'))
  assert.match(document.getElementById('td-overlay-title').textContent, /学习内养类/)
  assert.equal(document.querySelector('#td-bars .rank-back-btn'), null, '全屏面板内部不重复渲染返回按钮')
  assert.ok(document.getElementById('td-bars').textContent.includes('阅读'))

  click(document.getElementById('td-back'))
  assert.equal(dlg.open, true, '从总览下钻后点顶部返回应回到总览而非直接关闭')
  assert.equal(document.getElementById('td-overlay-title').textContent, '总览')

  // 切换到仅并行模式，显示大类并行时间排行并支持继续下钻到标签并行时间排行
  const only = document.querySelector('input[name="tdMode"][value="only"]')
  only.checked = true
  only.dispatchEvent(new window.Event('change', { bubbles: true }))
  const comboRow = document.querySelector('#td-bars .td-combo-item[data-action="drill-parallel-combo"]')
  assert.ok(comboRow, '仅并行模式顶层应展示可点击的大类并行组合')
  click(comboRow)
  assert.equal(document.querySelector('#td-bars .rank-back-btn'), null, '并行标签详情内部同样不渲染返回按钮')
  assert.ok(document.getElementById('td-bars').textContent.includes('阅读'))
  assert.ok(document.getElementById('td-bars').textContent.includes('编程'))

  click(document.getElementById('td-back'))
  assert.equal(dlg.open, true, '从并行标签详情点顶部返回应回到大类并行时间排行')
  click(document.getElementById('td-back'))
  assert.equal(dlg.open, false, '回到入口层级后再点顶部返回应关闭面板')
  const summaries = [...document.querySelectorAll('[id^="slot-summary-"]')].map(el => el.textContent.trim())
  assert.ok(summaries.some(text => text !== '—'), '摘要应反映已记录的时长')
})

test('分类卡片：点击分类卡片打开该分类的明细面板', () => {
  const page = setup()
  const { document } = page
  seedParallelDay(page)

  click(document.querySelector('.time-slot[data-key="learn"]'))
  assert.equal(document.getElementById('time-detail-overlay').open, true)
  assert.match(document.getElementById('td-overlay-title').textContent, /学习内养类/)
  assert.ok(document.getElementById('td-bars').textContent.includes('阅读'))
})

test('期望面板：编辑后保存才持久化，取消放弃修改，分类可折叠展开', () => {
  const { QL, document } = setup()
  const dlg = document.getElementById('exp-overlay')

  click(document.getElementById('exp-open-btn'))
  assert.equal(dlg.open, true)

  type(document.getElementById('exp-steps'), '10000')
  click(document.getElementById('exp-cancel'))
  assert.equal(dlg.open, false)
  assert.equal(QL.loadExpectations().steps, 0, '取消不得持久化')

  click(document.getElementById('exp-open-btn'))
  type(document.getElementById('exp-steps'), '12000')
  type(document.getElementById('exp-sleep'), '7.5')

  const cat = dlg.querySelector('.exp-time-cat[data-tk="learn"]')
  const toggle = cat.querySelector('.exp-cat-toggle')
  assert.equal(cat.classList.contains('collapsed'), true)
  click(toggle)
  assert.equal(cat.classList.contains('collapsed'), false)
  assert.equal(toggle.getAttribute('aria-expanded'), 'true')

  click(dlg.querySelector('[data-action="add-food"]'))
  assert.equal(dlg.querySelectorAll('.exp-food-row').length, QL.loadExpectations().diet.length + 1, '新增行仅修改草稿')
  assert.equal(dlg.querySelector('.exp-time-cat[data-tk="learn"]').classList.contains('collapsed'), false, '重绘后保留展开状态')

  click(document.getElementById('exp-save'))
  assert.equal(dlg.open, false)
  const exp = QL.loadExpectations()
  assert.equal(exp.steps, 12000)
  assert.equal(exp.sleep, 7.5)
})

test('期望面板：同步规划期望列', () => {
  const { MS, QL, document } = setup()
  MS.saveBlock('ideal', { id: 'b1', label: '期望学习', startH: 8, durationH: 3, category: 'learn' })

  click(document.getElementById('exp-open-btn'))
  const sync = document.querySelector('[data-action="sync"]')
  assert.ok(sync, '存在桥接层时应显示同步按钮')
  click(sync)
  click(document.getElementById('exp-save'))
  assert.equal(QL.loadExpectations().time.learn.hours, 3)
})

test('备份：导出信封可被再次导入', async () => {
  const { QL } = setup()
  QL.saveTag('编程', 'career')
  QL.saveDayData({ date: '2026-10-14', basics: { steps: 5000, sleep: 7, water: 1500 }, diet: [], timeEvents: [], mood: 'good' })

  const { data } = QL.exportBackup()
  assert.ok(data.app === 'MAERS-QLS' || data.data, '导出应携带备份信封')

  const imported = createPage('MAERS-QuantiLife/report.html')
  const count = await imported.QL.importBackup(plain(data))
  assert.ok(count >= 1)
  assert.equal(imported.QL.loadDayData('2026-10-14').basics.steps, 5000)
  assert.equal(imported.QL.TAG_META['编程'], 'career')
})

test('备份导入：存储写入失败时完整回滚且不污染内存标签库', async () => {
  const { QL, QLS, localStorage } = setup()
  QL.saveTag('旧标签', 'learn')
  QL.saveDayData({ date: '2026-10-14', basics: { steps: 1000, sleep: 0, water: 0 }, diet: [], timeEvents: [], mood: null })

  const proto = Object.getPrototypeOf(localStorage)
  const originalSetItem = proto.setItem
  const originalError = console.error
  console.error = () => {}
  try {
    Object.defineProperty(proto, 'setItem', {
      configurable: true,
      value(key, value) {
        if (key === 'quantilife_2026-10-15') {
          // 模拟浏览器在配额耗尽边缘的异常写入，验证当前失败项同样回滚。
          originalSetItem.call(this, key, value)
          throw new Error('quota exceeded')
        }
        return originalSetItem.call(this, key, value)
      },
    })
    const count = await QL.importBackup(QLS.createBackup({
      quantilife_tags: { 新标签: 'career' },
      'quantilife_2026-10-15': { date: '2026-10-15', basics: { steps: 9000, sleep: 0, water: 0 }, diet: [], timeEvents: [], mood: null },
    }))
    assert.equal(count, 0)
    assert.equal(QL.loadTags()['旧标签'], 'learn')
    assert.equal(QL.loadTags()['新标签'], undefined)
    assert.equal(QL.loadDayData('2026-10-14').basics.steps, 1000)
    assert.equal(QL.loadDayData('2026-10-15'), null)
    assert.equal(QL.TAG_META['旧标签'], 'learn', '失败时不得更新内存标签库')
    assert.equal(QL.TAG_META['新标签'], undefined)
  } finally {
    Object.defineProperty(proto, 'setItem', { configurable: true, value: originalSetItem })
    console.error = originalError
  }
})

test('备份导入：预估空间不足时不写入，原数据保持不变', async () => {
  const { QL, QLS } = setup()
  QL.saveTag('旧标签', 'learn')
  const originalBudget = QLS.LOCAL_STORAGE_BUDGET_BYTES
  const originalEstimate = QLS.localStoreBackend.estimateUsage
  let estimated = false
  try {
    // 将预算压至当前已用量，任何新增导入都会在写入前被拒绝。
    QLS.localStoreBackend.estimateUsage = () => {
      estimated = true
      return originalEstimate()
    }
    QLS.LOCAL_STORAGE_BUDGET_BYTES = originalEstimate()
    const count = await QL.importBackup(QLS.createBackup({
      quantilife_tags: { 新标签: 'career' },
      'quantilife_2026-10-15': { date: '2026-10-15', basics: { steps: 9000, sleep: 0, water: 0 }, diet: [], timeEvents: [], mood: null },
    }))
    assert.equal(count, 0)
    assert.equal(estimated, true, '导入前必须估算当前存储用量')
    assert.equal(QL.loadTags()['旧标签'], 'learn')
    assert.equal(QL.loadTags()['新标签'], undefined)
    assert.equal(QL.loadDayData('2026-10-15'), null)
  } finally {
    QLS.LOCAL_STORAGE_BUDGET_BYTES = originalBudget
    QLS.localStoreBackend.estimateUsage = originalEstimate
  }
})

test('备份解析：prepareImportEntries 仅校验归一化，不产生任何写入且忽略非法条目', () => {
  const { QL, QLS, localStorage } = setup()
  const before = localStorage.length
  const { entries, pendingTags } = QL.prepareImportEntries(QLS.createBackup({
    quantilife_tags: { 新标签: 'career' },
    quantilife_entry_page: 'report',
    'quantilife_2026-10-15': { date: '2026-10-15', basics: { steps: 9000, sleep: 0, water: 0 }, diet: [], timeEvents: [], mood: null },
    quantilife_not_a_date: { foo: 1 },
    other_app_key: 'x',
  }))

  assert.equal(localStorage.length, before, '解析阶段不得写入存储')
  assert.equal(pendingTags['新标签'], 'career')
  const keys = entries.map(e => e.key)
  assert.ok(keys.includes('quantilife_2026-10-15'))
  assert.ok(keys.includes(QLS.TAGS_KEY))
  assert.ok(!keys.includes('other_app_key'))
  assert.ok(!keys.includes('quantilife_not_a_date'))

  assert.deepEqual(plain(QL.prepareImportEntries(null)), { entries: [], pendingTags: null })
})

test('主页：展示上次导出备份天数，导出后即时更新', () => {
  const p1 = createPage('index.html')
  assert.equal(p1.document.getElementById('backup-status').textContent, '上次导出备份: 从未')

  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString()
  const p2 = createPage('index.html', { storage: { qls_last_exported_at: threeDaysAgo } })
  assert.equal(p2.document.getElementById('backup-status').textContent, '上次导出备份: 3天前')

  click(p2.document.getElementById('qls-export-btn'))
  assert.equal(p2.document.getElementById('backup-status').textContent, '上次导出备份: 0天前')
})
