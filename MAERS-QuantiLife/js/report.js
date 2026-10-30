import { chart as svcChart } from './chart.js'
import { expectations as svcExpectations } from './expectation-store.js'
import { rankView as svcRankView } from './rank-view.js'
import { records as svcRecords } from './records.js'
import { reportAggregator as svcReportAggregator } from './report-aggregator.js'
import { timeStats as svcTimeStats } from './time-stats.js'
import { calendarPicker as svcCalendarPicker } from '../../common/js/calendar-picker.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { dom as svcDom } from '../../common/js/dom.js'
import { storageState as svcStorageState } from '../../common/js/idb-store.js'
import { storage as svcStorage } from '../../common/js/store.js'

const svcReport = {}
export const report = svcReport

/**
 * MAERS QuantiLife — 报告页视图与交互逻辑 (report.js)
 * 依赖（按顺序加载）：shared.js → chart.js → report-aggregator.js → report.js
 */

const $ = svcDom.$
const $$ = svcDom.$$
const html = svcDom.html
const num = svcMetadata.num
const pct = svcMetadata.pct
const clamp = svcMetadata.clamp
const TIME_META = svcMetadata.TIME_META
const TIME_KEYS = svcMetadata.TIME_KEYS
const TIME_MODES = svcTimeStats.TIME_MODES
const MOOD_META = svcMetadata.MOOD_META
const MOOD_KEYS = svcMetadata.MOOD_KEYS
const moodIcon = svcDom.moodIcon
const findEarliestRecord = svcRecords.findEarliestRecord
const addDays = svcDates.addDays
const dateKey = svcDates.dateKey
const parseDateKey = svcDates.parseDateKey
const renderRankBars = svcRankView.renderRankBars
const applyRankAction = svcRankView.applyRankAction
const chartLegend = svcChart.chartLegend
const { buildBuckets, totalAgg } = svcReportAggregator.reportAggregator

// ── 模块级状态 ───────────────────────────────────────
const rankState = {
  timeMode: 'include',
  categoryContext: 'all',
  parallelCombo: null,
  categoryReturnMode: null,
}

// ── DOM 引用 ─────────────────────────────────────────
const rangeStartEl = $('#range-start')
const rangeEndEl   = $('#range-end')
const precisionEl  = $('#ctrl-precision')
const densityEl    = $('#ctrl-density')
const container    = $('#report-content')

const getPrecision = () => clamp(parseInt(precisionEl.value, 10) || 1, 1, 30)
const getDensity   = () => Math.max(7, parseInt(densityEl.value, 10) || 7)

// ── 分区片段 ─────────────────────────────────────────
const sectionTitle = (icon, text, extra = '') => html`
  <h2 class="section-title"><span class="icon" aria-hidden="true">${icon}</span>${text}${extra}</h2>`
const imgIcon = (name, size = 16) => html`<img src="ui/${name}.svg" width="${size}" height="${size}" class="chart-title-icon" alt="">`

function renderOverview(agg) {
  return html`<section class="section">
    ${sectionTitle(imgIcon('overview'), '概览')}
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-icon">${imgIcon('calendar', 28)}</div>
        <div class="kpi-value">${agg.recordDays}<span class="kpi-total">/${agg.totalDays}</span></div>
        <div class="kpi-label">记录天数</div></div>
      <div class="kpi-card"><div class="kpi-icon">${imgIcon('walk', 28)}</div>
        <div class="kpi-value">${num(agg.avgSteps, 0)}</div><div class="kpi-label">日均步数</div></div>
      <div class="kpi-card"><div class="kpi-icon">${imgIcon('sleep', 28)}</div>
        <div class="kpi-value">${num(agg.avgSleep)}h</div><div class="kpi-label">日均睡眠</div></div>
      <div class="kpi-card"><div class="kpi-icon">${imgIcon('water', 28)}</div>
        <div class="kpi-value">${num(agg.avgWater, 0)}</div><div class="kpi-label">日均饮水 ml</div></div>
    </div>
  </section>`
}

function renderBasics(ctx) {
  const { chart, series, exp, C } = ctx
  const items = [
    { key: 'steps', icon: 'walk',  title: '步数',      unit: '步' },
    { key: 'sleep', icon: 'sleep', title: '睡眠 (h)',  unit: 'h' },
    { key: 'water', icon: 'water', title: '饮水 (ml)', unit: 'ml' },
  ]
  return html`<section class="section">
    ${sectionTitle(imgIcon('trend'), '基础指标趋势', html`<span class="section-hint">← 拖拽图表左右滚动 →</span>`)}
    ${items.map(it => html`
      <div class="chart-container">
        <h3 class="chart-title">${imgIcon(it.icon)} ${it.title}</h3>
        ${chart({ title: it.title, datasets: [{ values: series(it.key), color: C[it.key], name: it.title }],
          height: 160, unit: it.unit, goalValue: exp[it.key] || null, showAvg: true })}
      </div>`)}
  </section>`
}

function renderTime(agg, ctx) {
  const timeTotal = Object.values(agg.timeSums).reduce((a, b) => a + b, 0)
  // 折线图数据随模式切换：单一→timePure，包含并行→timePure+timeFused，仅并行→timeFused
  const timePick = rankState.timeMode === 'pure'
    ? (b, k) => b.timePure?.[k] || 0
    : rankState.timeMode === 'only'
    ? (b, k) => b.timeFused?.[k] || 0
    : (b, k) => (b.timePure?.[k] || 0) + (b.timeFused?.[k] || 0)
  const timeDatasets = TIME_KEYS.map(k => ({ values: ctx.series(b => timePick(b, k)), color: TIME_META[k].color, name: TIME_META[k].label }))
  return html`<section class="section">
    ${sectionTitle(imgIcon('time'), `时间分配 · 总计 ${num(timeTotal)}h`)}
    <div class="segmented-control report-mode-switch" role="radiogroup" aria-label="并行事项展示方式">
      ${TIME_MODES.map(m => html`
        <label class="segment-label">
          <input type="radio" name="reportTimeMode" value="${m.value}" class="visually-hidden-input" ${rankState.timeMode === m.value ? html`checked` : ''}>
          <span>${m.label}</span>
        </label>`)}
    </div>
    ${renderRankBars(agg, rankState)}
    <div class="chart-container is-spaced">
      <h3 class="chart-title">时间趋势 ${chartLegend(TIME_KEYS.map(k => ({ name: TIME_META[k].label, icon: TIME_META[k].icon, color: TIME_META[k].color })))}</h3>
      ${ctx.chart({ title: '时间趋势', datasets: timeDatasets, height: 180, unit: 'h' })}
    </div>
  </section>`
}

function renderDiet(agg, ctx) {
  const { C } = ctx
  const macros = [
    { key: 'cal',     name: '热量',   color: C.cal },
    { key: 'carb',    name: '碳水',   color: C.carb },
    { key: 'protein', name: '蛋白质', color: C.protein },
    { key: 'fat',     name: '脂肪',   color: C.fat },
  ]
  const avgOf = { carb: agg.avgCarb, protein: agg.avgProtein, fat: agg.avgFat }
  const pieSegs = macros.filter(m => m.key !== 'cal' && avgOf[m.key] > 0)
    .map(m => ({ label: m.name, value: avgOf[m.key], color: m.color }))

  return html`<section class="section">
    ${sectionTitle(imgIcon('diet'), `饮食记录 (日均 热量 ${num(agg.avgCal, 0)} kcal)`)}
    ${pieSegs.length > 0 ? svcChart.pieChart(pieSegs, { unit: 'g' }) : ''}
    <div class="chart-container is-spaced">
      <h3 class="chart-title">营养趋势 ${chartLegend(macros)}</h3>
      ${ctx.chart({ title: '营养趋势', datasets: macros.map(m => ({ values: ctx.series(m.key), color: m.color, name: m.name })), unit: '' })}
    </div>
  </section>`
}

function renderMood(agg, ctx) {
  const moodTotal = Object.values(agg.moods).reduce((a, b) => a + b, 0)
  const scale = MOOD_KEYS.map((k, i) => html`${i > 0 ? '  ' : ''}${moodIcon(k, 14)} ${MOOD_META[k].score}`)
  return html`<section class="section">
    ${sectionTitle(imgIcon('emotion'), '心情分布')}
    <div class="mood-dist">
      ${MOOD_KEYS.map(k => {
        const count = agg.moods[k] || 0
        return html`<div class="mood-dist-item" aria-label="心情 ${MOOD_META[k].label} ${count} 天">
          <div class="md-emoji" aria-hidden="true">${moodIcon(k, 26)}</div>
          <div class="md-count">${count}</div>
          <div class="md-pct">${moodTotal > 0 ? pct(count, moodTotal) : 0}%</div>
        </div>`
      })}
    </div>
    <div class="chart-container is-spaced">
      <h3 class="chart-title">心情趋势 <span class="section-hint">${scale}</span></h3>
      ${ctx.chart({ title: '心情趋势', datasets: [{ values: ctx.series('moodScore'), color: ctx.C.mood, name: '心情' }],
        height: 120, unit: '', yMin: -2, yMax: 2 })}
    </div>
  </section>`
}

// ── 报告渲染 ─────────────────────────────────────────
function renderReport() {
  const start = parseDateKey(rangeStartEl.value)
  const end   = parseDateKey(rangeEndEl.value)
  if (!start || !end || start > end) return

  const precision = getPrecision()
  const density = getDensity()
  const agg = totalAgg(start, end)
  saveState()

  if (agg.recordDays === 0) {
    svcDom.setHTML(container, html`<div class="empty-state"><div class="empty-icon" aria-hidden="true"><img src="ui/empty.svg" width="44" height="44" class="icon-mono" alt=""></div><div class="empty-text">该时段暂无记录数据</div></div>`)
    return
  }

  const { buckets, yearMarkers } = buildBuckets(start, end, precision)
  const labels = buckets.map(b => b.label)
  const ctx = {
    C: svcMetadata.CHART_COLORS,
    exp: svcExpectations.loadExpectations(),
    chart: (opts) => svcChart.svgLineChart({ ...opts, labels, density, yearMarkers }),
    /** 取每个分桶的指标序列，无记录的分桶为 null（折线断开） */
    series: (pick) => buckets.map(b => (b.recordDays > 0 ? (typeof pick === 'function' ? pick(b) : b[pick]) : null)),
  }

  svcDom.setHTML(container, html`
    ${renderOverview(agg)}
    ${renderBasics(ctx)}
    ${renderTime(agg, ctx)}
    ${renderDiet(agg, ctx)}
    ${renderMood(agg, ctx)}`)

  svcChart.attachChartDrag()
}

// 报告内容事件委托（只绑定一次）
container.addEventListener('change', e => {
  if (e.target.name !== 'reportTimeMode') return
  rankState.timeMode = e.target.value
  renderReport()
  container.querySelector(`input[name="reportTimeMode"][value="${rankState.timeMode}"]`)?.focus()
})
container.addEventListener('click', e => {
  const el = e.target.closest('[data-action]')
  if (!applyRankAction(rankState, el)) return
  renderReport()
  container.querySelector('.rank-back-btn, .td-bar-clickable')?.focus()
})

// ── 控件与时段预设绑定 ───────────────────────────────
function makeStep(el, delta, min, max) {
  el.value = clamp((parseInt(el.value, 10) || 0) + delta, min, max)
  renderReport()
}
$('#precision-dec').addEventListener('click', () => makeStep(precisionEl, -1, 1, 30))
$('#precision-inc').addEventListener('click', () => makeStep(precisionEl, +1, 1, 30))
$('#density-dec').addEventListener('click', () => makeStep(densityEl, -1, 7, Infinity))
$('#density-inc').addEventListener('click', () => makeStep(densityEl, +1, 7, Infinity))
precisionEl.addEventListener('change', renderReport)
densityEl.addEventListener('change', renderReport)
$('#ctrl-reset').addEventListener('click', () => { precisionEl.value = 1; densityEl.value = 7; renderReport() })

function setActivePreset(btn) {
  $$('.preset-btn').forEach(b => {
    b.classList.toggle('active', b === btn)
    b.setAttribute('aria-pressed', String(b === btn))
  })
}

function applyPreset(preset) {
  const today = parseDateKey(svcDates.today())
  const start = preset === 'all'
    ? (findEarliestRecord() || addDays(today, -30))
    : addDays(today, -(parseInt(preset, 10) - 1))
  rangeStartEl.value = dateKey(start)
  rangeEndEl.value = dateKey(today)
  renderReport()
}

const rangeInputsWrap = $('#range-inputs')
;[rangeStartEl, rangeEndEl].forEach(el => svcCalendarPicker.bindDateInput(el, {
  anchorEl: rangeInputsWrap,
  onChange: () => { setActivePreset(null); renderReport() },
}))
$('.range-presets').addEventListener('click', e => {
  const btn = e.target.closest('.preset-btn')
  if (!btn) return
  setActivePreset(btn)
  applyPreset(btn.dataset.preset)
})

// ── 状态持久化与启动（仅记忆精度与密度；时段每次默认近 7 天） ──
function saveState() {
  svcStorage.store.set(svcMetadata.REPORT_STATE_KEY, { precision: getPrecision(), density: getDensity() })
}

// 其他标签页写入了量化记录（如 Schedule 结束计时）时重绘报告；报告自身的状态键不在该前缀下，不会形成刷新回路
svcStorage.onStoreChange(keys => { if (keys.some(key => key.startsWith(svcMetadata.QL_PREFIX))) renderReport() })

svcStorageState.onStorageReady(() => {
  const saved = svcStorage.store.get(svcMetadata.REPORT_STATE_KEY, null)
  if (saved) {
    precisionEl.value = clamp(Number(saved.precision) || 1, 1, 30)
    densityEl.value = Math.max(7, Number(saved.density) || 7)
  }

  svcChart.attachChartTooltip()
  svcChart.attachChartHover()
  const defaultPreset = $('.preset-btn[data-preset="1"]')
  setActivePreset(defaultPreset)
  applyPreset(defaultPreset.dataset.preset)
})
