/**
 * Schedule 集成测试 (tests/integration/schedule.test.js)
 * 通过真实 HTML + 真实脚本 + 真实 DOM 事件验证页面交互，而非调用内部函数替身。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, click, type, plain, domainScripts } = require('../helpers/dom')

/** Schedule 页面 + QuantiLife 领域层（与双系统同页场景一致） */
const setup = (options = {}) => createPage('MAERS-Schedule/index.html', {
  extraScripts: domainScripts('MAERS-QuantiLife'),
  ...options,
})

test('视图标签：切换后 aria-selected 与 hidden 同步，方向键循环切换', () => {
  const { document, window } = setup()
  const tab = (name) => document.getElementById(`tab-${name}`)
  const view = (name) => document.getElementById(`view-${name}`)

  assert.equal(tab('timeblock').getAttribute('aria-selected'), 'true')
  assert.equal(view('timeblock').hidden, false)
  assert.equal(view('timeline').hidden, true)

  click(tab('timeline'))
  assert.equal(tab('timeline').getAttribute('aria-selected'), 'true')
  assert.equal(tab('timeblock').getAttribute('aria-selected'), 'false')
  assert.equal(view('timeline').hidden, false)
  assert.equal(view('timeblock').hidden, true)

  tab('timeline').parentElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
  assert.equal(tab('inprogress').getAttribute('aria-selected'), 'true', '方向键应切换到下一视图')
  assert.equal(view('inprogress').hidden, false)
})

test('进行中添加弹窗：标签与任务名称解耦，空名称拦截，保存后关闭并创建任务', () => {
  const { MS, QLS, document } = setup()
  MS.registerNewTag('通勤', 'basic')

  MS.openInProgressAdd()
  const dlg = document.getElementById('ip-add-modal')
  assert.equal(dlg.open, true, '弹窗应以模态方式打开')
  assert.notEqual(document.activeElement, document.getElementById('ip-task-title'), '打开弹窗不得自动聚焦输入框以避免调起虚拟键盘')

  const selectedCategory = dlg.querySelector('.tb-selected-category')
  assert.equal(selectedCategory.textContent, QLS.CATEGORY_COLORS[0].label, '默认应显示当前所选分类名称')
  click(dlg.querySelector('[data-category="health"]'))
  assert.equal(selectedCategory.textContent, QLS.CATEGORY_COLORS[1].label, '切换颜色后应同步显示对应分类名称')
  click(dlg.querySelector('[data-category="basic"]'))

  const chip = dlg.querySelector('#ip-tag-suggestions .tb-tag-chip[data-tag="通勤"]')
  assert.ok(chip, '默认分类下应渲染已登记标签的建议项')
  click(chip)
  assert.equal(document.getElementById('ip-task-tags').value, '通勤')
  assert.equal(document.getElementById('ip-task-title').value, '', '点选标签不得自动篡改任务名称')

  click(document.getElementById('ip-add-save'))
  assert.equal(MS.loadInProgressTasks().length, 0, '任务名称为空时不得创建任务')
  assert.equal(dlg.open, true, '校验失败时弹窗保持打开')

  type(document.getElementById('ip-task-title'), '阅读《编译原理》')
  click(document.getElementById('ip-add-save'))
  assert.equal(dlg.open, false, '保存后弹窗应关闭')

  const [task] = MS.loadInProgressTasks()
  assert.equal(task.title, '阅读《编译原理》')
  assert.deepEqual(plain(task.tags), ['通勤'])
})

test('进行中添加弹窗：搜索框创建新标签并追加到标签输入', () => {
  const { MS, document, MAERS_BRIDGE } = setup()
  MS.openInProgressAdd()

  type(document.getElementById('ip-tag-search'), '算法')
  click(document.getElementById('ip-tag-add-btn'))
  assert.equal(document.getElementById('ip-task-tags').value, '算法')
  assert.equal(MAERS_BRIDGE.getQLTags()['算法'], 'basic', '新标签应登记到当前选中分类')
  assert.equal(document.getElementById('ip-tag-search').value, '', '添加后清空搜索框')
})

test('进行中：可从历史入口查看过去日期的已结束任务并返回今天', () => {
  const { MS, QLS, document } = setup()
  const pastDate = QLS.dateKey(QLS.addDays(QLS.parseDateKey(QLS.today()), -1))
  const start = QLS.parseDateKey(pastDate).setHours(9, 0, 0, 0)
  const task = MS.startInProgressTask({ title: '昨日复盘', category: 'learn', tags: ['复盘'], now: start })
  MS.finishInProgressTask(task.id, start + 30 * 60 * 1000)
  MS.renderInProgress()

  assert.equal(document.querySelector('.ip-card-title')?.textContent, undefined, '默认视图不展示昨日已结束任务')
  click(document.getElementById('ip-history-toggle'))
  assert.match(document.getElementById('ip-section-title').textContent, /历史任务/)
  assert.equal(document.querySelector('.ip-card-title').textContent, '昨日复盘')
  assert.equal(document.getElementById('ip-open-add-btn'), null, '历史视图不显示新增卡片')

  click(document.getElementById('ip-history-back'))
  assert.ok(document.getElementById('ip-history-toggle'), '可返回默认的今日视图')
})

test('时间块弹窗：编辑块的起止时间正确回填，点击结束时间打开以结束时间为初值的滚轮', () => {
  const { MS, document } = setup()
  MS.saveBlock('2026-10-15', { id: 'tb_test', label: '深度工作', startH: 9, durationH: 2.5, category: 'career' })
  MS.openBlockModal({
    dateStr: '2026-10-15',
    block: { id: 'tb_test', label: '深度工作', startH: 9, durationH: 2.5, category: 'career' },
  })
  assert.equal(document.getElementById('tb-modal').open, true)
  assert.notEqual(document.activeElement, document.getElementById('tb-block-label'), '打开时间块弹窗不得自动聚焦输入框')
  assert.equal(document.getElementById('tb-block-start').value, '09:00')
  assert.equal(document.getElementById('tb-block-end').value, '11:30')
  assert.equal(document.getElementById('tb-block-delete').hidden, false, '编辑模式应显示删除按钮')
  const blockCategory = document.querySelector('#tb-block-colors .tb-selected-category')
  assert.equal(blockCategory.textContent, '事业发展', '时间块弹窗应显示当前颜色对应的分类名称')
  click(document.querySelector('#tb-block-colors [data-category="learn"]'))
  assert.equal(blockCategory.textContent, '学习内养', '切换时间块颜色后分类名称应同步更新')

  click(document.getElementById('tb-block-end'))
  const wheel = document.getElementById('qls-wheel-picker')
  assert.equal(wheel.open, true)
  assert.equal(document.getElementById('qls-wp-title').textContent, '结束时间')
  assert.equal(document.getElementById('qls-wp-h').getAttribute('aria-valuenow'), '11', '滚轮小时应为结束时间 11 而非开始时间 9')
  assert.equal(document.getElementById('qls-wp-m').getAttribute('aria-valuenow'), '30')

  click(wheel.querySelector('.wp-confirm'))
  assert.equal(wheel.open, false)
  assert.equal(document.getElementById('tb-block-end').value, '11:30')

  click(document.getElementById('tb-block-start'))
  click(wheel.querySelector('.wp-confirm'))
  assert.equal(document.getElementById('tb-block-end').value, '11:30', '结束时间已设定后修改开始时间不得重置结束时间')
})

test('时间块弹窗：新增块保存后持久化，结束早于开始视为跨午夜，非法颜色回退默认', () => {
  const { MS, document } = setup()
  MS.openBlockModal({ dateStr: '2026-10-15', startH: 22, durationH: 1 })
  type(document.getElementById('tb-block-label'), '夜间复盘')
  type(document.getElementById('tb-block-notes'), '整理本周输出与下周重点')
  document.getElementById('tb-block-end').value = '01:00'
  click(document.getElementById('tb-block-save'))

  assert.equal(document.getElementById('tb-modal').open, false)
  const [block] = MS.loadBlocks('2026-10-15')
  assert.equal(block.label, '夜间复盘')
  assert.equal(block.notes, '整理本周输出与下周重点')
  assert.equal(block.durationH, 3, '22:00 → 次日 01:00 应为 3 小时')

  MS.openBlockModal({ dateStr: '2026-10-15', block })
  assert.equal(document.getElementById('tb-block-notes').value, '整理本周输出与下周重点', '编辑时间块应回填备注')
  click(document.getElementById('tb-block-cancel'))

  const safe = MS.saveBlock('2026-10-15', {
    id: 'tb_" onmouseover="alert(1)', label: '注入测试', startH: 9, durationH: 1, category: 'red; background:url(javascript:1)', color: 'javascript:1',
  })
  assert.equal(safe.category, MS.CATEGORY_COLORS[0].key, '非法分类键必须回退')
  assert.equal('color' in safe, false, '旧 color 字段必须被剔除')
  assert.equal(safe.category, MS.CATEGORY_COLORS[0].key, '非法色彩字符串必须被重置')
})

test('时间块弹窗：日历支持跨日区间与多日点选批量创建时间块', () => {
  const { MS, document } = setup()

  // 1. 跨日模式：选择 2026-10-20 ~ 2026-10-22（共 3 天）
  MS.openBlockModal({ dateStr: '2026-10-20', startH: 9, durationH: 1 })
  type(document.getElementById('tb-block-label'), '晨间阅读')
  click(document.getElementById('tb-block-date'))
  const cal = document.getElementById('qls-calendar')
  assert.equal(cal.open, true)
  assert.equal(document.getElementById('qls-cal-mode-switch').hidden, false, '时间块日历应显示单日/跨日/多日切换栏')

  click(cal.querySelector('[data-cal-mode="range"]'))
  click(cal.querySelector('[data-date="2026-10-22"]'))
  assert.ok(cal.querySelector('[data-date="2026-10-21"]').classList.contains('in-range'), '跨日中间日期应带 in-range 高亮类')
  click(document.getElementById('qls-cal-confirm-btn'))
  assert.equal(cal.open, false)
  assert.equal(document.getElementById('tb-block-date').value, '10-20 ~ 10-22')

  click(document.getElementById('tb-block-save'))
  assert.equal(MS.loadBlocks('2026-10-20')[0]?.label, '晨间阅读')
  assert.equal(MS.loadBlocks('2026-10-21')[0]?.label, '晨间阅读')
  assert.equal(MS.loadBlocks('2026-10-22')[0]?.label, '晨间阅读')

  // 跨日系列块编辑后点击保存：拦截并提示删除重建（显示提示文案，隐藏三个范围按钮）
  MS.openBlockModal({ dateStr: '2026-10-20', block: MS.loadBlocks('2026-10-20')[0] })
  type(document.getElementById('tb-block-label'), '修改后的晨间阅读')
  click(document.getElementById('tb-block-save'))
  const delDlg = document.getElementById('tb-del-modal')
  assert.equal(delDlg.open, true, '编辑关联日期的时间块并保存时应弹窗提示删除重建')
  assert.equal(document.getElementById('tb-del-desc').hidden, false)
  assert.equal(document.getElementById('tb-del-scopes').hidden, true)
  assert.equal(MS.loadBlocks('2026-10-20')[0]?.label, '晨间阅读', '关联块编辑保存应被拦截，原内容保持不变')
  click(document.getElementById('tb-del-cancel'))

  // 跨日系列删除：显示「仅当天 / 当天及以后 / 全部」三个选项 + 底部「取消 / 删除」
  click(document.getElementById('tb-block-delete'))
  assert.equal(delDlg.open, true, '删除跨日系列块时应弹出系列删除确认框')
  assert.equal(document.getElementById('tb-del-desc').hidden, true)
  assert.equal(document.getElementById('tb-del-scopes').hidden, false)
  click(delDlg.querySelector('[data-del-scope="single"]'))
  click(document.getElementById('tb-del-confirm'))
  assert.equal(delDlg.open, false)
  assert.equal(MS.loadBlocks('2026-10-20').length, 0, '仅当天删除后 10-20 应被移除')
  assert.equal(MS.loadBlocks('2026-10-21').length, 1, '其余关联日期应保留')

  MS.openBlockModal({ dateStr: '2026-10-21', block: MS.loadBlocks('2026-10-21')[0] })
  click(document.getElementById('tb-block-delete'))
  assert.equal(delDlg.open, true)
  click(delDlg.querySelector('[data-del-scope="all"]'))
  click(document.getElementById('tb-del-confirm'))
  assert.equal(MS.loadBlocks('2026-10-21').length, 0, '全部删除后 10-21 应被移除')
  assert.equal(MS.loadBlocks('2026-10-22').length, 0, '全部删除后 10-22 应被移除')

  // 2. 多日模式：点选 2026-10-24 与 2026-10-26（共 2 天）
  MS.openBlockModal({ dateStr: '2026-10-24', startH: 14, durationH: 2 })
  type(document.getElementById('tb-block-label'), '专项训练')
  click(document.getElementById('tb-block-date'))
  click(cal.querySelector('[data-cal-mode="multi"]'))
  click(cal.querySelector('[data-date="2026-10-26"]'))
  click(document.getElementById('qls-cal-confirm-btn'))
  assert.equal(document.getElementById('tb-block-date').value, '10-24 等 2 日')

  click(document.getElementById('tb-block-save'))
  assert.equal(MS.loadBlocks('2026-10-24')[0]?.label, '专项训练')
  assert.equal(MS.loadBlocks('2026-10-25').length, 0)
  assert.equal(MS.loadBlocks('2026-10-26')[0]?.label, '专项训练')

  // 3. 重复模式：每 2 天重复，并支持「当天及以后」截断删除
  MS.openBlockModal({ dateStr: '2026-11-01', startH: 8, durationH: 1 })
  type(document.getElementById('tb-block-label'), '隔日晨跑')
  click(document.getElementById('tb-block-date'))
  click(cal.querySelector('[data-cal-mode="repeat"]'))
  assert.equal(document.getElementById('qls-cal-repeat-view').hidden, false, '切换到重复模式应展示重复配置面板')
  click(document.querySelector('#qls-cal-freq-num .cal-freq-item.is-near[data-val="2"]'))
  assert.equal(document.getElementById('qls-cal-summary').textContent, '事项将会每2天重复')
  click(document.getElementById('qls-cal-confirm-btn'))
  assert.equal(document.getElementById('tb-block-date').value, '每2天重复')
  click(document.getElementById('tb-block-save'))

  assert.equal(MS.loadBlocks('2026-11-01')[0]?.label, '隔日晨跑')
  assert.equal(MS.loadBlocks('2026-11-02').length, 0)
  assert.equal(MS.loadBlocks('2026-11-03')[0]?.label, '隔日晨跑')
  assert.equal(MS.loadBlocks('2026-11-05')[0]?.label, '隔日晨跑')

  // 4. 重复模式周周期回填与高亮回归验证：选择每 1 周周二、周三重复
  MS.openBlockModal({ dateStr: '2026-11-10', startH: 10, durationH: 1 })
  type(document.getElementById('tb-block-label'), '团队例会')
  click(document.getElementById('tb-block-date'))
  click(cal.querySelector('[data-cal-mode="repeat"]'))
  click(document.querySelector('#qls-cal-freq-unit .cal-freq-item.is-near[data-val="week"]'))
  click(document.querySelector('#qls-cal-repeat-cycle [data-rep-weekday="2"]')) // 周二
  click(document.querySelector('#qls-cal-repeat-cycle [data-rep-weekday="3"]')) // 周三
  assert.equal(document.getElementById('qls-cal-summary').textContent, '事项将会每1周的周二、周三重复')
  click(document.getElementById('qls-cal-confirm-btn'))
  assert.equal(document.getElementById('tb-block-date').value, '每1周重复')

  // 再次点击进入日历选择器，验证重复规则正确回填且高亮正常（不是灰色，文案正确）
  click(document.getElementById('tb-block-date'))
  assert.equal(document.getElementById('qls-cal-repeat-view').hidden, false)
  assert.equal(document.getElementById('qls-cal-summary').textContent, '事项将会每1周的周二、周三重复')
  const centerNum = document.querySelector('#qls-cal-freq-num .cal-freq-item.is-center')
  const centerUnit = document.querySelector('#qls-cal-freq-unit .cal-freq-item.is-center')
  assert.equal(centerNum?.dataset.val, '1', '中间高亮数字应为 1')
  assert.equal(centerUnit?.dataset.val, 'week', '中间高亮单位应为周')
  click(document.getElementById('qls-cal-confirm-btn'))
  click(document.getElementById('tb-block-cancel'))
})

test('重复时间块备份：导出后导入保留规则、单次遗漏和排除日期', async () => {
  const source = setup()
  const repeated = source.MS.saveRepeatBlock({
    label: '隔日晨跑',
    startH: 8,
    durationH: 1,
    category: 'health',
    notes: '公园路线',
    repeat: { unit: 'day', interval: 2, baseDate: '2026-11-01' },
  })
  assert.ok(repeated?.seriesId, '重复规则应成功保存')

  const missed = source.MS.loadBlocks('2026-11-05')[0]
  source.MS.saveBlock('2026-11-05', { ...missed, missed: true })
  source.MS.deleteBlock('2026-11-03', `${repeated.seriesId}_2026-11-03`)
  source.MS.saveBlock('2026-11-02', {
    id: 'tb_regular', label: '普通日程', startH: 10, durationH: 1, category: 'basic', notes: '',
  })

  const backup = source.MS.exportBackup()
  const restored = setup()
  const count = await restored.MS.importBackup(plain(backup.data))

  assert.equal(count, 1, '同一个 Schedule 时间块键应作为一个备份条目导入')
  assert.equal(restored.MS.loadBlocks('2026-11-01')[0]?.label, '隔日晨跑', '应恢复重复规则本身')
  assert.equal(restored.MS.loadBlocks('2026-11-03').length, 0, '应保留被排除的单次日期')
  assert.equal(restored.MS.loadBlocks('2026-11-05')[0]?.missed, true, '应保留单次遗漏状态')
  assert.equal(restored.MS.loadBlocks('2026-11-02')[0]?.label, '普通日程', '同一键里的普通日期块也应恢复')
})

test('任务弹窗：创建短期任务后时间轴渲染，空名称被拦截', () => {
  const { MS, document } = setup()
  MS.openModal(null, 'short')
  assert.equal(document.getElementById('task-modal').open, true)
  assert.notEqual(document.activeElement, document.getElementById('modal-task-title'), '打开任务弹窗不得自动聚焦输入框')

  click(document.getElementById('modal-save'))
  assert.equal(MS.loadTasks().length, 0, '任务名称为空不得保存')

  type(document.getElementById('modal-task-title'), '提交周报')
  type(document.getElementById('modal-notes'), '附上本周实验对比图表')
  click(document.querySelector('#modal-quadrant .q-option[data-q="plan"]'))
  click(document.getElementById('modal-save'))

  assert.equal(document.getElementById('task-modal').open, false)
  const [task] = MS.loadTasks()
  assert.equal(task.title, '提交周报')
  assert.equal(task.quadrant, 'plan')
  assert.match(document.getElementById('view-timeline').textContent, /提交周报/, '时间轴应渲染新任务')
  const taskCard = document.querySelector('#short-list .task-item')
  assert.equal(taskCard.getAttribute('title'), '附上本周实验对比图表')
  assert.equal(taskCard.dataset.notes, '附上本周实验对比图表')
})

test('时间轴排序：手动 / 开始 / 截止 / 象限 / 象限+截止', () => {
  const { MS } = setup()
  const tasks = [
    { id: 't_no_date',    title: '无日期事项',     tier: 'short', quadrant: 'plan',      startDate: '',           deadline: '' },
    { id: 't_only_start', title: '仅有开始时间',   tier: 'short', quadrant: 'do',        startDate: '2026-10-12', deadline: '' },
    { id: 't_late',       title: '较晚截止紧急',   tier: 'short', quadrant: 'delegate',  startDate: '2026-10-18', deadline: '2026-10-25' },
    { id: 't_early',      title: '较早截止重要',   tier: 'short', quadrant: 'do',        startDate: '2026-10-15', deadline: '2026-10-16' },
    { id: 't_elim',       title: '不重要不紧急项', tier: 'short', quadrant: 'eliminate', startDate: '2026-10-11', deadline: '2026-10-14' },
  ]
  const order = (cfg) => plain(MS.sortTimelineTasks(tasks, cfg).map(t => t.id))

  assert.deepEqual(order({ mode: 'manual', subTimeSort: 'none' }),
    ['t_no_date', 't_only_start', 't_late', 't_early', 't_elim'], '手动排序保持原顺序')
  assert.deepEqual(order({ mode: 'startDate', subTimeSort: 'none' }),
    ['t_elim', 't_only_start', 't_early', 't_late', 't_no_date'], '无开始日期排最后')
  assert.deepEqual(order({ mode: 'deadline', subTimeSort: 'none' }),
    ['t_elim', 't_early', 't_late', 't_no_date', 't_only_start'], '无截止日期排最后')
  assert.deepEqual(order({ mode: 'quadrant', subTimeSort: 'none' }),
    ['t_only_start', 't_early', 't_late', 't_no_date', 't_elim'], '象限顺序 do → delegate → plan → eliminate')
  assert.deepEqual(order({ mode: 'quadrant', subTimeSort: 'deadline' }),
    ['t_early', 't_only_start', 't_late', 't_no_date', 't_elim'], '同象限内有截止时间者优先')

  MS.saveTasks(tasks.map(t => ({ ...t, type: 'timeline', status: 'active' })))
  MS.reorderTimelineTier('short', ['t_early', 't_late', 't_only_start', 't_elim', 't_no_date'])
  assert.deepEqual(plain(MS.loadTasks().map(t => t.id)), ['t_early', 't_late', 't_only_start', 't_elim', 't_no_date'], '拖拽重排必须持久化')
})

test('时间轴拖拽与键盘重排：鼠标拖拽生成浮动卡片并在落位后持久化顺序', () => {
  const { MS, document, window } = setup()
  MS.saveTasks([
    { id: 't1', title: '任务一', tier: 'short', type: 'timeline', status: 'active', quadrant: 'do' },
    { id: 't2', title: '任务二', tier: 'short', type: 'timeline', status: 'active', quadrant: 'do' },
  ])
  MS.render()

  const list = document.getElementById('short-list')
  const first = list.querySelector('[data-id="t1"]')
  first.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }))
  assert.deepEqual(plain(MS.loadTasks().map(t => t.id)), ['t2', 't1'], 'Alt+↓ 应将首项移至第二项之后并持久化')

  const topItem = list.querySelector('[data-id="t2"]')
  topItem.dispatchEvent(new window.MouseEvent('mousedown', { button: 0, clientX: 20, clientY: 10, bubbles: true }))
  window.dispatchEvent(new window.MouseEvent('mousemove', { clientX: 20, clientY: 80, bubbles: true }))
  const ghost = document.querySelector('.touch-drag-ghost')
  assert.ok(ghost, '拖拽移动超过阈值后应生成浮动卡片')
  assert.equal(ghost.classList.contains('dragging'), false, '浮动卡片不应携带透明占位类 dragging')
  assert.equal(ghost.classList.contains('is-touch-source'), false, '浮动卡片不应携带透明占位类 is-touch-source')
  window.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
  assert.equal(document.querySelector('.touch-drag-ghost'), null, '松开鼠标后应清理浮动卡片')
})

test('脏数据容错：null 与非法项过滤，正常任务保留', () => {
  const { MS, localStorage } = setup()
  localStorage.setItem('schedule_tasks', JSON.stringify([
    null,
    { id: 't_valid_short', title: '正常短期事项', tier: 'short' },
    { id: 't_empty_title', title: '   ' },
    'invalid_string_item',
  ]))
  const tasks = MS.loadTasks()
  assert.equal(tasks.length, 1, '含 null 等脏数据时不得崩溃或清空正常任务')
  assert.equal(tasks[0].id, 't_valid_short')
})

test('日期解析：按本地时区且拒绝自动进位', () => {
  const { MS } = setup()
  const d = MS.parseDateKey('2026-10-15')
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate()], [2026, 9, 15])
  assert.equal(MS.parseDateKey('2026-02-29'), null)
  assert.equal(MS.formatDate('2026-10-15'), '10月15日')
})

test('结算弹窗：二次调整总时长并回写量化记录', () => {
  const { MS, QL, document, window } = setup()
  const now = new window.Date()
  // 已结束任务仅在「当日」展示，因此必须使用今天的日期
  const t = (h, m) => new window.Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0).getTime()
  const task = MS.startInProgressTask({ title: '写作', category: 'career', tags: ['编程'], now: t(9, 0) })
  MS.finishInProgressTask(task.id, t(10, 0))

  // 通过真实渲染的卡片触发「调整时间」入口
  click(document.querySelector('.view-tab[data-view="inprogress"]'))
  const adjustBtn = document.querySelector('#view-inprogress [data-ip-action="edit"]')
  assert.ok(adjustBtn, '已完成任务卡片应提供调整入口')
  click(adjustBtn)

  const dlg = document.getElementById('ip-settle-modal')
  assert.equal(dlg.open, true)
  assert.equal(document.getElementById('ip-settle-title').value, '写作')
  assert.equal(document.getElementById('ip-settle-total').value, '01:00')

  document.getElementById('ip-settle-total').value = '02:30'
  click(document.getElementById('ip-settle-save'))
  assert.equal(dlg.open, false)
  assert.equal(MS.loadInProgressTasks()[0].finalHours, 2.5)
  assert.equal(QL.loadDayData(task.date).time.career, 2.5)

  // 已结束卡片：「调整时间」后紧跟「心情」按钮，选择后展示对应心情图标且仅作卡片展示
  const moodBtn = document.querySelector('#view-inprogress [data-ip-action="mood-toggle"]')
  assert.ok(moodBtn, '已结束卡片应提供心情按钮')
  assert.equal(moodBtn.textContent, '心情')
  click(moodBtn)
  assert.equal(moodBtn.closest('.ip-mood-wrap').classList.contains('open'), true)

  click(document.querySelector('#view-inprogress [data-ip-action="mood-pick"][data-mood="great"]'))
  assert.equal(MS.loadInProgressTasks()[0].mood, 'great')
  assert.equal(document.querySelector('#view-inprogress [data-ip-action="mood-toggle"] img')?.getAttribute('src'), '../MAERS-QuantiLife/ui/great.svg')
  assert.equal(QL.loadDayData(task.date).mood, null, '任务卡片心情仅作展示，不得篡改量化每日心情')
})

test('时间块：被覆盖的详情与并行项默认折叠，点击图层图标后展开并带条纹标记类', () => {
  const { MS, document } = setup()
  const today = MS.today()
  MS.saveBlock(today, { id: 'p1', label: '上午研发', startH: 9, durationH: 3, category: 'career' })
  MS.saveBlock(today, { id: 's1', label: '接口开发', startH: 9, durationH: 1.5, category: 'career' })
  MS.renderTimeblock(document.getElementById('view-timeblock'))

  const body = document.querySelector('.tb-day-body[data-date="' + today + '"]')
  assert.equal(body.querySelectorAll('.tb-block').length, 1, '默认仅显示较长的块')
  assert.equal(body.querySelector('.tb-block-detail'), null)

  click(document.getElementById('tb-toggle-detail'))
  assert.equal(body.querySelectorAll('.tb-block').length, 2, '展开后显示详情项')
  const detail = body.querySelector('.tb-block-detail')
  assert.ok(detail, '详情项应带 tb-block-detail 类')
  assert.equal(detail.dataset.blockId, 's1')
  assert.equal(body.querySelector('[data-block-id="p1"]').classList.contains('tb-block-detail'), false, '较长的块不应带条纹类')
})

test('进行中卡片：非计时状态下（已暂停 / 已结束）点击卡片可打开弹窗编辑名称、分类与标签', () => {
  const { MS, document, window } = setup()
  const now = new window.Date()
  const t = (h, m) => new window.Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m, 0).getTime()
  const task = MS.startInProgressTask({ title: '整理文档', category: 'basic', tags: [], now: t(15, 0) })
  click(document.querySelector('.view-tab[data-view="inprogress"]'))

  const dlg = document.getElementById('ip-add-modal')
  // 计时中状态点击卡片不触发编辑弹窗
  click(document.querySelector('.ip-card-title'))
  assert.equal(dlg.open, false, '计时中状态点击卡片不得弹出编辑框')

  // 暂停后进入非计时状态，点击卡片弹出编辑弹窗并回填信息
  MS.pauseInProgressTask(task.id, t(15, 30))
  MS.renderInProgress()
  click(document.querySelector('.ip-card-title'))
  assert.equal(dlg.open, true, '已暂停状态点击卡片应打开编辑弹窗')
  assert.equal(document.getElementById('ip-add-modal-title').textContent, '编辑进行中任务')
  assert.equal(document.getElementById('ip-add-save').textContent, '保存')
  assert.equal(document.getElementById('ip-task-title').value, '整理文档')

  type(document.getElementById('ip-task-title'), '整理架构文档')
  click(dlg.querySelector('[data-category="career"]'))
  type(document.getElementById('ip-task-tags'), '架构设计')
  click(document.getElementById('ip-add-save'))

  assert.equal(dlg.open, false)
  const [updated] = MS.loadInProgressTasks()
  assert.equal(updated.title, '整理架构文档')
  assert.equal(updated.category, 'career')
  assert.deepEqual(plain(updated.tags), ['架构设计'])
})

