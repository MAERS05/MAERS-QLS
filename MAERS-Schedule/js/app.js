import { scheduleTransfer as svcScheduleTransfer } from './data-transfer.js'
import { timerView as svcTimerView } from './in-progress.js'
import { scheduleMetadata as svcScheduleMetadata } from './shared.js'
import { tasks as svcTasks } from './task-service.js'
import { timeblockView as svcTimeblockView } from './timeblock.js'
import { timeline as svcTimeline } from './timeline.js'
import { calendarPicker as svcCalendarPicker } from '../../common/js/calendar-picker.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dom as svcDom } from '../../common/js/dom.js'
import { storageState as svcStorageState } from '../../common/js/idb-store.js'
import { jsonTransfer as svcJsonTransfer } from '../../common/js/json-transfer.js'
import { storage as svcStorage } from '../../common/js/store.js'
import { ui as svcUi } from '../../common/js/ui.js'

const svcScheduleApp = {}
export const scheduleApp = svcScheduleApp

/**
 * MAERS Schedule — 主应用协调器 (app.js)
 */
const $ = svcDom.$
const $$ = svcDom.$$

svcTimeline.configureTimeline({ editTask: openTaskModal, editGoal: openGoalModal })

const VIEWS = {
  timeblock:  { el: $('#view-timeblock'),  render: () => svcTimeblockView.renderTimeblock($('#view-timeblock')) },
  timeline:   { el: $('#view-timeline'),   render: () => render() },
  inprogress: { el: $('#view-inprogress'), render: () => svcTimerView.renderInProgress($('#view-inprogress')) },
}
const savedEntry = svcStorage.store.get(svcMetadata.SCH_ENTRY_KEY, 'timeblock')
let currentView = VIEWS[savedEntry] ? savedEntry : 'timeblock'

function applyTabState(viewName, { focusTab = false } = {}) {
  $$('.view-tab').forEach(tab => {
    const active = tab.dataset.view === viewName
    tab.classList.toggle('active', active)
    tab.setAttribute('aria-selected', String(active))
    tab.tabIndex = active ? 0 : -1
    if (active && focusTab) tab.focus()
  })
  Object.entries(VIEWS).forEach(([name, view]) => { view.el.hidden = name !== viewName })
}

// 首屏同步设定标签激活态与面板显隐，避免等待 IndexedDB 异步就绪时从「规划表」闪烁跳变
applyTabState(currentView)

// ── 视图切换（规划表 | 时间轴 | 进行中），遵循 WAI-ARIA Tabs 模式 ──
function switchView(viewName, { focusTab = false } = {}) {
  currentView = viewName
  applyTabState(viewName, { focusTab })
  VIEWS[viewName].render()
}

const tabList = $('.view-tabs')
tabList.addEventListener('click', e => {
  const tab = e.target.closest('.view-tab')
  if (tab) switchView(tab.dataset.view)
})
// 方向键在标签间移动（自动激活）
tabList.addEventListener('keydown', e => {
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key]
  if (!step) return
  e.preventDefault()
  const names = Object.keys(VIEWS)
  const next = names[(names.indexOf(currentView) + step + names.length) % names.length]
  switchView(next, { focusTab: true })
})

// ── 全局渲染 ──────────────────────────────────────────
function render() {
  svcTimeline.renderTimeline(svcTasks.loadTasks(), svcTasks.loadGoals())
}
svcScheduleApp.render = render

// ── 任务弹窗（短期 / 中期） ───────────────────────────
const taskDlg = $('#task-modal')
const taskFields = {
  title:     $('#modal-title'),
  name:      $('#modal-task-title'),
  quadrant:  $('#modal-quadrant'),
  startDate: $('#modal-start-date'),
  deadline:  $('#modal-deadline'),
  subField:  $('#field-subtasks'),
  subtasks:  $('#modal-subtasks'),
  notes:     $('#modal-notes'),
  del:       $('#modal-delete'),
}
const taskCtx = { id: null, tier: 'short', base: null, session: 0 }

function selectQuadrant(q) {
  taskFields.quadrant.querySelectorAll('.q-option').forEach(opt => {
    const on = opt.dataset.q === q
    opt.classList.toggle('selected', on)
    opt.setAttribute('aria-checked', String(on))
    opt.tabIndex = on ? 0 : -1
  })
}

function openTaskModal(taskId, defaultTier = 'short') {
  const snapshot = svcTasks.loadEditorSnapshot()
  const task = taskId ? snapshot.items.find(item => item.id === taskId) : null
  taskCtx.id = task ? task.id : null
  taskCtx.tier = task?.tier || defaultTier
  taskCtx.base = snapshot.base
  taskCtx.original = task
  taskCtx.session++

  taskFields.name.value      = task?.title || ''
  taskFields.startDate.value = task?.startDate || ''
  taskFields.deadline.value  = task?.deadline || ''
  taskFields.subtasks.value  = (task?.subtasks || []).map(s => s.text).join('\n')
  taskFields.notes.value     = task?.notes || ''
  taskFields.del.hidden      = !task
  taskFields.subField.hidden = taskCtx.tier !== 'mid'
  taskFields.title.textContent = `${task ? '编辑任务' : '新任务'}(${svcScheduleMetadata.TIERS[taskCtx.tier]?.label || '短期'})`
  selectQuadrant(task?.quadrant || 'do')

  svcUi.openDialog(taskDlg)
}

function saveTaskModal() {
  const title = taskFields.name.value.trim()
  if (!title) { svcUi.showToast('请输入任务名称'); return }

  const existing = taskCtx.original
  const oldSubs = existing?.subtasks || []
  const subtasks = taskCtx.tier === 'mid'
    ? taskFields.subtasks.value.split('\n').map(s => s.trim()).filter(Boolean)
        .map(text => oldSubs.find(s => s.text === text) || { text, done: false })
    : []

  const saved = svcTasks.saveTaskOrGoal({
    id: taskCtx.id,
    title,
    quadrant: taskFields.quadrant.querySelector('.q-option.selected')?.dataset.q || 'do',
    tier: taskCtx.tier,
    startDate: taskFields.startDate.value,
    deadline: taskFields.deadline.value,
    notes: taskFields.notes.value.trim(),
    subtasks,
  }, { base: taskCtx.base })
  if (!saved) return

  const wasEdit = !!taskCtx.id
  finishEditorSave(taskDlg, taskCtx, wasEdit ? '已更新' : '已创建')
}

function finishEditorSave(dialog, context, message) {
  if (svcStorage.store.mode !== 'indexeddb') {
    svcUi.closeDialog(dialog)
    render()
    svcStorage.showSavedToast(message)
    return
  }
  const session = context.session
  const controls = [...dialog.querySelectorAll('input, textarea, button')].filter(control => !control.disabled)
  controls.forEach(control => { control.disabled = true })
  svcStorage.store.flush().then(() => {
    if (session === context.session) svcUi.closeDialog(dialog)
    render()
    svcUi.showToast(message)
  }).catch(() => { /* 冲突或写入失败时保留弹窗原输入，错误由存储层提示。 */ })
    .finally(() => controls.forEach(control => { control.disabled = false }))
}

function deleteFromTaskModal() {
  if (!taskCtx.id || !confirm('确定删除？')) return
  svcTasks.deleteTaskOrGoal(taskCtx.id)
  svcUi.closeDialog(taskDlg)
  render()
  svcStorage.showSavedToast('已删除')
}

svcUi.bindDialog(taskDlg, { onClose: () => { taskCtx.id = null; taskCtx.session++ } })
svcCalendarPicker.bindDateInput(taskFields.startDate, { allowClear: true })
svcCalendarPicker.bindDateInput(taskFields.deadline,  { allowClear: true })
taskFields.quadrant.addEventListener('click', e => {
  const opt = e.target.closest('.q-option')
  if (opt) selectQuadrant(opt.dataset.q)
})
// 单选组方向键切换
taskFields.quadrant.addEventListener('keydown', e => {
  const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
  if (!step) return
  e.preventDefault()
  const opts = [...taskFields.quadrant.querySelectorAll('.q-option')]
  const idx = opts.findIndex(o => o.classList.contains('selected'))
  const next = opts[(idx + step + opts.length) % opts.length]
  selectQuadrant(next.dataset.q)
  next.focus()
})
$('#modal-save').addEventListener('click', saveTaskModal)
$('#modal-cancel').addEventListener('click', () => svcUi.closeDialog(taskDlg))
taskFields.del.addEventListener('click', deleteFromTaskModal)

svcScheduleApp.openModal = openTaskModal

// ── 长期愿景弹窗 ──────────────────────────────────────
const goalDlg = $('#goal-modal')
const goalCtx = { id: null, base: null, session: 0 }

function openGoalModal(goalId = null) {
  const snapshot = svcTasks.loadEditorSnapshot(true)
  const goal = goalId ? snapshot.items.find(item => item.id === goalId) : null
  goalCtx.id = goal ? goal.id : null
  goalCtx.base = snapshot.base
  goalCtx.session++
  $('#goal-title').value = goal?.title || ''
  $('#goal-notes').value = goal?.notes || ''
  svcUi.openDialog(goalDlg)
}

svcUi.bindDialog(goalDlg, { onClose: () => { goalCtx.id = null; goalCtx.session++ } })
$('#goal-save').addEventListener('click', () => {
  const title = $('#goal-title').value.trim()
  if (!title) { svcUi.showToast('请输入目标名称'); return }
  const wasEdit = !!goalCtx.id
  const saved = svcTasks.saveTaskOrGoal({ id: goalCtx.id, isGoal: true, title, notes: $('#goal-notes').value.trim() }, { base: goalCtx.base })
  if (saved) finishEditorSave(goalDlg, goalCtx, wasEdit ? '已更新' : '已添加')
})
$('#goal-cancel').addEventListener('click', () => svcUi.closeDialog(goalDlg))

svcScheduleApp.openGoalModal = openGoalModal

// 时间轴内联「添加」卡片
$('#view-timeline').addEventListener('click', e => {
  const addCard = e.target.closest('.timeline-inline-add[data-tier]')
  if (!addCard) return
  if (addCard.dataset.tier === 'long') openGoalModal()
  else openTaskModal(null, addCard.dataset.tier)
})

// 弹窗的 Esc 关闭由原生 <dialog> 负责；此处仅处理非模态的排序下拉菜单
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') svcTimeline.closeSortMenu?.()
})

// ── 导出与导入 ────────────────────────────────────────
$('#ms-export').addEventListener('click', () => {
  const { filename, data } = svcScheduleTransfer.exportBackup()
  svcJsonTransfer.downloadJson(filename, data)
})

const importFile = $('#ms-import-file')
$('#ms-import').addEventListener('click', () => importFile.click())
svcJsonTransfer.bindJsonFileInput(importFile, async (json) => {
  const count = await svcScheduleTransfer.importBackup(json)
  VIEWS[currentView].render()
  svcUi.showToast(count > 0 ? `📥 已导入 ${count} 类数据` : '❌ 未找到可导入的 Schedule 数据')
})

// ── 跨标签页同步 ──────────────────────────────────────
// 其他标签页修改了 Schedule / QuantiLife 数据：刷新当前视图；
// 若有弹窗正在编辑，则推迟到弹窗关闭后再刷新，避免打断输入。
let refreshPending = false
function refreshView() {
  if (document.querySelector('dialog[open]')) { refreshPending = true; return }
  refreshPending = false
  VIEWS[currentView].render()
}
// dialog 的 close 事件不冒泡，须在捕获阶段监听
document.addEventListener('close', () => { if (refreshPending) setTimeout(refreshView, 0) }, true)
svcStorage.onStoreChange(keys => {
  if (keys.some(key => key.startsWith(svcMetadata.MS_PREFIX) || key.startsWith(svcMetadata.QL_PREFIX))) refreshView()
})

// ── 初始化 ────────────────────────────────────────────
svcStorageState.onStorageReady(() => {
  const entryView = svcStorage.store.get(svcMetadata.SCH_ENTRY_KEY, 'timeblock')
  switchView(VIEWS[entryView] ? entryView : 'timeblock')
})
