import { rankView as svcRankView } from './rank-view.js'
import { quantiTags as svcQuantiTags } from './tags.js'
import { timeStats as svcTimeStats } from './time-stats.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { dom as svcDom } from '../../common/js/dom.js'
import { ui as svcUi } from '../../common/js/ui.js'

const svcTimeDetail = {}
export const timeDetail = svcTimeDetail

/**
 * MAERS QuantiLife — 时间分配展示、标签库管理与今日记录明细控制器 (time-detail.js)
 * 职责：
 * 1. 时间分配卡片摘要更新、全屏时间排行面板（总览/各分类）、标签库增删管理、今日记录明细纯只读展示；
 * 2. 活动计时、调整与删除统一由 Schedule「进行中」板块负责，本模块专注于数据展示与标签维护；
 * 3. 纯分类统计与排行计算委托给 QL.* 领域层 (shared.js)。
 */

const $ = svcDom.$
const $$ = svcDom.$$
const html = svcDom.html
const raw = svcDom.raw
const TIME_KEYS = svcMetadata.TIME_KEYS
const TIME_META = svcMetadata.TIME_META
const catIcon = svcDom.catIcon
const fmtH = svcDates.fmtH
const computeTimeCategoryTotals = svcTimeStats.computeTimeCategoryTotals
const computeTimeCategorySumMap = svcTimeStats.computeTimeCategorySumMap
const aggregateTimeEvents = svcTimeStats.aggregateTimeEvents
const renderRankBars = svcRankView.renderRankBars
const applyRankAction = svcRankView.applyRankAction

const SYNC_ICON = raw('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" class="record-sync-icon" aria-label="同步自 Schedule" role="img"><path d="M20 4 L20 20 L4 20 Z" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linejoin="round" stroke-linecap="round"/></svg>')

// ── 模块状态 ─────────────────────────────────────────
let timeEvents = []
const rankState = {
  timeMode: 'include',
  categoryContext: 'all',
  parallelCombo: null,
  categoryReturnMode: null,
}

const isEvFused = (ev) => (ev.tags || []).length > 1 || !!ev._isParallel
const includeFusion = () => $('#td-fusion-toggle').checked

// ── 更新主页七大类时间卡片摘要与底部总计 ─────────────
function updateAllSummaries() {
  const totals = computeTimeCategoryTotals(timeEvents)
  const withFused = includeFusion()

  TIME_KEYS.forEach(k => {
    const el = $(`#slot-summary-${k}`)
    const t = totals[k]
    const isEmpty = t.pure === 0 && t.fused === 0
    el.classList.toggle('empty', isEmpty)
    svcDom.setHTML(el, isEmpty
      ? html`—`
      : (withFused && t.fused > 0
          ? html`${fmtH(t.pure)}<span class="slot-fused-plus">+${fmtH(t.fused)}</span>`
          : html`${fmtH(t.pure)}`))
  })

  const totalPure  = timeEvents.reduce((s, ev) => s + (isEvFused(ev) ? 0 : (ev.h || 0)), 0)
  const totalFused = timeEvents.reduce((s, ev) => s + (isEvFused(ev) ? (ev.h || 0) : 0), 0)
  const showFused = withFused && totalFused > 0

  const totalEl = $('#time-total')
  svcDom.setHTML(totalEl, html`已分配 <span>${fmtH(totalPure)}</span>${showFused ? html`+<span class="slot-fused-plus">${fmtH(totalFused)}</span>` : ''} / 24 小时`)
  totalEl.classList.toggle('over-24', totalPure > 24)

  $('#td-total').textContent = withFused ? `${fmtH(totalPure)}+${fmtH(totalFused)}` : fmtH(totalPure)
}

// ── 全屏详情面板（原生 <dialog>） ─────────────────────
const tdDialog = $('#time-detail-overlay')
const tdTitle  = $('#td-overlay-title')
const tdBarsEl = $('#td-bars')
// 排行视图与标签库视图互斥显示
const rankViewEls = [$('#td-segment-wrap'), $('#td-list-view'), $('#td-bottom-bar')]
const tagViewEl   = $('#td-add-form')

function showView(view) {
  rankViewEls.forEach(el => { el.hidden = view !== 'rank' })
  tagViewEl.hidden = view !== 'tags'
}

function syncPanelTitle() {
  const category = rankState.categoryContext
  if (category === 'all') {
    tdTitle.textContent = '总览'
  } else if (TIME_META[category]) {
    svcDom.setHTML(tdTitle, html`${catIcon(category, 17)} ${TIME_META[category].label}`)
  } else {
    tdTitle.textContent = '活动记录'
  }
}

function syncModeRadio() {
  const radio = $(`input[name="tdMode"][value="${rankState.timeMode}"]`)
  if (radio) radio.checked = true
}

function openEventPanel(category = 'all') {
  rankState.entryCategory = category
  rankState.categoryContext = category
  rankState.parallelCombo = null
  rankState.categoryReturnMode = null
  syncModeRadio()
  showView('rank')
  syncPanelTitle()
  renderEventBars()
  svcUi.openDialog(tdDialog, { focus: '#td-back' })
}

function openTagManageView() {
  renderTagSelector()
  renderRecordDetails()
  tdTitle.textContent = '标签库与今日明细'
  showView('tags')
  svcUi.openDialog(tdDialog, { focus: '#td-back' })
}

const closeEventPanel = () => svcUi.closeDialog(tdDialog)

function handleBackClick() {
  if (!$('#td-list-view').hidden) {
    if (rankState.parallelCombo) {
      applyRankAction(rankState, { dataset: { action: 'back-to-parallel' } })
      syncModeRadio()
      syncPanelTitle()
      renderEventBars()
      return
    }
    if (rankState.categoryContext !== (rankState.entryCategory || 'all')) {
      applyRankAction(rankState, { dataset: { action: 'back-to-cat' } })
      syncModeRadio()
      syncPanelTitle()
      renderEventBars()
      return
    }
  }
  closeEventPanel()
}

// 全屏面板不响应背景点击关闭；Esc / 返回 / 确认均经由 close 事件统一收尾
svcUi.bindDialog(tdDialog, { lightDismiss: false, onClose: updateAllSummaries })

// ── 排行条形图渲染（与报告页同构，内部不重复渲染返回按钮） ───
function renderEventBars() {
  const checkedMode = $('input[name="tdMode"]:checked')?.value
  if (checkedMode) rankState.timeMode = checkedMode

  const agg = aggregateTimeEvents(timeEvents)
  const hasEvents = timeEvents.length > 0
  $('#td-empty').hidden = hasEvents
  svcDom.setHTML(tdBarsEl, hasEvents ? renderRankBars(agg, rankState, { showBack: false }) : html``)

  const cat = rankState.categoryContext
  const pureH = cat === 'all'
    ? timeEvents.reduce((s, ev) => s + (isEvFused(ev) ? 0 : (ev.h || 0)), 0)
    : (agg.catStats[cat]?.pureH || 0)
  const fusedH = cat === 'all'
    ? timeEvents.reduce((s, ev) => s + (isEvFused(ev) ? (ev.h || 0) : 0), 0)
    : (agg.catStats[cat]?.fusedH || 0)

  $('#td-total').textContent = rankState.timeMode === 'pure'
    ? fmtH(pureH)
    : rankState.timeMode === 'only'
    ? fmtH(fusedH)
    : (fusedH > 0 ? `${fmtH(pureH)} + ${fmtH(fusedH)}` : fmtH(pureH))
}

// ── 标签库管理渲染 ───────────────────────────────────
function renderTagSelector(openCatKey = null) {
  svcDom.setHTML($('#td-tag-selector'), html`${TIME_KEYS.map(k => {
    const m = TIME_META[k]
    const tagsInCat = Object.keys(svcQuantiTags.TAG_META).filter(t => svcQuantiTags.TAG_META[t] === k)
    const isOpen = openCatKey === k
    return html`
      <div class="tag-cat-group">
        <button type="button" class="tag-cat-header" data-cat="${k}" aria-expanded="${String(isOpen)}" aria-controls="tag-cat-body-${k}">
          <span>${catIcon(k, 15)} ${m.label}</span>
          <span class="td-chevron${isOpen ? ' open' : ''}" aria-hidden="true">▼</span>
        </button>
        <div class="tag-cat-body${isOpen ? ' open' : ''}" id="tag-cat-body-${k}" data-cat="${k}">
          ${tagsInCat.map(t => html`
            <span class="td-tag-chip-btn" style="--chip-color:${m.color}">
              ${catIcon(k, 14)} ${t}
              <button type="button" class="del-tag-btn" data-del-tag="${t}" title="删除标签" aria-label="删除标签 ${t}">×</button>
            </span>`)}
          <div class="tag-add-inline">
            <input type="text" class="tag-add-input" id="new-tag-${k}" placeholder="添加新标签..." aria-label="为${m.label}添加新标签" autocomplete="off" />
            <button type="button" class="add-new-tag-btn" data-add-cat="${k}">添加</button>
          </div>
        </div>
      </div>`
  })}`)
}

// ── 今日记录明细列表渲染（纯只读展示） ───────────────
function renderRecordDetails() {
  const list = $('#td-record-details-list')
  if (timeEvents.length === 0) {
    svcDom.setHTML(list, html`<div class="td-records-empty">今日暂无记录</div>`)
    return
  }

  svcDom.setHTML(list, html`${timeEvents.map(ev => {
    const cat = (ev.tags?.[0] && svcQuantiTags.resolveTagCategory(ev.tags[0])) || 'basic'
    const segs = ev.segments || []
    return html`
      <div class="record-item" style="--record-color:${TIME_META[cat].color}">
        <div class="record-item-info">
          <span class="record-item-name">${ev._isSync ? SYNC_ICON : ''}${ev.name || '未命名'}</span>
          ${segs.length > 0 ? html`<div class="record-item-segs">${segs.map((s, si) =>
            `${segs.length > 1 ? `第${si + 1}段 ` : ''}${s.startHm}–${s.endHm}`).join(' · ')}</div>` : ''}
          ${ev.tags?.length ? html`<div class="record-item-tags">${ev.tags.map(t => {
            const tColor = TIME_META[svcQuantiTags.resolveTagCategory(t) || 'basic'].color
            return html`<span class="record-tag-badge" style="--tag-color:${tColor}">${TIME_META[t]?.label || t}</span>`
          })}</div>` : ''}
        </div>
        <div class="record-item-actions">
          <strong class="record-item-hours">${fmtH(ev.h)}</strong>
        </div>
      </div>`
  })}`)
}

// ── 事件绑定与容器级事件委托 ─────────────────────────
function addTag(cat) {
  const input = $(`#new-tag-${cat}`)
  const newTag = input.value.trim().replace(/\+/g, '')
  if (!newTag) return
  svcQuantiTags.saveTag(newTag, cat)
  renderTagSelector(cat)
  $(`#new-tag-${cat}`)?.focus()
}

const tagSelector = $('#td-tag-selector')
tagSelector.addEventListener('click', e => {
  const hdr = e.target.closest('.tag-cat-header')
  if (hdr) {
    const open = hdr.getAttribute('aria-expanded') !== 'true'
    hdr.setAttribute('aria-expanded', String(open))
    hdr.querySelector('.td-chevron').classList.toggle('open', open)
    $(`#tag-cat-body-${hdr.dataset.cat}`).classList.toggle('open', open)
    return
  }

  const delBtn = e.target.closest('[data-del-tag]')
  if (delBtn) {
    const tag = delBtn.dataset.delTag
    if (confirm(`确定要删除标签 [${tag}] 吗？\n删除后历史记录中该标签的统计可能会受影响。`)) {
      svcQuantiTags.deleteTag(tag)
      renderTagSelector(delBtn.closest('.tag-cat-body')?.dataset.cat || null)
    }
    return
  }

  const addBtn = e.target.closest('[data-add-cat]')
  if (addBtn) addTag(addBtn.dataset.addCat)
})
// 在输入框内按 Enter 直接添加
tagSelector.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !e.target.classList.contains('tag-add-input')) return
  e.preventDefault()
  addTag(e.target.id.replace('new-tag-', ''))
})

tdBarsEl.addEventListener('click', e => {
  const el = e.target.closest('[data-action]')
  if (!applyRankAction(rankState, el)) return
  syncModeRadio()
  syncPanelTitle()
  renderEventBars()
  tdBarsEl.querySelector('.td-bar-clickable')?.focus()
})

$('#td-open-btn').addEventListener('click', openTagManageView)
$('#td-back').addEventListener('click', handleBackClick)
$('#td-save').addEventListener('click', closeEventPanel)

$('#td-toggle-details-btn').addEventListener('click', e => {
  const btn = e.currentTarget
  const open = btn.getAttribute('aria-expanded') !== 'true'
  $('#td-record-details-list').classList.toggle('open', open)
  btn.setAttribute('aria-expanded', String(open))
  btn.textContent = open ? '▲ 收起今日记录明细' : '▼ 展开今日记录明细'
})

$('#td-fusion-toggle').addEventListener('change', updateAllSummaries)
$('#td-overview-btn').addEventListener('click', () => openEventPanel('all'))
$('#td-fusion-modes').addEventListener('change', e => {
  if (e.target.name === 'tdMode') {
    rankState.timeMode = e.target.value
    renderEventBars()
  }
})
$$('.time-slot').forEach(slot => slot.addEventListener('click', () => openEventPanel(slot.dataset.key)))

// ── 暴露公共接口 ─────────────────────────────────────
svcTimeDetail.timeDetail = {
  getEvents: () => timeEvents.map(ev => ({ ...ev })),
  setEventsFromDayData: (data) => {
    timeEvents = Array.isArray(data?.timeEvents) ? data.timeEvents.map(ev => ({ ...ev })) : []
    updateAllSummaries()
  },
  clear: () => {
    timeEvents = []
    updateAllSummaries()
  },
  getCategoryTotals: () => computeTimeCategorySumMap(timeEvents),
  openTagManage: openTagManageView,
}
