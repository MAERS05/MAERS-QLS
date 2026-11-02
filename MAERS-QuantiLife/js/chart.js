import { metadata as svcMetadata } from '../../common/js/core.js'
import { dom as svcDom } from '../../common/js/dom.js'

const svcChart = {}
export const chart = svcChart

/**
 * MAERS QuantiLife — 图表渲染引擎 (chart.js)
 * 导出：QL.svgLineChart, QL.pieChart, QL.chartLegend, QL.attachChartHover, QL.attachChartDrag, QL.attachChartTooltip
 * 所有渲染函数均返回 QLS.html 生成的 SafeHtml 片段。
 */

const html = svcDom.html
const num = svcMetadata.num
const fmtVal = (v) => num(v, v >= 100 ? 0 : 1)

// ─────────────────────────────────────────────────────────
// SVG 折线图（横向可滚动）
// labels:      X 轴标签数组
// datasets:    [{values, color, name}]
// height:      SVG 高度（默认 160）
// unit:        Y 轴单位
// density:     可视点数（决定宽度缩放）
// yearMarkers: [{index, year}] 年份分界线
// ─────────────────────────────────────────────────────────
svcChart.svgLineChart = function ({ labels, datasets, height = 160, unit = '', density = 20, yearMarkers = [], yMin = null, yMax = null, goalValue = null, showAvg = false, title = '' }) {
  const N = labels.length
  const BASE_W = 600
  const W = Math.max(BASE_W, BASE_W * (N / density))
  const H = height

  const allVals = datasets.flatMap(ds => ds.values.filter(v => v !== null))
  if (allVals.length === 0) allVals.push(0)
  const dataMax = Math.max(...allVals)
  const dataMin = Math.min(...allVals)
  const range = dataMax - dataMin || 1
  const yMaxFinal = yMax !== null ? yMax : dataMax + range * 0.1
  const yMinFinal = yMin !== null ? yMin : Math.max(0, dataMin - range * 0.1)
  const yRange    = yMaxFinal - yMinFinal || 1

  // 动态左边距（~7px/char，最小 46）
  const yLabelLen = Math.max(fmtVal(yMaxFinal).length, fmtVal(yMinFinal).length) + unit.length
  const PAD   = { top: 16, right: 20, bottom: 28, left: Math.max(46, yLabelLen * 7 + 10) }
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top  - PAD.bottom
  const step  = N > 1 ? plotW / (N - 1) : plotW / 2
  const xAt = (i) => (N > 1 ? PAD.left + step * i : PAD.left + plotW / 2)
  const yAt = (v) => PAD.top + plotH - ((v - yMinFinal) / yRange) * plotH

  // Y 网格 + 标签
  const grid = Array.from({ length: 5 }, (_, i) => {
    const y   = PAD.top + (plotH * i) / 4
    const val = yMaxFinal - (yRange * i) / 4
    return html`<line x1="${PAD.left}" y1="${y}" x2="${W - PAD.right}" y2="${y}" class="chart-grid-line"/>
      <text x="${PAD.left - 6}" y="${y + 3}" class="chart-axis-label" text-anchor="end">${fmtVal(val)}${unit}</text>`
  })

  // 年份分界线
  const years = yearMarkers.filter(({ index }) => index < N).map(({ index, year }) => {
    const x = xAt(index)
    return html`<line x1="${x}" y1="${PAD.top}" x2="${x}" y2="${PAD.top + plotH}" class="chart-year-line"/>
      <text x="${x + 4}" y="${PAD.top + 11}" class="chart-year-label">${year}</text>`
  })

  // X 标签
  const skipInterval = N > 12 ? Math.ceil(N / 12) : 1
  const xLabels = labels.map((lbl, i) => (i % skipInterval === 0 || i === N - 1)
    ? html`<text x="${xAt(i)}" y="${H - 4}" class="chart-x-label">${lbl}</text>`
    : '')

  // 折线 + 面积 + 圆点（每条线包在 <g data-series="i"> 中，供点击高亮用）
  const lines = datasets.map((ds, dsIdx) => {
    const pts = ds.values
      .map((v, i) => (v === null ? null : { x: xAt(i), y: yAt(v), v, i }))
      .filter(Boolean)
    if (pts.length === 0) return ''

    const pathD = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ')
    const areaD = `${pathD} L${pts[pts.length - 1].x},${PAD.top + plotH} L${pts[0].x},${PAD.top + plotH} Z`
    return html`<g class="chart-series" data-series="${dsIdx}" style="--series-color:${ds.color}">
      <path d="${areaD}" class="chart-area"/>
      <path d="${pathD}" class="chart-line"/>
      <path d="${pathD}" class="chart-line-hit"/>
      ${pts.map(p => {
        const tipVal = `${fmtVal(p.v)}${unit}`
        const tip = ds.name ? `${labels[p.i] || ''} · ${ds.name}: ${tipVal}` : `${labels[p.i] || ''}: ${tipVal}`
        return html`<circle cx="${p.x}" cy="${p.y}" r="6" class="chart-dot" data-tip="${tip}"/>`
      })}
    </g>`
  })

  // 期望线（主题强调色虚线）
  const goal = goalValue !== null && goalValue >= yMinFinal && goalValue <= yMaxFinal
    ? html`<line x1="${PAD.left}" y1="${yAt(goalValue)}" x2="${W - PAD.right}" y2="${yAt(goalValue)}" class="chart-goal-line"/>
        <text x="${W - PAD.right - 4}" y="${yAt(goalValue) - 4}" class="chart-goal-label" text-anchor="end">期望 ${fmtVal(goalValue)}${unit}</text>`
    : ''

  // 平均线（次要文字色虚线，自适应明暗背景）
  let avgLine = ''
  const firstVals = showAvg ? (datasets[0]?.values || []).filter(v => v !== null) : []
  if (firstVals.length > 0) {
    const avg = firstVals.reduce((a, b) => a + b, 0) / firstVals.length
    if (avg >= yMinFinal && avg <= yMaxFinal) {
      avgLine = html`<line x1="${PAD.left}" y1="${yAt(avg)}" x2="${W - PAD.right}" y2="${yAt(avg)}" class="chart-avg-line"/>
        <text x="${PAD.left + 4}" y="${yAt(avg) - 4}" class="chart-avg-label">均 ${fmtVal(avg)}${unit}</text>`
    }
  }

  const cssWidthPct = N <= density ? 100 : Math.round(N / density * 100)
  return html`<div class="chart-scroll-wrap">
    <svg class="chart-svg" style="width:${cssWidthPct}%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"
      role="img" aria-label="${title || '趋势图'}">
      ${grid}${years}${xLabels}${lines}${goal}${avgLine}
    </svg>
  </div>`
}

// ─────────────────────────────────────────────────────────
// 图例
// items: [{name, color, icon?, emoji?}]
// ─────────────────────────────────────────────────────────
svcChart.chartLegend = (items) => html`<span class="chart-legend">${items.map(m => html`
  <span class="chart-legend-item"><span class="chart-legend-dot" style="--dot-color:${m.color}" aria-hidden="true"></span>${m.icon ? html`<img src="${m.icon}" width="13" height="13" class="cat-icon" alt="" /> ` : m.emoji ? `${m.emoji} ` : ''}${m.name}</span>`)}</span>`

// ─────────────────────────────────────────────────────────
// 多折线点击高亮（只注册一次）
// 点击某条线 → 高亮该线、其余变暗；再次点击同一条 → 取消
// 鼠标移动、拖拽均不影响高亮状态
// ─────────────────────────────────────────────────────────
let chartClickInit = false
let lockedKey = null   // 当前锁定的 data-series 值
let lockedSvg = null   // 当前锁定所在的 SVG 元素

svcChart.attachChartHover = function () {
  if (chartClickInit) return
  chartClickInit = true

  const applyHighlight = (svg, target) => {
    svg.querySelectorAll('.chart-series').forEach(g => {
      g.classList.toggle('series-highlighted', g === target)
      g.classList.toggle('series-dimmed', g !== target)
    })
  }
  const clearHighlight = (svg) => {
    svg.querySelectorAll('.chart-series').forEach(g => g.classList.remove('series-highlighted', 'series-dimmed'))
  }

  // 用 mousedown + mouseup 判断点击（位移 > 5px 视为拖拽，忽略）
  let downX = 0, downY = 0, downTarget = null

  document.addEventListener('mousedown', e => {
    downX = e.clientX
    downY = e.clientY
    downTarget = e.target
  }, true)

  document.addEventListener('mouseup', e => {
    if (Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5) return

    const target = downTarget || e.target
    const series = target.closest?.('.chart-series')
    const svg    = target.closest?.('.chart-svg')

    if (!svg) {
      // 点击图表外部 → 解锁
      if (lockedSvg) { clearHighlight(lockedSvg); lockedKey = null; lockedSvg = null }
      return
    }
    if (svg.querySelectorAll('.chart-series').length < 2 || !series) return  // 单线图无需高亮

    const key = series.dataset.series
    if (lockedKey === key && lockedSvg === svg) {
      // 再次点击同一条线 → 解锁
      clearHighlight(svg)
      lockedKey = null
      lockedSvg = null
    } else {
      if (lockedSvg && lockedSvg !== svg) clearHighlight(lockedSvg)
      applyHighlight(svg, series)
      lockedKey = key
      lockedSvg = svg
    }
  }, true)
}

// ─────────────────────────────────────────────────────────
// 甜甜圈饼图
// segments: [{label, value, color}]
// unit:     图例数值单位（默认 h）
// ─────────────────────────────────────────────────────────
svcChart.pieChart = function (segments, { unit = 'h' } = {}) {
  const total = segments.reduce((s, seg) => s + seg.value, 0)
  if (total === 0) return html`<div class="pie-empty">无数据</div>`
  let angle = 0
  const gradParts = segments.map(seg => {
    const deg = (seg.value / total) * 360
    const part = `${seg.color} ${angle}deg ${angle + deg}deg`
    angle += deg
    return part
  })
  return html`<div class="pie-wrapper">
    <div class="pie-chart" style="background:conic-gradient(${gradParts.join(',')})" role="img"
      aria-label="${segments.map(s => `${s.label} ${svcMetadata.pct(s.value, total)}%`).join('，')}"></div>
    <div class="pie-legend">${segments.map(seg => html`
      <div class="legend-row">
        <div class="legend-dot" style="--dot-color:${seg.color}" aria-hidden="true"></div>
        <span class="legend-name">${seg.label}</span>
        <span class="legend-val">${num(seg.value)}${unit}</span>
        <span class="legend-pct">${svcMetadata.pct(seg.value, total)}%</span>
      </div>`)}
    </div>
  </div>`
}

// ─────────────────────────────────────────────────────────
// 图表横向拖拽滚动（全局单例事件监听，杜绝内存与事件泄漏）
// ─────────────────────────────────────────────────────────
let activeDragWrap = null
let dragStartX = 0
let dragStartScroll = 0
let dragDocBound = false

function initGlobalDragEvents() {
  if (dragDocBound) return
  dragDocBound = true

  document.addEventListener('mousemove', e => {
    if (!activeDragWrap) return
    activeDragWrap.scrollLeft = Math.max(0, dragStartScroll - (e.clientX - dragStartX))
  })

  document.addEventListener('mouseup', () => {
    if (!activeDragWrap) return
    activeDragWrap.classList.remove('is-grabbing')
    activeDragWrap = null
  })
}

svcChart.attachChartDrag = function () {
  initGlobalDragEvents()
  document.querySelectorAll('.chart-scroll-wrap').forEach(wrap => {
    if (wrap.dataset.dragInit) return
    wrap.dataset.dragInit = '1'

    wrap.addEventListener('mousedown', e => {
      activeDragWrap = wrap
      dragStartX = e.clientX
      dragStartScroll = wrap.scrollLeft
      wrap.classList.add('is-grabbing')
      e.preventDefault()
    })
    wrap.addEventListener('touchstart', e => {
      dragStartX = e.touches[0].clientX
      dragStartScroll = wrap.scrollLeft
    }, { passive: true })
    wrap.addEventListener('touchmove', e => {
      wrap.scrollLeft = Math.max(0, dragStartScroll - (e.touches[0].clientX - dragStartX))
    }, { passive: true })
  })
}

// ─────────────────────────────────────────────────────────
// [data-tip] 浮动提示（只注册一次）
// ─────────────────────────────────────────────────────────
let tooltipInit = false
svcChart.attachChartTooltip = function () {
  const tip = document.getElementById('chart-tip')
  if (!tip || tooltipInit) return
  tooltipInit = true
  let hideTimer = null

  document.addEventListener('mouseover', e => {
    const el = e.target.closest?.('[data-tip]')
    if (!el) return
    clearTimeout(hideTimer)
    tip.textContent = el.dataset.tip
    tip.hidden = false
  })
  document.addEventListener('mousemove', e => {
    if (tip.hidden) return
    tip.style.left = `${e.clientX + 14}px`
    tip.style.top  = `${e.clientY - 28}px`
  })
  document.addEventListener('mouseout', e => {
    if (e.target.closest?.('[data-tip]')) hideTimer = setTimeout(() => { tip.hidden = true }, 80)
  })
}
