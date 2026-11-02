import { search as svcSearch } from './search.js'
import { scheduleMetadata as svcScheduleMetadata } from './shared.js'
import { scheduleTags as svcScheduleTags } from './tags.js'
import { timers as svcTimers } from './timer-service.js'
import { widgets as svcWidgets } from './widgets.js'
import { calendarPicker as svcCalendarPicker } from '../../common/js/calendar-picker.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { dom as svcDom } from '../../common/js/dom.js'
import { storage as svcStorage } from '../../common/js/store.js'
import { ui as svcUi } from '../../common/js/ui.js'
import { wheelPicker as svcWheelPicker } from '../../common/js/wheel-picker.js'

const svcTimerView = {}
export const timerView = svcTimerView

/**
 * MAERS Schedule — 「进行中」视图渲染与交互控制器 (in-progress.js)
 * 职责：
 * 1. 渲染「进行中」任务卡片列表、实时秒表走字与多段起止时间明细；
 * 2. 采用事件委托统一处理卡片操作（暂停/继续/结束/放弃/调整时间/删除）与弹窗交互；
 * 3. 状态流转与跨端同步全部委托给 MS.* 领域服务层 (shared.js)。
 */

const $ = svcDom.$
const html = svcDom.html
const fmtH = svcDates.fmtH
const nowHm = svcDates.nowHm
const fmtDuration = svcDates.fmtDuration
const fmtDurationSec = svcTimers.fmtDurationSec
const calcSegmentHours = svcTimers.calcSegmentHours
const calcSegmentsTotalHours = svcTimers.calcSegmentsTotalHours
const getPinyinInitials = svcSearch.getPinyinInitials

let tickTimer = null
let viewDelegated = false
// null 表示「今天 / 进行中」视图；非空时仅查看该日已结束的历史任务。
let historyDate = null

// ── 实时走字定时器（每秒仅增量更新 DOM 文本，不重绘列表） ──────────
function ensureTickTimer() {
  if (tickTimer) return
  tickTimer = setInterval(() => {
    const view = $('#view-inprogress')
    if (!view || view.hidden) return

    const now = Date.now()
    const curHm = nowHm(new Date(now))
    if (document.visibilityState === 'hidden') return
    svcTimers.loadRunningTasks().forEach(t => {
      if (t.status !== 'running') return
      const timerEl = view.querySelector(`[data-ip-timer="${CSS.escape(t.id)}"]`)
      if (timerEl) timerEl.textContent = fmtDurationSec(calcSegmentsTotalHours(t.segments, now) * 3600000)

      const activeSegEl = view.querySelector(`[data-ip-active-seg="${CSS.escape(t.id)}"]`)
      const lastSeg = t.segments[t.segments.length - 1]
      if (activeSegEl && lastSeg) {
        activeSegEl.textContent = `${lastSeg.startHm} – 进行中 (${curHm} · ${fmtH(calcSegmentHours(lastSeg, now))})`
      }
    })
  }, 1000)
}

// ── 卡片操作表（action → 处理函数） ───────────────────
const CARD_ACTIONS = {
  pause(id) {
    if (svcTimers.pauseInProgressTask(id)) refresh('❚❚ 已暂停计时')
  },
  resume(id) {
    if (svcTimers.resumeInProgressTask(id)) refresh('▶ 已继续计时（开启新时间段）')
  },
  finish(id) {
    const done = svcTimers.finishInProgressTask(id)
    if (!done) return
    refresh(done.tags.length > 0
      ? `✅ 已结束并计入今日量化 (${fmtH(done.finalHours)})，可点击「调整时间」修改`
      : `✅ 已结束本地计时 (${fmtH(done.finalHours)})，未填标签不计入量化`)
  },
  abandon(id) {
    if (!confirm('确定要放弃此进行中任务吗？放弃后不会计入量化记录。')) return
    svcTimers.abandonInProgressTask(id)
    refresh('已放弃任务')
  },
  edit(id) {
    openSettleModal(id)
  },
  delete(id) {
    if (!confirm('确定要删除这条记录吗？将同步从今日量化记录与 QuantiLife 移除。')) return
    svcTimers.deleteInProgressTask(id)
    refresh('🗑️ 已删除记录')
  },
}

function refresh(toast) {
  renderInProgress()
  if (toast) svcStorage.showSavedToast(toast)
}

// ── 主视图事件委托（一次性挂载） ────────────────────────
function bindViewDelegation(target) {
  if (viewDelegated) return
  viewDelegated = true
  target.addEventListener('click', e => {
    if (e.target.closest('#ip-open-add-btn')) { openAddModal(); return }
    if (e.target.closest('#ip-history-toggle')) {
      const todayStr = svcDates.today()
      const latestHistoryDate = svcTimers.loadInProgressTasks()
        .filter(t => t.status === 'completed' && t.date && t.date !== todayStr)
        .map(t => t.date)
        .sort()
        .at(-1)
      if (!latestHistoryDate) { svcUi.showToast('暂无更早的已结束任务'); return }
      historyDate = latestHistoryDate
      renderInProgress()
      return
    }
    if (e.target.closest('#ip-history-back')) {
      historyDate = null
      renderInProgress()
      return
    }
    const historyDateBtn = e.target.closest('#ip-history-date')
    if (historyDateBtn) {
      const completedDates = new Set(svcTimers.loadInProgressTasks()
        .filter(t => t.status === 'completed' && t.date)
        .map(t => t.date))
      svcCalendarPicker.openCalendarPicker({
        date: historyDate,
        anchorEl: historyDateBtn,
        hasDataFn: dateStr => completedDates.has(dateStr),
        onSelect: (_, dateStr) => {
          historyDate = dateStr
          renderInProgress()
        },
      })
      return
    }
    const btn = e.target.closest('[data-ip-action]')
    if (!btn) {
      if (target.querySelector('.ip-mood-wrap.open')) {
        closeMoodMenus(target)
        return
      }
      const card = e.target.closest('.ip-card.is-editable')
      if (card && !e.target.closest('.ip-actions')) {
        openAddModal(card.dataset.ipCardId)
      }
      return
    }
    const action = btn.dataset.ipAction
    if (action === 'mood-toggle') {
      const wrap = btn.closest('.ip-mood-wrap')
      const willOpen = wrap && !wrap.classList.contains('open')
      closeMoodMenus(target)
      if (wrap && willOpen) wrap.classList.add('open')
      return
    }
    if (action === 'mood-pick') {
      const taskId = btn.dataset.id
      const picked = btn.dataset.mood
      const cur = svcTimers.loadInProgressTasks().find(t => t.id === taskId)?.mood
      svcTimers.setInProgressTaskMood(taskId, cur === picked ? null : picked)
      renderInProgress()
      return
    }
    closeMoodMenus(target)
    CARD_ACTIONS[action]?.(btn.dataset.id)
  })

  document.addEventListener('click', e => {
    if (!e.target.closest('.ip-mood-wrap')) closeMoodMenus(target)
  })
}

function closeMoodMenus(root = document) {
  root.querySelectorAll('.ip-mood-wrap.open').forEach(el => el.classList.remove('open'))
}

// ── 主视图渲染 ────────────────────────────────────────
function renderInProgress(container) {
  const target = container || $('#view-inprogress')
  if (!target) return

  ensureTickTimer()
  bindViewDelegation(target)

  const todayStr = svcDates.today()
  const isHistoryView = !!historyDate
  const visibleTasks = svcTimers.loadInProgressTasks().filter(t => isHistoryView
    ? t.status === 'completed' && t.date === historyDate
    : t.status === 'running' || t.status === 'paused' || (t.status === 'completed' && t.date === todayStr))

  svcStorage.emit(svcMetadata.BRIDGE_CHANGED_EVENT, { dateStr: todayStr })

  const isEmpty = visibleTasks.length === 0
  const title = isHistoryView ? `${svcDates.formatDate(historyDate)} 历史任务` : '进行中任务'
  svcDom.setHTML(target, html`
    <section class="ip-section" aria-labelledby="ip-section-title">
      <div class="ip-header">
        <h2 class="ip-title" id="ip-section-title">
          <span class="ip-title-text"><img class="ip-title-icon" src="ui/time.svg" width="18" height="18" alt="">${title}</span>
          <span class="ip-count">${visibleTasks.length}</span>
        </h2>
        ${isHistoryView
          ? html`<div class="ip-history-actions">
              <button type="button" class="ip-history-btn" id="ip-history-date" title="选择历史日期">${svcDates.formatDate(historyDate)}</button>
              <button type="button" class="ip-history-btn" id="ip-history-back">返回今天</button>
            </div>`
          : html`<button type="button" class="ip-history-btn" id="ip-history-toggle">查看历史</button>`}
      </div>
      <div class="ip-grid">
        ${visibleTasks.map(renderTaskCard)}
        ${isHistoryView && isEmpty
          ? html`<p class="ip-history-empty">这一天没有已结束的任务</p>`
          : isHistoryView
            ? ''
            : html`<button type="button" class="ip-add-card${isEmpty ? ' is-empty' : ''}" id="ip-open-add-btn">
                <span class="ip-add-card-icon" aria-hidden="true">＋</span>
                <span class="ip-add-card-copy">
                  <span class="ip-add-card-title">添加进行中任务</span>
                  <span class="ip-add-card-hint">${isEmpty ? '开始一段新的专注计时' : '开始计时'}</span>
                </span>
              </button>`}
      </div>
    </section>`)
}

const STATUS_BADGES = {
  running:   html`<span class="ip-status-badge running"><span class="ip-pulse-dot" aria-hidden="true"></span>计时中</span>`,
  paused:    html`<span class="ip-status-badge paused">❚❚ 已暂停</span>`,
  completed: html`<span class="ip-status-badge completed">✓ 已结束</span>`,
}

function actionBtn(action, id, cls, text, label) {
  return html`<button type="button" class="ip-btn ${cls}" data-ip-action="${action}" data-id="${id}"
    ${label ? html`title="${label}" aria-label="${label}"` : ''}>${text}</button>`
}

function renderMoodPicker(task) {
  const moodMeta = task.mood ? svcMetadata.MOOD_META[task.mood] : null
  const btnTitle = moodMeta ? `心情：${moodMeta.label}（点击更换或取消）` : '选择心情'
  return html`
    <div class="ip-mood-wrap">
      <button type="button" class="ip-btn ip-btn-mood${moodMeta ? ' has-mood' : ''}"
        data-ip-action="mood-toggle" data-id="${task.id}"
        title="${btnTitle}" aria-label="${btnTitle}">${moodMeta ? svcDom.moodIcon(task.mood, 18) : '心情'}</button>
      <div class="ip-mood-menu" role="group" aria-label="选择任务心情">
        ${svcMetadata.MOOD_KEYS.map(key => {
          const m = svcMetadata.MOOD_META[key]
          return html`<button type="button" class="ip-mood-opt${task.mood === key ? ' active' : ''}"
            data-ip-action="mood-pick" data-id="${task.id}" data-mood="${key}"
            title="${m.label}" aria-label="${m.label}">
            <span class="ip-mood-opt-emoji">${svcDom.moodIcon(key, 20)}</span>
            <span class="ip-mood-opt-label">${m.label}</span>
          </button>`
        })}
      </div>
    </div>`
}

function renderSegmentRow(task, seg, idx, now) {
  const isActive = task.status === 'running' && idx === task.segments.length - 1 && seg.endAt == null
  const segH = calcSegmentHours(seg, now)
  return html`
    <div class="ip-seg-row">
      <span class="ip-seg-idx">第 ${idx + 1} 段</span>
      ${isActive
        ? html`<span class="ip-seg-range" data-ip-active-seg="${task.id}">${seg.startHm} – 进行中 (${nowHm(new Date(now))} · ${fmtH(segH)})</span>`
        : html`<span class="ip-seg-range">${seg.startHm} – ${seg.endHm || nowHm()}</span><span class="ip-seg-dur">${fmtH(segH)}</span>`}
    </div>`
}

function renderTaskCard(task) {
  const now = Date.now()
  const isRunning   = task.status === 'running'
  const isCompleted = task.status === 'completed'
  const totalH = isCompleted && task.finalHours != null ? task.finalHours : calcSegmentsTotalHours(task.segments, now)
  const hasTags = task.tags.length > 0
  const segCount = task.segments.length
  const timerLabelText = isCompleted
    ? (hasTags ? `已计入${task.date === svcDates.today() ? '今日' : svcDates.formatDate(task.date)}量化（共 ${segCount} 段）` : `已完成本地计时（共 ${segCount} 段）`)
    : `累计时长（共 ${segCount} 段）`

  const actions = isCompleted
    ? [
        actionBtn('edit', task.id, 'ip-btn-finish', '✎ 调整时间'),
        renderMoodPicker(task),
        actionBtn('delete', task.id, 'ip-btn-abandon', '删除', `删除「${task.title}」并从量化记录移除`),
      ]
    : [
        isRunning
          ? actionBtn('pause', task.id, 'ip-btn-pause', '❚❚ 暂停')
          : actionBtn('resume', task.id, 'ip-btn-resume', '▶ 继续'),
        actionBtn('finish', task.id, 'ip-btn-finish', '✓ 结束'),
        actionBtn('abandon', task.id, 'ip-btn-abandon', '放弃', `放弃「${task.title}」`),
      ]

  return html`
    <article class="ip-card${isCompleted ? ' is-completed' : ''}${!isRunning ? ' is-editable' : ''}"
      data-ip-card-id="${task.id}" style="--ip-color:${svcScheduleMetadata.categoryMeta(task.category).color}"
      ${!isRunning ? html`title="点击编辑任务信息"` : ''}>
      <div class="ip-card-top">
        <div class="ip-card-info">
          <h3 class="ip-card-title">${task.title}</h3>
          ${hasTags ? html`<div class="ip-card-tags">${task.tags.map(tag => html`<span class="ip-tag-badge"># ${tag}</span>`)}</div>` : ''}
        </div>
        ${STATUS_BADGES[task.status]}
      </div>
      <div class="ip-timer-box">
        <span class="ip-timer-label">${timerLabelText}</span>
        <span class="ip-timer-digits" data-ip-timer="${task.id}">${isCompleted ? fmtH(totalH) : fmtDurationSec(totalH * 3600000)}</span>
      </div>
      <div class="ip-segments">${task.segments.map((seg, idx) => renderSegmentRow(task, seg, idx, now))}</div>
      <div class="ip-actions">${actions}</div>
    </article>`
}

// ── 弹窗 1：添加 / 编辑进行中任务 (#ip-add-modal) ─────────
const addDlg = $('#ip-add-modal')
const addFields = {
  modalTitle: $('#ip-add-modal-title'),
  title:      $('#ip-task-title'),
  tags:       $('#ip-task-tags'),
  search:     $('#ip-tag-search'),
  swatches:   $('#ip-color-swatches'),
  sugs:       $('#ip-tag-suggestions'),
  error:      $('#ip-tag-error'),
  saveBtn:    $('#ip-add-save'),
}
let currentTagsForCat = []
let editingTaskId = null
let editingBase = null

const selectedCategory = () => svcScheduleMetadata.categoryMeta(svcWidgets.getSwatchCategory(addFields.swatches))

function updateCategoryTags() {
  const category = selectedCategory()
  currentTagsForCat = svcScheduleTags.getCategoryTags(category.key)
  renderTagSuggestions()
}

function renderTagSuggestions() {
  const query = addFields.search.value.trim().toLowerCase()
  const filtered = currentTagsForCat.filter(tag =>
    !query || tag.toLowerCase().includes(query) || getPinyinInitials(tag).includes(query))

  if (filtered.length === 0) {
    svcDom.setHTML(addFields.sugs, html`<span class="tb-tag-empty">无匹配标签，输入名称后点击右侧 + 创建</span>`)
    return
  }
  svcDom.setHTML(addFields.sugs, html`${filtered.map(tag =>
    html`<button type="button" class="tb-tag-chip" data-tag="${tag}" aria-label="添加标签 ${tag}"># ${tag}</button>`)}`)
  addFields.sugs.style.setProperty('--chip-color', selectedCategory().color)
}

function appendTagToInput(tag) {
  const current = svcWidgets.parseTagInput(addFields.tags.value)
  if (current.includes(tag)) return
  current.push(tag)
  addFields.tags.value = current.join(', ')
}

function showTagError() {
  addFields.error.classList.add('is-visible')
  setTimeout(() => addFields.error.classList.remove('is-visible'), 1500)
}

function openAddModal(taskId = null) {
  const id = typeof taskId === 'string' ? taskId : null
  const snapshot = svcTimers.loadTimerEditor()
  editingBase = snapshot.base
  const task = id ? snapshot.items.find(t => t.id === id) : null
  if (id && (!task || task.status === 'running')) return

  editingTaskId = task ? task.id : null
  if (addFields.modalTitle) addFields.modalTitle.textContent = task ? '编辑进行中任务' : '添加进行中任务'
  if (addFields.saveBtn) addFields.saveBtn.textContent = task ? '保存' : '▶ 开始计时'
  addFields.title.value = task ? task.title : ''
  addFields.tags.value = task ? task.tags.join(', ') : ''
  addFields.search.value = ''
  svcWidgets.renderCategorySwatches(addFields.swatches, task?.category)
  updateCategoryTags()
  svcUi.openDialog(addDlg)
}

async function saveTaskFromModal() {
  const title = addFields.title.value.trim()
  if (!title) { svcUi.showToast('请输入任务名称'); return }
  const payload = {
    title,
    category: svcWidgets.getSwatchCategory(addFields.swatches),
    tags: svcWidgets.parseTagInput(addFields.tags.value),
  }
  if (editingTaskId) {
    const updated = svcTimers.updateInProgressTask(editingTaskId, payload, { base: editingBase })
    if (!updated) return
    if (svcStorage.store.mode === 'indexeddb') {
      try { await svcStorage.store.flush() } catch { return }
    }
    svcUi.closeDialog(addDlg)
    refresh('✅ 已更新任务信息')
    return
  }
  svcTimers.startInProgressTask(payload)
  svcUi.closeDialog(addDlg)
  refresh('⏱️ 已开始计时')
}

svcUi.bindDialog(addDlg, { onClose: () => { editingTaskId = null } })
svcWidgets.bindCategorySwatches(addFields.swatches, updateCategoryTags)
addFields.sugs.addEventListener('click', e => {
  const chip = e.target.closest('.tb-tag-chip')
  if (chip) appendTagToInput(chip.dataset.tag)
})
addFields.search.addEventListener('input', () => {
  addFields.error.classList.remove('is-visible')
  renderTagSuggestions()
})
$('#ip-tag-add-btn').addEventListener('click', () => {
  const val = addFields.search.value.trim()
  if (!val) { showTagError(); return }
  svcScheduleTags.registerNewTag(val, selectedCategory().key)
  appendTagToInput(val)
  addFields.search.value = ''
  updateCategoryTags()
})
$('#ip-add-cancel').addEventListener('click', () => svcUi.closeDialog(addDlg))
$('#ip-add-save').addEventListener('click', saveTaskFromModal)

// ── 弹窗 2：时间调整面板 (#ip-settle-modal) ─────────
const settleDlg = $('#ip-settle-modal')
const settleFields = {
  title:    $('#ip-settle-title'),
  tags:     $('#ip-settle-tags'),
  total:    $('#ip-settle-total'),
  segments: $('#ip-settle-segments'),
}
let settleCtx = null // { taskId, segments: [] }

function openSettleModal(taskId) {
  const snapshot = svcTimers.loadTimerEditor()
  const task = snapshot.items.find(t => t.id === taskId)
  if (!task) return

  const now = Date.now()
  const curHm = nowHm(new Date(now))
  const segments = task.segments.map(s => {
    const segment = { ...s, startHm: s.startHm || curHm, endHm: s.endHm || curHm }
    const bounds = svcDates.timerSegmentBounds(segment, task.date)
    return {
      ...segment,
      date: bounds ? svcDates.dateKey(new Date(bounds.startAt)) : task.date,
      endDate: bounds ? svcDates.dateKey(svcDates.addDays(new Date(bounds.endAt), segment.endHm === '24:00' ? -1 : 0)) : task.date,
    }
  })
  if (segments.length === 0) segments.push({ date: task.date, endDate: task.date,
    startHm: curHm, endHm: curHm, manualEdited: true })

  const rawTotalH = task.status === 'completed' && task.finalHours != null
    ? task.finalHours
    : calcSegmentsTotalHours(segments, now)
  // 不足 1 分钟的有效计时按 1 分钟展示，避免显示为 00:00
  const initTotalH = rawTotalH > 0 && rawTotalH < 1 / 60 ? 1 / 60 : rawTotalH

  settleCtx = { base: snapshot.base, taskId: task.id, segments, originalTotal: rawTotalH, initialDisplay: fmtDuration(initTotalH) }
  settleFields.title.value = task.title
  settleFields.tags.value = task.tags.join(', ')
  settleFields.total.value = settleCtx.initialDisplay
  renderSettleSegments()
  svcUi.openDialog(settleDlg)
}

function recalcTotalFromSegments() {
  settleCtx.initialDisplay = null
  settleFields.total.value = fmtDuration(calcSegmentsTotalHours(settleCtx.segments))
}

function renderSettleSegments() {
  const segs = settleCtx.segments
  svcDom.setHTML(settleFields.segments, html`${segs.map((seg, idx) => html`
    <div class="ip-settle-seg-row">
      <span class="ip-settle-seg-label" title="${seg.date} 至 ${seg.endDate}">第 ${idx + 1} 段 · ${seg.date.slice(5)}</span>
      <input type="text" class="ip-settle-time-input" data-seg-field="startHm" data-seg-idx="${idx}" value="${seg.startHm}"
        readonly aria-label="第 ${idx + 1} 段开始时间" title="点击修改开始时间" />
      <span class="ip-settle-seg-sep" aria-hidden="true">—</span>
      <input type="text" class="ip-settle-time-input" data-seg-field="endHm" data-seg-idx="${idx}" value="${seg.endHm}"
        readonly aria-label="第 ${idx + 1} 段结束时间" title="点击修改结束时间" />
      <span class="ip-settle-seg-dur">${fmtH(calcSegmentHours(seg))}</span>
      ${segs.length > 1 ? html`<button type="button" class="ip-settle-seg-del" data-seg-del="${idx}"
        title="删除此时间段" aria-label="删除第 ${idx + 1} 段">×</button>` : ''}
    </div>`)}`)
}

function updateSegments() {
  renderSettleSegments()
  recalcTotalFromSegments()
}

async function saveSettleModal() {
  if (!settleCtx) return
  const finalHours = settleFields.total.value === settleCtx.initialDisplay
    ? settleCtx.originalTotal : svcDates.parseDuration(settleFields.total.value)
  if (finalHours == null || finalHours > svcMetadata.MAX_TIMER_HOURS) { svcUi.showToast('请输入有效累计时长，单项最多 366 天'); return }
  const updated = svcTimers.settleInProgressTask(settleCtx.taskId, {
    title: settleFields.title.value.trim(),
    tags: svcWidgets.parseTagInput(settleFields.tags.value),
    segments: settleCtx.segments,
    finalHours,
  }, { base: settleCtx.base })
  if (!updated) return
  if (svcStorage.store.mode === 'indexeddb') {
      try { await svcStorage.store.flush() } catch { return }
    }
  svcUi.closeDialog(settleDlg)
  refresh(updated.tags.length > 0
    ? `✅ 已更新量化时间 (${fmtH(updated.finalHours)})`
    : `✅ 已更新本地计时 (${fmtH(updated.finalHours)})`)
}

svcUi.bindDialog(settleDlg, { onClose: () => { settleCtx = null } })

settleFields.segments.addEventListener('click', e => {
  if (!settleCtx) return
  const delBtn = e.target.closest('[data-seg-del]')
  if (delBtn) {
    if (settleCtx.segments.length > 1) {
      settleCtx.segments.splice(Number(delBtn.dataset.segDel), 1)
      updateSegments()
    }
    return
  }
  const timeInp = e.target.closest('.ip-settle-time-input')
  if (!timeInp) return
  const idx = Number(timeInp.dataset.segIdx)
  const field = timeInp.dataset.segField
  const seg = settleCtx.segments[idx]
  if (!seg) return
  svcWheelPicker.pickClock(seg[field], {
    title: `第 ${idx + 1} 段 · ${field === 'startHm' ? '开始时间' : '结束时间'}`,
    onPick: (clock) => {
      if (!settleCtx) return
      seg[field] = clock
      seg.manualEdited = true
      updateSegments()
    },
  })
})

$('#ip-settle-add-seg').addEventListener('click', () => {
  if (!settleCtx) return
  const now = Date.now()
  const curHm = nowHm(new Date(now))
  const date = svcDates.dateKey(new Date(now))
  settleCtx.segments.push({ date, endDate: date, startHm: curHm, endHm: curHm, manualEdited: true })
  updateSegments()
})

$('#ip-settle-cancel').addEventListener('click', () => svcUi.closeDialog(settleDlg))
$('#ip-settle-save').addEventListener('click', saveSettleModal)

// ── 暴露接口 ──────────────────────────────────────────
svcTimerView.renderInProgress  = renderInProgress
svcTimerView.openInProgressAdd = openAddModal
