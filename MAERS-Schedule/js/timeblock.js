import { scheduleMetadata as svcScheduleMetadata } from './shared.js'
import { timeblockEditor as svcTimeblockEditor } from './timeblock-editor.js'
import { timeblocks as svcTimeblocks } from './timeblock-service.js'
import { widgets as svcWidgets } from './widgets.js'
import { calendarPicker as svcCalendarPicker } from '../../common/js/calendar-picker.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { dom as svcDom } from '../../common/js/dom.js'

const svcTimeblockView = {}
export const timeblockView = svcTimeblockView

/**
 * MAERS Schedule — 周历时间块规划视图 (timeblock.js)
 * 职责：7 日周历时间块排程 + 右侧「期望」列 (ideal) 规划
 */
const html = svcDom.html
const fmtClock = svcDates.fmtClock

const HOUR_H = 144 // 每小时网格高度 (px)

const SEGMENTS = {
  all:   { label: '全', name: '全天',       start: 0,  end: 24 },
  dawn:  { label: '晨', name: '凌晨 0–6 点', start: 0,  end: 6  },
  morn:  { label: '早', name: '上午 6–12 点', start: 6,  end: 12 },
  noon:  { label: '中', name: '下午 12–18 点', start: 12, end: 18 },
  night: { label: '晚', name: '晚间 18–24 点', start: 18, end: 24 },
}

let viewStartDate = null
let activeSegments = new Set(['all'])
let isIdealOpen   = false
let showDetails   = false

const segmentKeys = () => Object.keys(SEGMENTS).filter(key => key !== 'all')
const visibleSegmentKeys = () => activeSegments.has('all') ? ['all'] : segmentKeys().filter(key => activeSegments.has(key))
const visibleRanges = () => {
  let offset = 0
  return visibleSegmentKeys().map(key => {
    const { start, end } = SEGMENTS[key]
    const range = { key, start, end, offset }
    offset += end - start
    return range
  })
}
const visibleHourCount = () => visibleRanges().reduce((total, range) => total + range.end - range.start, 0)
const hourAtViewOffset = (offset) => {
  const range = visibleRanges().find(item => offset >= item.offset && offset < item.offset + item.end - item.start)
  return range ? range.start + offset - range.offset : null
}
const slashDate = (d) => svcDates.dateKey(d).replace(/-/g, '/')

/** 获取以“今天”为正中心（第 4 列，左右各 3 天）的 7 天起始日期 */
function getCenteredStart() {
  return svcDates.addDays(svcDates.parseDateKey(svcDates.today()), -3)
}

/** 将“今天”列精准对齐到时间轴右侧可视区的正中央 */
function centerTodayColumn(wrapper, todayCol, smooth = false) {
  if (!wrapper || !todayCol) return
  const hourCol = wrapper.querySelector('.tb-hour-col')
  const hourColW = hourCol ? hourCol.offsetWidth : 48
  const visibleDayW = wrapper.clientWidth - hourColW
  const firstDayCol = wrapper.querySelector('.tb-day-col')
  const dayStartOffset = firstDayCol ? (todayCol.offsetLeft - firstDayCol.offsetLeft) : (todayCol.offsetLeft - hourColW)
  const targetLeft = dayStartOffset - (visibleDayW - todayCol.offsetWidth) / 2
  const maxScroll = Math.max(0, wrapper.scrollWidth - wrapper.clientWidth)
  const left = svcMetadata.clamp(Math.round(targetLeft), 0, maxScroll)
  if (smooth) wrapper.scrollTo({ left, behavior: 'smooth' })
  else wrapper.scrollLeft = left
}

// ── 列内容片段 ────────────────────────────────────────
function buildHourLines() {
  const ranges = visibleRanges()
  return Array.from({ length: visibleHourCount() - 1 }, (_, i) => {
    const offset = i + 1
    const isRangeBoundary = ranges.some(range => range.offset === offset)
    return html`<div class="tb-hour-line${isRangeBoundary ? ' tb-hour-line-range-break' : ''}" style="top:${offset * HOUR_H}px"></div>`
  })
}

function buildDayBody(dateStr) {
  const all = svcTimeblocks.loadBlocks(dateStr)
  // 详情项 = 默认会被折叠隐藏的块（被更长的块完整覆盖）；展开时需要保留其标记以绘制条纹
  const topLevelIds = new Set(svcTimeblocks.filterDetailBlocks(all, false).map(b => b.id))
  const blocks = svcTimeblocks.filterDetailBlocks(all, showDetails)
    .sort((a, b) => a.startH !== b.startH ? a.startH - b.startH : b.durationH - a.durationH)
  return html`${buildHourLines()}${blocks.map(b => renderBlock(b, !topLevelIds.has(b.id)))}`
}

/** 局部更新单日列内的时间块（不重建网格与导航栏） */
function updateColumnBlocks(container, dateStr) {
  const body = container?.querySelector(`.tb-day-body[data-date="${CSS.escape(dateStr)}"]`)
  if (body) svcDom.setHTML(body, buildDayBody(dateStr))
}

function refreshAllColumnBlocks(container) {
  container?.querySelectorAll('.tb-day-body[data-date]').forEach(body => {
    svcDom.setHTML(body, buildDayBody(body.dataset.date))
  })
}

// ── 渲染单个时间块 ────────────────────────────────────
function renderBlock(block, isDetail = false) {
  const blockEnd = block.startH + block.durationH
  return html`${visibleRanges().map(range => {
    if (block.startH >= range.end || blockEnd <= range.start) return ''
    const partStart = Math.max(block.startH, range.start)
    const partEnd = Math.min(blockEnd, range.end)
    const partDuration = partEnd - partStart
    const top = (range.offset + partStart - range.start) * HOUR_H
    const height = Math.max(partDuration * HOUR_H - 1, 2)
    const timeStr = `${fmtClock(partStart)}–${fmtClock(partEnd)}`
    const isShort = Math.round(partDuration * 60) < 20
    const tipTitle = block.notes ? `${block.label}  ${timeStr}\n${block.notes}` : `${block.label}  ${timeStr}`

    return html`
      <button type="button" class="tb-block${isShort ? ' tb-block-compact' : ''}${isDetail ? ' tb-block-detail' : ''}${block.missed ? ' missed' : ''}"
           data-block-id="${block.id}" data-block-notes="${block.notes || ''}" title="${tipTitle}"
           aria-label="${block.label}，${timeStr}${block.missed ? '，已遗漏' : ''}"
           style="top:${top}px;height:${height}px;--block-color:${svcScheduleMetadata.categoryMeta(block.category).color}">
        <span class="tb-block-label">${block.label}</span>
        <span class="${isShort ? 'tb-block-time-inline' : 'tb-block-time'}">${timeStr}</span>
      </button>`
  })}`
}

// ── 渲染周历网格列（保持顶部导航栏与滚动容器不销毁）────
function renderGridColumns(container, options = {}) {
  if (!viewStartDate) viewStartDate = getCenteredStart()
  const days = Array.from({ length: 7 }, (_, i) => svcDates.addDays(viewStartDate, i))
  const todayStr = svcDates.today()

  container.querySelector('#tb-start-date').textContent = slashDate(days[0])
  container.querySelector('#tb-end-date').textContent   = slashDate(days[6])
  syncToolbarState(container)

  const wrapper = container.querySelector('#tb-wrapper')
  if (!wrapper) return
  const savedScrollLeft = wrapper.scrollLeft
  const ranges = visibleRanges()
  const bodyHeight = visibleHourCount() * HOUR_H

  svcDom.setHTML(wrapper, html`
    <div class="tb-hour-col" aria-hidden="true">
      <div class="tb-header-cell"></div>
      ${ranges.map(range => Array.from({ length: range.end - range.start }, (_, i) =>
        html`<div class="tb-hour-label" style="height:${HOUR_H}px">${range.start + i}:00</div>`))}
    </div>

    ${days.map(day => {
      const dateStr = svcDates.dateKey(day)
      const isToday = dateStr === todayStr
      return html`
        <div class="tb-day-col${isToday ? ' today' : ''}" data-date="${dateStr}">
          <div class="tb-header-cell">
            <div class="tb-day-name">周${svcDates.WEEK_DAYS[day.getDay()]}</div>
            <div class="tb-day-date${isToday ? ' today' : ''}">${day.getDate()}</div>
          </div>
          <div class="tb-day-body" data-date="${dateStr}" style="height:${bodyHeight}px"
            aria-label="${svcDates.formatDateCN(day)}，点击空白处添加时间块">${buildDayBody(dateStr)}</div>
        </div>`
    })}

    <div class="tb-day-col tb-ideal-col${isIdealOpen ? '' : ' collapsed'}" data-date="ideal">
      <button type="button" class="tb-header-cell" id="tb-toggle-ideal" title="点击展开/收起期望表"
        aria-expanded="${String(isIdealOpen)}">
        <span class="tb-ideal-title">期望</span>
      </button>
      <div class="tb-day-body" data-date="ideal" style="height:${bodyHeight}px">${buildDayBody('ideal')}</div>
    </div>`)

  const todayCol = wrapper.querySelector('.tb-day-col.today')
  if (options.scrollToToday && todayCol) {
    centerTodayColumn(wrapper, todayCol, true)
  } else if (options.preserveScroll) {
    wrapper.scrollLeft = savedScrollLeft
  } else if (todayCol) {
    centerTodayColumn(wrapper, todayCol, false)
    requestAnimationFrame(() => centerTodayColumn(wrapper, todayCol, false))
  }
}

function syncToolbarState(container) {
  const detailBtn = container.querySelector('#tb-toggle-detail')
  detailBtn?.classList.toggle('active', showDetails)
  detailBtn?.setAttribute('aria-pressed', String(showDetails))
  container.querySelectorAll('.tb-seg-btn').forEach(btn => {
    const active = activeSegments.has(btn.dataset.seg)
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-pressed', String(active))
  })
}

// ── 挂载一次静态导航外壳与事件委托 ────────────────────
function ensureTimeblockShell(container) {
  if (container.querySelector('#tb-nav') && container.querySelector('#tb-wrapper')) return false
  if (!viewStartDate) viewStartDate = getCenteredStart()

  svcDom.setHTML(container, html`
    <div class="tb-nav" id="tb-nav">
      <div class="tb-nav-top">
        <div class="tb-date-pager" id="tb-date-pager">
          <button type="button" class="tb-nav-btn tb-arrow-btn" id="tb-prev" title="前移 7 天" aria-label="前移 7 天">‹</button>
          <div class="tb-week-label">
            <button type="button" id="tb-start-date" class="tb-date-input" title="选择开始日期"></button>
            <span class="tb-date-sep" aria-hidden="true">—</span>
            <button type="button" id="tb-end-date" class="tb-date-input" title="选择结束日期"></button>
          </div>
          <button type="button" class="tb-nav-btn tb-arrow-btn" id="tb-next" title="后移 7 天" aria-label="后移 7 天">›</button>
        </div>
        <div class="tb-quick-btns">
          <button type="button" class="tb-nav-btn tb-today-btn" id="tb-goto-today" title="回到今天并居中" aria-label="回到今天">今</button>
          <button type="button" class="tb-nav-btn tb-today-btn" id="tb-toggle-detail" title="显示/隐藏被更长时间块覆盖的块" aria-label="显示被更长时间块覆盖的块" aria-pressed="false"><span class="tb-btn-icon" aria-hidden="true"></span></button>
        </div>
      </div>
      <div class="tb-segment-tabs" role="group" aria-label="时段筛选">
        ${Object.entries(SEGMENTS).map(([key, seg]) =>
          html`<button type="button" class="tb-seg-btn" data-seg="${key}" title="${seg.name}" aria-label="${seg.name}" aria-pressed="false">${seg.label}</button>`)}
      </div>
    </div>
    <div class="tb-wrapper" id="tb-wrapper"></div>
    <div class="tb-detail-tip" id="tb-detail-tip" role="tooltip" hidden></div>`)

  const shiftWeek = (days) => {
    viewStartDate = svcDates.addDays(viewStartDate, days)
    renderGridColumns(container, { preserveScroll: true })
  }
  container.querySelector('#tb-prev').addEventListener('click', () => shiftWeek(-7))
  container.querySelector('#tb-next').addEventListener('click', () => shiftWeek(7))

  container.querySelector('#tb-goto-today').addEventListener('click', () => {
    const targetStart = getCenteredStart()
    const isSameWeek = svcDates.dateKey(viewStartDate) === svcDates.dateKey(targetStart)
    viewStartDate = targetStart
    const wrapper = container.querySelector('#tb-wrapper')
    const todayCol = wrapper?.querySelector('.tb-day-col.today')
    if (isSameWeek && todayCol) centerTodayColumn(wrapper, todayCol, true)
    else renderGridColumns(container, { scrollToToday: true })
  })

  // 起止日期按钮：选中日期分别作为 7 日窗口的首日或末日
  const pagerEl = container.querySelector('#tb-date-pager')
  const bindRangePicker = (btn, offsetFromStart) => {
    btn.addEventListener('click', () => {
      svcCalendarPicker.openCalendarPicker({
        date: svcDates.addDays(viewStartDate, offsetFromStart),
        anchorEl: pagerEl,
        onSelect: (picked) => {
          if (!picked) return
          viewStartDate = svcDates.addDays(picked, -offsetFromStart)
          renderGridColumns(container, { preserveScroll: true })
        },
      })
    })
  }
  bindRangePicker(container.querySelector('#tb-start-date'), 0)
  bindRangePicker(container.querySelector('#tb-end-date'), 6)

  // 「详」仅切换状态并局部刷新各列内的时间块，不重建导航栏或网格外框
  container.querySelector('#tb-toggle-detail').addEventListener('click', () => {
    showDetails = !showDetails
    syncToolbarState(container)
    refreshAllColumnBlocks(container)
  })

  container.querySelector('.tb-segment-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.tb-seg-btn')
    if (!btn) return
    const key = btn.dataset.seg
    if (key === 'all') {
      if (activeSegments.has('all')) return
      activeSegments = new Set(['all'])
    } else {
      if (activeSegments.has('all')) activeSegments = new Set()
      if (activeSegments.has(key)) activeSegments.delete(key)
      else activeSegments.add(key)
      if (activeSegments.size === 0) activeSegments.add('all')
    }
    renderGridColumns(container, { preserveScroll: true })
  })

  // 长按时间块显示完整名称与备注浮层（适配移动端无法 hover 的场景）
  const wrapper = container.querySelector('#tb-wrapper')
  const tipEl = container.querySelector('#tb-detail-tip')
  const { hideTip: hideDetailTip } = svcWidgets.bindLongPressTip(wrapper, {
    tipEl,
    itemSelector: '.tb-block[data-block-id]',
    preventContextOnItem: true,
    getText: blockEl => {
      const labelText = blockEl.querySelector('.tb-block-label')?.textContent || ''
      const notesText = blockEl.dataset.blockNotes || ''
      return notesText ? `${labelText}\n${notesText}` : labelText
    },
  })
  container.addEventListener('pointerdown', e => {
    if (!e.target.closest('#tb-wrapper')) hideDetailTip()
  })

  // 网格容器事件委托：点击「期望」列仅切换显示状态，不销毁重建 DOM
  wrapper.addEventListener('click', e => {
    hideDetailTip()

    const idealToggle = e.target.closest('#tb-toggle-ideal')
    if (idealToggle) {
      isIdealOpen = !isIdealOpen
      idealToggle.setAttribute('aria-expanded', String(isIdealOpen))
      const idealCol = wrapper.querySelector('.tb-ideal-col')
      idealCol?.classList.toggle('collapsed', !isIdealOpen)
      if (isIdealOpen) {
        requestAnimationFrame(() => {
          if (isIdealOpen) wrapper.scrollTo({ left: Math.max(0, wrapper.scrollWidth - wrapper.clientWidth), behavior: 'smooth' })
        })
      }
      return
    }

    const body = e.target.closest('.tb-day-body[data-date]')
    if (!body) return
    const dateStr = body.dataset.date

    const blockEl = e.target.closest('.tb-block[data-block-id]')
    if (blockEl) {
      const block = svcTimeblocks.loadBlocks(dateStr).find(b => b.id === blockEl.dataset.blockId)
      if (block) openBlockModal({ dateStr, block })
      return
    }

    const relY = e.clientY - body.getBoundingClientRect().top + body.scrollTop
    const viewOffset = Math.max(0, Math.min(visibleHourCount() - 0.01, relY / HOUR_H))
    const snappedHour = Math.floor(hourAtViewOffset(viewOffset) * 2) / 2
    openBlockModal({ dateStr, startH: snappedHour })
  })

  return true
}

// ── 渲染周历主视图 ────────────────────────────────────
function renderTimeblock(container, options = {}) {
  if (!container) return
  const mountedNew = ensureTimeblockShell(container)
  if (mountedNew || options.scrollToToday) renderGridColumns(container, options)
  else refreshAllColumnBlocks(container)
}

const { openBlockModal } = svcTimeblockEditor.createTimeblockEditor({ refreshAllColumnBlocks, updateColumnBlocks })

// ── 暴露接口 ──────────────────────────────────────────
svcTimeblockView.renderTimeblock = renderTimeblock
svcTimeblockView.openBlockModal  = openBlockModal
