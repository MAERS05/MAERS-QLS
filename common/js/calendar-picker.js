import { metadata as svcMetadata } from './core.js'
import { dates as svcDates } from './date-utils.js'
import { dom as svcDom } from './dom.js'
import { repeatRules as svcRepeatRules } from './repeat-rules.js'
import { storage as svcStorage } from './store.js'
import { ui as svcUi } from './ui.js'

const svcCalendarPicker = {}
export const calendarPicker = svcCalendarPicker

/**
 * MAERS QLS — 统一手账日历弹窗组件 (common/js/calendar-picker.js)
 * 职责：为全系统（QuantiLife 记录页、统计报告页、Schedule 规划表与任务弹窗）提供唯一日历选择器。
 * 基于原生模态 <dialog>：可叠加在其他模态弹窗之上，原生支持 Esc 关闭与焦点管理。
 */
const html = svcDom.html

let state = null

const REPEAT_UNITS = [
  { key: 'day',   label: '天' },
  { key: 'week',  label: '周' },
  { key: 'month', label: '月' },
  { key: 'year',  label: '年' },
]
const WEEK_LABELS = ['一', '二', '三', '四', '五', '六', '日']
const matchesRepeatRule = svcRepeatRules.matchesRepeatRule
const formatRepeatSummary = svcRepeatRules.formatRepeatSummary

/** 默认数据标记：QuantiLife 当日记录或 Schedule 当日时间块存在即标记（每次渲染仅解析一次存储） */
function createDefaultHasData() {
  const blocks = svcStorage.store.get(svcMetadata.TIMEBLOCK_KEY, {}) || {}
  const repeats = Array.isArray(blocks._repeats) ? blocks._repeats : []
  return (dateStr) =>
    svcStorage.store.has(svcMetadata.QL_PREFIX + dateStr) ||
    (Array.isArray(blocks[dateStr]) && blocks[dateStr].length > 0) ||
    repeats.some(r => r && matchesRepeatRule(r.repeat, dateStr, r))
}

function ensureCalendarDOM() {
  if (state) return state

  const dlg = document.createElement('dialog')
  dlg.className = 'calendar-dialog'
  dlg.id = 'qls-calendar'
  dlg.setAttribute('aria-label', '选择日期')
  svcDom.setHTML(dlg, html`
    <div class="calendar-popup">
      <div class="cal-mode-switch" id="qls-cal-mode-switch" role="group" aria-label="日期选择模式" hidden>
        <button type="button" class="cal-mode-btn active" data-cal-mode="single" aria-pressed="true">单日</button>
        <button type="button" class="cal-mode-btn" data-cal-mode="range" aria-pressed="false">跨日</button>
        <button type="button" class="cal-mode-btn" data-cal-mode="multi" aria-pressed="false">多日</button>
        <button type="button" class="cal-mode-btn" data-cal-mode="repeat" aria-pressed="false">重复</button>
      </div>
      <div class="cal-grid-view" id="qls-cal-grid-view">
        <div class="cal-header">
          <button type="button" id="qls-cal-prev-month" aria-label="上个月">‹</button>
          <div class="cal-title-group">
            <input class="cal-num-input cal-year" id="qls-cal-year" type="number" min="1900" max="2199" aria-label="年" />
            <span class="cal-label" aria-hidden="true">年</span>
            <input class="cal-num-input cal-month" id="qls-cal-month" type="number" min="1" max="12" aria-label="月" />
            <span class="cal-label" aria-hidden="true">月</span>
            <input class="cal-num-input cal-day-input" id="qls-cal-day-input" type="number" min="1" max="31" placeholder="—" aria-label="日" />
            <span class="cal-label" aria-hidden="true">日</span>
          </div>
          <button type="button" id="qls-cal-next-month" aria-label="下个月">›</button>
        </div>
        <div class="cal-weekdays" aria-hidden="true">
          ${WEEK_LABELS.map(d => html`<span>${d}</span>`)}
        </div>
        <div class="cal-days" id="qls-cal-days"></div>
      </div>
      <div class="cal-repeat-view" id="qls-cal-repeat-view" hidden>
        <div class="cal-repeat-section">
          <div class="cal-repeat-title">频率</div>
          <div class="cal-freq-picker">
            <div class="cal-freq-band" aria-hidden="true"></div>
            <div class="cal-freq-col cal-freq-static" aria-hidden="true">
              <div class="cal-freq-item is-center">每</div>
            </div>
            <div class="cal-freq-col" id="qls-cal-freq-num" tabindex="0" role="spinbutton" aria-label="重复间隔" aria-valuemin="1" aria-valuemax="99" aria-valuenow="1"></div>
            <div class="cal-freq-col" id="qls-cal-freq-unit" tabindex="0" role="spinbutton" aria-label="重复单位"></div>
          </div>
        </div>
        <div class="cal-repeat-section">
          <div class="cal-repeat-title">周期</div>
          <div class="cal-repeat-cycle" id="qls-cal-repeat-cycle"></div>
        </div>
      </div>
      <div class="cal-selection-summary" id="qls-cal-summary" hidden aria-live="polite"></div>
      <div class="cal-footer">
        <button type="button" class="cal-today-btn" id="qls-cal-today-btn" title="回到今天">今</button>
        <button type="button" class="cal-clear-btn" id="qls-cal-clear-btn" hidden title="清空日期">清空</button>
        <button type="button" class="cal-confirm-btn" id="qls-cal-confirm-btn" hidden>完成</button>
      </div>
    </div>
  `)
  document.body.appendChild(dlg)

  state = {
    dlg,
    selectedDate: new Date(),
    hasSelected: true,
    viewDate: new Date(),
    enableMulti: false,
    mode: 'single',
    rangeStart: '',
    rangeEnd: '',
    rangePickingEnd: false,
    multiDates: new Set(),
    repeatInterval: 1,
    repeatUnit: 'day',
    repeatWeekDays: new Set([1]),
    repeatMonthDays: new Set([1]),
    repeatYearMonths: new Set([1]),
    onSelect: null,
    hasDataFn: null,
    gridViewEl: dlg.querySelector('#qls-cal-grid-view'),
    repeatViewEl: dlg.querySelector('#qls-cal-repeat-view'),
    freqNumEl: dlg.querySelector('#qls-cal-freq-num'),
    freqUnitEl: dlg.querySelector('#qls-cal-freq-unit'),
    repeatCycleEl: dlg.querySelector('#qls-cal-repeat-cycle'),
    yearEl: dlg.querySelector('#qls-cal-year'),
    monthEl: dlg.querySelector('#qls-cal-month'),
    dayEl: dlg.querySelector('#qls-cal-day-input'),
    daysEl: dlg.querySelector('#qls-cal-days'),
    summaryEl: dlg.querySelector('#qls-cal-summary'),
    modeSwitchEl: dlg.querySelector('#qls-cal-mode-switch'),
    todayEl: dlg.querySelector('#qls-cal-today-btn'),
    clearEl: dlg.querySelector('#qls-cal-clear-btn'),
    confirmEl: dlg.querySelector('#qls-cal-confirm-btn'),
  }

  svcUi.bindDialog(dlg, {
    onClose: () => {
      state.onSelect = null
    },
  })

  /** 展开起止日期区间为升序日期键数组（最多 366 天） */
  function expandDateRange(startStr, endStr) {
    const a = startStr <= endStr ? startStr : endStr
    const b = startStr <= endStr ? endStr : startStr
    const startDate = svcDates.parseDateKey(a)
    const endDate = svcDates.parseDateKey(b)
    if (!startDate || !endDate) return a ? [a] : []
    const out = []
    let cur = startDate
    while (cur <= endDate && out.length < 366) {
      out.push(svcDates.dateKey(cur))
      cur = svcDates.addDays(cur, 1)
    }
    return out
  }

  /** 关闭弹窗后回调选择结果（先取出回调，避免 close 清理后丢失） */
  function commit(pickedDate, meta = null) {
    const cb = state.onSelect
    svcUi.closeDialog(dlg)
    if (!cb) return
    const dateStr = pickedDate ? svcDates.dateKey(pickedDate) : ''
    const resolvedMeta = meta || { mode: 'single', dates: dateStr ? [dateStr] : [] }
    cb(pickedDate, dateStr, resolvedMeta)
  }

  function buildRepeatConfig() {
    return {
      unit: state.repeatUnit,
      interval: state.repeatInterval,
      baseDate: svcDates.dateKey(state.selectedDate),
      weekDays: [...state.repeatWeekDays].sort((a, b) => a - b),
      monthDays: [...state.repeatMonthDays].sort((a, b) => (a === 'last' ? 99 : a) - (b === 'last' ? 99 : b)),
      yearMonths: [...state.repeatYearMonths].sort((a, b) => a - b),
    }
  }

  function seedRepeatFromDate(d, prevRepeat = null) {
    const isoDay = d.getDay() === 0 ? 7 : d.getDay()
    const dom = d.getDate()
    const mon = d.getMonth() + 1
    state.repeatInterval = Math.max(1, Math.min(99, Number(prevRepeat?.interval) || 1))
    state.repeatUnit = REPEAT_UNITS.some(u => u.key === prevRepeat?.unit) ? prevRepeat.unit : 'day'
    state.repeatWeekDays = new Set(Array.isArray(prevRepeat?.weekDays) && prevRepeat.weekDays.length ? prevRepeat.weekDays : [isoDay])
    state.repeatMonthDays = new Set(Array.isArray(prevRepeat?.monthDays) && prevRepeat.monthDays.length ? prevRepeat.monthDays : [dom])
    state.repeatYearMonths = new Set(Array.isArray(prevRepeat?.yearMonths) && prevRepeat.yearMonths.length ? prevRepeat.yearMonths : [mon])
  }
  state.seedRepeat = seedRepeatFromDate

  const FREQ_ITEM_H = 30
  const FREQ_PAD = 1
  const FREQ_NUM_ITEMS = Array.from({ length: 99 }, (_, i) => ({ val: i + 1, label: String(i + 1) }))
  const FREQ_UNIT_ITEMS = REPEAT_UNITS.map(u => ({ val: u.key, label: u.label }))

  function normWheelScroll(s, span) {
    return span + (((s - span) % span + span) % span)
  }

  function loopWheelScroll(col) {
    const items = col._items
    if (!items || !items.length) return
    const span = items.length * FREQ_ITEM_H
    if (col.scrollTop < span || col.scrollTop >= span * 2) {
      col.scrollTop = normWheelScroll(col.scrollTop, span)
    }
  }

  function getWheelTop(col) {
    return col._animTarget ?? (col.scrollTop > 0 ? col.scrollTop : (col._initScroll ?? 0))
  }

  function getWheelSelected(col) {
    const items = col._items
    if (!items || !items.length) return null
    const top = getWheelTop(col)
    const idx = Math.round(top / FREQ_ITEM_H) % items.length
    return items[(idx + items.length) % items.length]
  }

  function updateWheelHighlight(col, emit = true) {
    const centerIdx = Math.round(getWheelTop(col) / FREQ_ITEM_H)
    col.querySelectorAll('.cal-freq-item:not(.cal-freq-pad)').forEach((el, i) => {
      const dist = Math.abs(i - centerIdx)
      el.classList.toggle('is-center', dist === 0)
      el.classList.toggle('is-near', dist === 1)
    })
    const sel = getWheelSelected(col)
    if (sel) {
      col.setAttribute('aria-valuenow', String(sel.val))
      col.setAttribute('aria-valuetext', sel.label)
      if (emit) col._onSelect?.(sel.val)
    }
  }

  function fillFreqWheel(col, items, selectedVal) {
    col._stopAnim?.()
    const triple = [...items, ...items, ...items]
    const pads = Array.from({ length: FREQ_PAD }, () => html`<div class="cal-freq-item cal-freq-pad"></div>`)
    svcDom.setHTML(col, html`${pads}${triple.map((it, i) => html`<div class="cal-freq-item" data-val="${it.val}" data-idx="${i}">${it.label}</div>`)}${pads}`)
    col._items = items
    const selIdx = items.findIndex(it => it.val === selectedVal)
    const targetScroll = (items.length + (selIdx >= 0 ? selIdx : 0)) * FREQ_ITEM_H
    col._initScroll = targetScroll
    col.scrollTop = targetScroll
    updateWheelHighlight(col, false)
  }

  function bindFreqWheel(col, onSelect) {
    col._onSelect = onSelect
    let pointerDown = false, dragging = false, justDragged = false
    let touchMoved = false
    let startY = 0, startScroll = 0, vel = 0, lastY = 0, lastT = 0, rafId = 0

    function stopAnim() {
      cancelAnimationFrame(rafId)
      col._animTarget = null
    }
    col._stopAnim = stopAnim

    function snapToNearest() {
      col.scrollTo({ top: Math.round(col.scrollTop / FREQ_ITEM_H) * FREQ_ITEM_H, behavior: 'smooth' })
    }

    function rollToIndex(idx) {
      const items = col._items
      if (!Number.isFinite(idx) || !items || !items.length) return
      stopAnim()
      const span = items.length * FREQ_ITEM_H
      const from = getWheelTop(col)
      const delta = idx * FREQ_ITEM_H - from
      if (Math.abs(delta) < 1) return
      const finalScroll = normWheelScroll(Math.round((from + delta) / FREQ_ITEM_H) * FREQ_ITEM_H, span)
      col._animTarget = finalScroll
      col._initScroll = finalScroll
      updateWheelHighlight(col, true)
      const duration = 180
      const startTime = performance.now()
      const step = (now) => {
        const t = Math.min(1, (now - startTime) / duration)
        const eased = 1 - Math.pow(1 - t, 3)
        if (t < 1) {
          col.scrollTop = Math.round(normWheelScroll(from + delta * eased, span))
          updateWheelHighlight(col, false)
          rafId = requestAnimationFrame(step)
        } else {
          col._animTarget = null
          col.scrollTop = finalScroll
          updateWheelHighlight(col, true)
        }
      }
      rafId = requestAnimationFrame(step)
    }
    col._stepBy = (delta) => {
      rollToIndex(Math.round(getWheelTop(col) / FREQ_ITEM_H) + delta)
    }

    col.addEventListener('scroll', () => {
      if (col.scrollTop > 0) col._initScroll = col.scrollTop
      loopWheelScroll(col)
      updateWheelHighlight(col, true)
    }, { passive: true })

    col.addEventListener('mousedown', e => {
      if (e.button !== 0) return
      stopAnim()
      pointerDown = true
      dragging = false
      justDragged = false
      startY = e.clientY
      startScroll = col.scrollTop
      vel = 0; lastY = e.clientY; lastT = Date.now()
      e.preventDefault()
    })

    document.addEventListener('mousemove', e => {
      if (!pointerDown) return
      const dy = e.clientY - startY
      if (!dragging && Math.abs(dy) > 4) dragging = true
      if (!dragging) return
      const now = Date.now()
      vel = (e.clientY - lastY) / (now - lastT + 1)
      lastY = e.clientY; lastT = now
      col.scrollTop = startScroll - dy
    })

    document.addEventListener('mouseup', () => {
      if (!pointerDown) return
      pointerDown = false
      if (!dragging) return
      dragging = false
      justDragged = true
      let v = vel * 12
      const momentum = () => {
        if (Math.abs(v) < 0.5) { snapToNearest(); return }
        col.scrollTop -= v
        v *= 0.92
        rafId = requestAnimationFrame(momentum)
      }
      rafId = requestAnimationFrame(momentum)
    })

    col.addEventListener('click', e => {
      if (justDragged) { justDragged = false; return }
      const item = e.target.closest('.cal-freq-item[data-idx]')
      if (!item) return
      rollToIndex(Number(item.dataset.idx))
      col.focus()
    })

    col.addEventListener('touchstart', e => {
      stopAnim()
      touchMoved = false
      startY = e.touches[0].clientY
      startScroll = col.scrollTop
    }, { passive: true })
    col.addEventListener('touchmove', e => {
      const dy = e.touches[0].clientY - startY
      if (Math.abs(dy) > 4) touchMoved = true
      col.scrollTop = startScroll - dy
    }, { passive: true })
    col.addEventListener('touchend', () => {
      if (touchMoved) snapToNearest()
    })

    col.addEventListener('keydown', e => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault()
        stopAnim()
        col.scrollTop = (Math.round(col.scrollTop / FREQ_ITEM_H) + (e.key === 'ArrowDown' ? 1 : -1)) * FREQ_ITEM_H
        loopWheelScroll(col)
        updateWheelHighlight(col)
      }
    })
  }

  function renderRepeatCycle() {
    const buildMonthDayGrid = () => html`
      <div class="cal-repeat-monthdays" role="group" aria-label="选择每月日期">
        ${Array.from({ length: 31 }, (_, i) => {
          const dNum = i + 1
          const on = state.repeatMonthDays.has(dNum)
          return html`<button type="button" class="cal-rep-day-btn${on ? ' selected' : ''}" data-rep-monthday="${dNum}" aria-pressed="${String(on)}">${dNum}</button>`
        })}
        <button type="button" class="cal-rep-day-btn cal-rep-last-btn${state.repeatMonthDays.has('last') ? ' selected' : ''}" data-rep-monthday="last" aria-pressed="${String(state.repeatMonthDays.has('last'))}">最后一天</button>
      </div>
    `

    if (state.repeatUnit === 'day') {
      state.repeatCycleEl.hidden = true
      svcDom.setHTML(state.repeatCycleEl, html``)
    } else if (state.repeatUnit === 'week') {
      state.repeatCycleEl.hidden = false
      svcDom.setHTML(state.repeatCycleEl, html`
        <div class="cal-repeat-weekdays" role="group" aria-label="选择星期">
          ${WEEK_LABELS.map((lbl, i) => {
            const iso = i + 1
            const on = state.repeatWeekDays.has(iso)
            return html`<button type="button" class="cal-rep-week-btn${on ? ' selected' : ''}" data-rep-weekday="${iso}" aria-pressed="${String(on)}">${lbl}</button>`
          })}
        </div>
      `)
    } else if (state.repeatUnit === 'month') {
      state.repeatCycleEl.hidden = false
      svcDom.setHTML(state.repeatCycleEl, buildMonthDayGrid())
    } else if (state.repeatUnit === 'year') {
      state.repeatCycleEl.hidden = false
      svcDom.setHTML(state.repeatCycleEl, html`
        <div class="cal-repeat-months" role="group" aria-label="选择月份">
          ${Array.from({ length: 12 }, (_, i) => {
            const mNum = i + 1
            const on = state.repeatYearMonths.has(mNum)
            return html`<button type="button" class="cal-rep-month-btn${on ? ' selected' : ''}" data-rep-month="${mNum}" aria-pressed="${String(on)}">${mNum}月</button>`
          })}
        </div>
        ${buildMonthDayGrid()}
      `)
    }
    updateSummary()
  }

  function renderRepeatView() {
    fillFreqWheel(state.freqNumEl, FREQ_NUM_ITEMS, state.repeatInterval)
    fillFreqWheel(state.freqUnitEl, FREQ_UNIT_ITEMS, state.repeatUnit)
    renderRepeatCycle()
  }

  /** 确认当前模式下的选择结果 */
  function confirmCurrentSelection() {
    if (state.mode === 'repeat') {
      const repeat = buildRepeatConfig()
      commit(state.selectedDate, { mode: 'repeat', dates: [repeat.baseDate], repeat })
      return
    }
    if (state.mode === 'range') {
      const s = state.rangeStart || svcDates.dateKey(state.selectedDate)
      const e = state.rangeEnd || s
      const dates = expandDateRange(s, e)
      const first = svcDates.parseDateKey(dates[0])
      commit(first, { mode: 'range', dates })
      return
    }
    if (state.mode === 'multi') {
      const dates = [...state.multiDates].sort()
      if (dates.length === 0) {
        const fallback = svcDates.dateKey(state.selectedDate)
        dates.push(fallback)
      }
      const first = svcDates.parseDateKey(dates[0])
      commit(first, { mode: dates.length > 1 ? 'multi' : 'single', dates })
      return
    }
    commit(state.hasSelected ? state.selectedDate : new Date())
  }

  /** 切换单日 / 跨日 / 多日 / 重复模式 */
  function setMode(nextMode) {
    if (!['single', 'range', 'multi', 'repeat'].includes(nextMode)) return
    state.mode = nextMode
    const curStr = svcDates.dateKey(state.selectedDate)
    if (nextMode === 'range') {
      if (!state.rangeStart) state.rangeStart = curStr
      if (!state.rangeEnd) state.rangeEnd = state.rangeStart
      state.rangePickingEnd = state.rangeStart === state.rangeEnd
    } else if (nextMode === 'multi') {
      if (state.multiDates.size === 0 && curStr) state.multiDates.add(curStr)
    }
    syncModeUI()
    if (nextMode === 'repeat') renderRepeatView()
    else renderDays()
  }

  function syncModeUI() {
    const isRepeat = state.enableMulti && state.mode === 'repeat'
    state.modeSwitchEl.hidden = !state.enableMulti
    state.gridViewEl.hidden = isRepeat
    state.repeatViewEl.hidden = !isRepeat
    state.todayEl.hidden = isRepeat
    state.confirmEl.hidden = !state.enableMulti || state.mode === 'single'
    state.modeSwitchEl.querySelectorAll('.cal-mode-btn[data-cal-mode]').forEach(btn => {
      const active = btn.dataset.calMode === state.mode
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-pressed', String(active))
    })
    updateSummary()
  }

  function fmtShortMD(dateStr) {
    const [, m, d] = String(dateStr || '').split('-')
    return m && d ? `${Number(m)}月${Number(d)}日` : dateStr
  }

  function updateSummary() {
    if (!state.enableMulti || state.mode === 'single') {
      state.summaryEl.hidden = true
      state.summaryEl.textContent = ''
      return
    }
    state.summaryEl.hidden = false
    if (state.mode === 'repeat') {
      state.summaryEl.textContent = formatRepeatSummary(buildRepeatConfig())
    } else if (state.mode === 'range') {
      const s = state.rangeStart || svcDates.dateKey(state.selectedDate)
      const e = state.rangeEnd || s
      const dates = expandDateRange(s, e)
      state.summaryEl.textContent = dates.length > 1
        ? `跨日范围：${fmtShortMD(dates[0])} — ${fmtShortMD(dates[dates.length - 1])}（共 ${dates.length} 天）`
        : `跨日起点：${fmtShortMD(s)}（请点击结束日期）`
    } else if (state.mode === 'multi') {
      const dates = [...state.multiDates].sort()
      state.summaryEl.textContent = dates.length > 0
        ? `已选 ${dates.length} 天：${dates.map(fmtShortMD).join('、')}`
        : '请点击选择多个日期'
    }
  }

  function handleDaySelect(ds) {
    const picked = svcDates.parseDateKey(ds)
    if (!picked) return
    state.selectedDate = picked
    state.hasSelected = true

    if (!state.enableMulti || state.mode === 'single') {
      commit(picked, { mode: 'single', dates: [ds] })
      return
    }

    if (state.mode === 'range') {
      if (!state.rangeStart || !state.rangePickingEnd) {
        state.rangeStart = ds
        state.rangeEnd = ds
        state.rangePickingEnd = true
      } else {
        if (ds < state.rangeStart) {
          state.rangeEnd = state.rangeStart
          state.rangeStart = ds
        } else {
          state.rangeEnd = ds
        }
        state.rangePickingEnd = false
      }
      updateSummary()
      renderDays()
      return
    }

    if (state.mode === 'multi') {
      if (state.multiDates.has(ds)) {
        if (state.multiDates.size > 1) state.multiDates.delete(ds)
      } else {
        state.multiDates.add(ds)
      }
      updateSummary()
      renderDays()
    }
  }

  function handleYearMonthChange() {
    const y = parseInt(state.yearEl.value, 10)
    const m = parseInt(state.monthEl.value, 10)
    if (y >= 1900 && y <= 2199 && m >= 1 && m <= 12) {
      state.viewDate = new Date(y, m - 1, 1)
      renderDays()
    }
  }

  function commitDayInput() {
    const y = parseInt(state.yearEl.value, 10)
    const m = parseInt(state.monthEl.value, 10)
    const d = parseInt(state.dayEl.value, 10)
    if (!d) return
    const picked = svcDates.parseDateKey(`${y}-${m}-${d}`)
    if (picked && y >= 1900 && y <= 2199) handleDaySelect(svcDates.dateKey(picked))
  }

  state.yearEl.addEventListener('change', handleYearMonthChange)
  state.monthEl.addEventListener('change', handleYearMonthChange)
  ;[state.yearEl, state.monthEl].forEach(el => {
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); handleYearMonthChange() }
    })
  })
  state.dayEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); commitDayInput() }
  })

  // 日期格子事件委托
  state.daysEl.addEventListener('click', e => {
    const btn = e.target.closest('[data-date]')
    if (btn) handleDaySelect(btn.dataset.date)
  })

  // 模式切换（单日 / 跨日 / 多日 / 重复）
  state.modeSwitchEl.addEventListener('click', e => {
    const btn = e.target.closest('.cal-mode-btn[data-cal-mode]')
    if (btn) setMode(btn.dataset.calMode)
  })

  // 重复视图：与时间选择器一致的无限循环滚轮
  bindFreqWheel(state.freqNumEl, val => {
    const next = Number(val)
    if (next && next !== state.repeatInterval) {
      state.repeatInterval = next
      updateSummary()
    }
  })
  bindFreqWheel(state.freqUnitEl, val => {
    if (val && val !== state.repeatUnit) {
      state.repeatUnit = val
      renderRepeatCycle()
    }
  })

  // 重复视图：周期点选（至少保留一项）
  state.repeatCycleEl.addEventListener('click', e => {
    const wBtn = e.target.closest('[data-rep-weekday]')
    if (wBtn) {
      const val = Number(wBtn.dataset.repWeekday)
      if (state.repeatWeekDays.has(val)) {
        if (state.repeatWeekDays.size > 1) state.repeatWeekDays.delete(val)
      } else {
        state.repeatWeekDays.add(val)
      }
      renderRepeatCycle()
      return
    }
    const mBtn = e.target.closest('[data-rep-month]')
    if (mBtn) {
      const val = Number(mBtn.dataset.repMonth)
      if (state.repeatYearMonths.has(val)) {
        if (state.repeatYearMonths.size > 1) state.repeatYearMonths.delete(val)
      } else {
        state.repeatYearMonths.add(val)
      }
      renderRepeatCycle()
      return
    }
    const dBtn = e.target.closest('[data-rep-monthday]')
    if (dBtn) {
      const raw = dBtn.dataset.repMonthday
      const val = raw === 'last' ? 'last' : Number(raw)
      if (state.repeatMonthDays.has(val)) {
        if (state.repeatMonthDays.size > 1) state.repeatMonthDays.delete(val)
      } else {
        state.repeatMonthDays.add(val)
      }
      renderRepeatCycle()
    }
  })

  dlg.querySelector('#qls-cal-prev-month').addEventListener('click', () => {
    state.viewDate.setMonth(state.viewDate.getMonth() - 1)
    renderDays()
  })
  dlg.querySelector('#qls-cal-next-month').addEventListener('click', () => {
    state.viewDate.setMonth(state.viewDate.getMonth() + 1)
    renderDays()
  })
  dlg.querySelector('#qls-cal-today-btn').addEventListener('click', () => {
    const todayKey = svcDates.today()
    const todayDate = svcDates.parseDateKey(todayKey)
    state.viewDate = new Date(todayDate.getFullYear(), todayDate.getMonth(), 1)
    handleDaySelect(todayKey)
  })
  state.clearEl.addEventListener('click', () => commit(null, { mode: 'single', dates: [] }))
  state.confirmEl.addEventListener('click', confirmCurrentSelection)

  return state
}

function renderDays() {
  const year = state.viewDate.getFullYear()
  const month = state.viewDate.getMonth()
  state.yearEl.value = year
  state.monthEl.value = month + 1
  state.dayEl.value = state.hasSelected ? state.selectedDate.getDate() : ''

  const firstDay = new Date(year, month, 1).getDay()
  const startOffset = firstDay === 0 ? 6 : firstDay - 1
  const gridStart = new Date(year, month, 1 - startOffset)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7

  const todayStr = svcDates.today()
  const selectedStr = state.hasSelected ? svcDates.dateKey(state.selectedDate) : ''
  const hasData = state.hasDataFn || createDefaultHasData()

  const isRange = state.enableMulti && state.mode === 'range'
  const isMulti = state.enableMulti && state.mode === 'multi'
  const rMin = isRange ? (state.rangeStart <= state.rangeEnd ? state.rangeStart : state.rangeEnd) : ''
  const rMax = isRange ? (state.rangeStart <= state.rangeEnd ? state.rangeEnd : state.rangeStart) : ''

  const cells = Array.from({ length: totalCells }, (_, i) => {
    const d = svcDates.addDays(gridStart, i)
    const ds = svcDates.dateKey(d)
    const isSelected = isRange
      ? (ds === rMin || ds === rMax)
      : isMulti
      ? state.multiDates.has(ds)
      : ds === selectedStr
    const inRange = isRange && rMin && rMax && ds > rMin && ds < rMax
    const isRangeStart = isRange && rMin && rMax && rMin !== rMax && ds === rMin
    const isRangeEnd = isRange && rMin && rMax && rMin !== rMax && ds === rMax

    const cls = [
      'cal-day',
      d.getMonth() !== month && 'other-month',
      ds === todayStr && 'today',
      isSelected && 'selected',
      inRange && 'in-range',
      isRangeStart && 'range-start',
      isRangeEnd && 'range-end',
      hasData(ds) && 'has-data',
    ].filter(Boolean).join(' ')
    return html`<button type="button" class="${cls}" data-date="${ds}"
      aria-label="${svcDates.formatDateCN(d)}" aria-pressed="${String(isSelected)}"
      ${ds === todayStr ? html`aria-current="date"` : ''}>${d.getDate()}</button>`
  })
  svcDom.setHTML(state.daysEl, html`${cells}`)
}

/**
 * 打开日历弹窗
 * @param {object} opts
 * @param {Date|string} [opts.date]        初始日期（空值表示未选择）
 * @param {boolean}     [opts.enableMulti] 是否开启跨日/多日模式切换
 * @param {string}      [opts.mode]        初始选择模式（'single' | 'range' | 'multi'）
 * @param {string[]}    [opts.dates]       初始已选日期列表
 * @param {Element}     [opts.anchorEl]    桌面端定位锚点
 * @param {boolean}     [opts.allowClear]  是否显示「清空」
 * @param {(dateStr: string) => boolean} [opts.hasDataFn] 自定义数据标记判断
 * @param {(date: Date|null, dateStr: string, meta: { mode: string, dates: string[] }) => void} [opts.onSelect]
 */
svcCalendarPicker.openCalendarPicker = ({ date, enableMulti = false, mode = 'single', dates = [], repeat = null, anchorEl, allowClear = false, hasDataFn, onSelect } = {}) => {
  const st = ensureCalendarDOM()
  const cleanDates = Array.isArray(dates)
    ? dates.map(d => svcDates.normalizeDateKey(d)).filter(Boolean).sort()
    : []
  const initDate = cleanDates[0] || date
  const parsed = svcDates.parseDateKey(initDate) || svcDates.parseDateKey(svcDates.today())
  const parsedKey = svcDates.dateKey(parsed)

  st.selectedDate = parsed
  st.hasSelected = !!(initDate && (initDate instanceof Date || String(initDate).trim() !== ''))
  st.viewDate = new Date(parsed.getFullYear(), parsed.getMonth(), 1)
  st.enableMulti = !!enableMulti
  st.mode = enableMulti && ['single', 'range', 'multi', 'repeat'].includes(mode) ? mode : 'single'
  st.rangeStart = cleanDates[0] || parsedKey
  st.rangeEnd = cleanDates[cleanDates.length - 1] || st.rangeStart
  st.rangePickingEnd = st.rangeStart === st.rangeEnd
  st.multiDates = new Set(cleanDates.length ? cleanDates : [parsedKey])
  st.seedRepeat(parsed, repeat)
  st.onSelect = onSelect || null
  st.hasDataFn = hasDataFn || null
  st.clearEl.hidden = !allowClear

  // 桌面端锚定目标正下方，移动端由 CSS 居中
  const dlg = st.dlg
  if (anchorEl && window.innerWidth > 768) {
    const rect = anchorEl.getBoundingClientRect()
    const popupW = 320
    const popupH = st.enableMulti ? 380 : 340
    const centerX = svcMetadata.clamp(rect.left + rect.width / 2, popupW / 2 + 12, window.innerWidth - popupW / 2 - 12)
    let topY = rect.bottom + 10
    if (topY + popupH > window.innerHeight - 12) topY = Math.max(12, rect.top - popupH - 10)
    dlg.style.left = `${Math.round(centerX)}px`
    dlg.style.top = `${Math.round(topY)}px`
  } else {
    dlg.style.left = ''
    dlg.style.top = ''
  }

  // 先打开 <dialog> 以完成布局，再渲染模式视图与滚轮 scrollTop，防止隐藏态下 scrollTop 归零
  renderDays()
  svcUi.openDialog(dlg)
  st.modeSwitchEl.querySelector(`.cal-mode-btn[data-cal-mode="${st.mode}"]`)?.click()
  if (!st.enableMulti) {
    st.modeSwitchEl.hidden = true
    st.confirmEl.hidden = true
    st.summaryEl.hidden = true
    st.summaryEl.textContent = ''
  }
  if (st.mode !== 'repeat') {
    ;(st.daysEl.querySelector('.selected') || st.daysEl.querySelector('.today'))?.focus()
  }
}

/** 将只读日期输入框绑定至统一手账日历弹窗 */
svcCalendarPicker.bindDateInput = (inputEl, { anchorEl, allowClear = false, enableMulti = false, hasDataFn, onChange } = {}) => {
  if (!inputEl || inputEl.dataset.calBound) return
  inputEl.dataset.calBound = '1'
  inputEl.addEventListener('click', () => {
    const prevDates = inputEl.dataset.selectedDates ? inputEl.dataset.selectedDates.split(',').filter(Boolean) : []
    const prevMode = inputEl.dataset.dateMode || 'single'
    let prevRepeat = null
    if (inputEl.dataset.repeatConfig) {
      try { prevRepeat = JSON.parse(inputEl.dataset.repeatConfig) } catch {}
    }
    svcCalendarPicker.openCalendarPicker({
      date: prevDates[0] || inputEl.value,
      enableMulti,
      mode: prevMode,
      dates: prevDates,
      repeat: prevRepeat,
      anchorEl: anchorEl || inputEl,
      allowClear,
      hasDataFn,
      onSelect: (pickedDate, dateStr, meta) => {
        inputEl.value = dateStr
        if (onChange) onChange(dateStr, pickedDate, meta)
      },
    })
  })
}
