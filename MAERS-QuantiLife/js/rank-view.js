import { quantiTags as svcQuantiTags } from './tags.js'
import { timeStats as svcTimeStats } from './time-stats.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { dom as svcDom } from '../../common/js/dom.js'

const svcRankView = {}
export const rankView = svcRankView

/** MAERS QuantiLife — 时间排行 HTML 展示与下钻交互状态。 */
const html = svcDom.html
const { buildRankList, buildParallelCombinations } = svcTimeStats.timeStats

/** 纯色/渐变排行条轨道（内部不显示文字或悬浮提示） */
function fillTrack(hours, maxH, background, { fused = false } = {}) {
  const width = `${(Math.max(0, hours) / maxH * 100).toFixed(1)}%`
  const cls = fused ? 'td-bar-fill-fused' : 'td-bar-fill'
  return html`<span class="td-bar-track"><span class="${cls}" style="width:${width};background:${background}"></span></span>`
}

function comboBackground(cats) {
  const colors = cats.map(cat => (svcMetadata.TIME_META[cat] || svcMetadata.TIME_META.basic).color)
  return colors.length > 1
    ? `linear-gradient(90deg, ${colors.join(', ')})`
    : colors[0] || svcMetadata.TIME_META.basic.color
}

function renderParallelParts(parts, kind) {
  return html`<span class="td-combo-categories">${parts.map(part => {
    const cat = kind === 'category' ? part : svcQuantiTags.resolveTagCategory(part)
    const meta = svcMetadata.TIME_META[cat] || { label: part }
    const label = kind === 'category' ? meta.label : part
    return html`<span class="td-combo-category"><span class="td-combo-icon" aria-hidden="true">${svcDom.catIcon(cat, 14)}</span><span>${label}</span></span>`
  })}</span>`
}

/**
 * “包含并行”的汇总条仍是一个条，但颜色保留实际的并行构成。
 * 同一时段涉及多类时，按各类分摊后的时长绘制硬边渐变。
 */
function parallelMixBackground(details, fallbackColor) {
  const hoursByCat = new Map()
  ;(details || []).forEach(detail => {
    const cats = [...new Set((detail.tags || [])
      .map(tag => svcQuantiTags.resolveTagCategory(tag))
      .filter(Boolean))]
    if (cats.length === 0) return
    const share = Math.max(0, Number(detail.h) || 0) / cats.length
    cats.forEach(cat => hoursByCat.set(cat, (hoursByCat.get(cat) || 0) + share))
  })

  const entries = [...hoursByCat.entries()].filter(([, hours]) => hours > 0)
  if (entries.length <= 1) {
    const [cat] = entries[0] || []
    return (svcMetadata.TIME_META[cat] || { color: fallbackColor }).color || fallbackColor
  }

  const total = entries.reduce((sum, [, hours]) => sum + hours, 0)
  let start = 0
  const stops = []
  entries
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .forEach(([cat, hours]) => {
      const end = start + hours / total * 100
      const color = (svcMetadata.TIME_META[cat] || svcMetadata.TIME_META.basic).color
      stops.push(`${color} ${start.toFixed(1)}%`, `${color} ${end.toFixed(1)}%`)
      start = end
    })
  return `linear-gradient(90deg, ${stops.join(', ')})`
}

function renderParallelCombinations(agg, { isCatMode, categoryContext, parallelCombo, showBack = true }) {
  const comboDetail = Boolean(parallelCombo)
  const combinations = buildParallelCombinations(
    agg,
    comboDetail ? 'tag' : (isCatMode ? 'category' : 'tag'),
    comboDetail || isCatMode ? null : categoryContext,
    parallelCombo,
  )
  if (combinations.length === 0) return html`<div class="report-rank-bars"><div class="rank-empty">暂无并行事项</div></div>`

  const maxH = Math.max(...combinations.map(item => item.h), 1)
  const comboLabel = comboDetail
    ? parallelCombo.split(' + ').map(cat => svcMetadata.TIME_META[cat]?.label || cat).join(' + ')
    : ''
  const heading = comboDetail
    ? `【${comboLabel}】标签并行时间排行`
    : isCatMode
    ? '大类并行时间排行 (点击可查看详情)'
    : `【${svcMetadata.TIME_META[categoryContext]?.label || categoryContext}】标签并行时间排行`
  return html`<div class="report-rank-bars">
    <div class="rank-heading">
      ${comboDetail
        ? html`${showBack ? html`<button type="button" class="rank-back-btn" data-action="back-to-parallel">‹ 返回</button>` : ''}<span>${heading}</span>`
        : isCatMode ? heading
        : html`${showBack ? html`<button type="button" class="rank-back-btn" data-action="back-to-cat">‹ 返回</button>` : ''}<span>${heading}</span>`}
    </div>
    ${combinations.map(item => {
      const name = isCatMode && !comboDetail
        ? renderParallelParts(item.categoryParts, 'category')
        : renderParallelParts(item.tagParts, 'tag')
      const inner = html`
        <span class="td-bar-label"><span class="td-bar-name">${name}</span></span>
        ${fillTrack(item.h, maxH, comboBackground(item.cats), { fused: true })}
        <span class="td-bar-value">${svcDates.fmtH(item.h)}</span>`
      return isCatMode && !comboDetail
        ? html`<button type="button" class="td-bar-item td-combo-item td-bar-clickable" data-action="drill-parallel-combo" data-combo="${item.key}"
            aria-label="查看${item.label}的标签并行时间排行，${svcDates.fmtH(item.h)}">${inner}</button>`
        : html`<div class="td-bar-item td-combo-item">${inner}</div>`
    })}</div>`
}

/** “包含并行”在同一条内连续呈现单一段与并行段，长度按合计时长计算。 */
function renderCombinedTrack(item, maxH) {
  const meta = svcMetadata.TIME_META[item.cat] || svcMetadata.TIME_META.basic
  const parallelBackground = parallelMixBackground(item.fusedDetails, meta.color)
  const pureWidth = `${(Math.max(0, item.pureH) / maxH * 100).toFixed(1)}%`
  const fusedWidth = `${(Math.max(0, item.fusedH) / maxH * 100).toFixed(1)}%`
  return html`<span class="td-bar-track">
    ${item.pureH > 0 ? html`<span class="td-bar-fill" style="width:${pureWidth};background:${meta.color}"></span>` : ''}
    ${item.fusedH > 0 ? html`<span class="td-bar-fill-fused" style="width:${fusedWidth};background:${parallelBackground}"></span>` : ''}
  </span>`
}

/** 渲染时间排行视图（记录页全屏面板与报告页共用） */
svcRankView.renderRankBars = (agg, state = {}, options = {}) => {
  const timeMode = state.timeMode || 'include'
  const categoryContext = state.categoryContext || 'all'
  const parallelCombo = state.parallelCombo || null
  const emptyText = options.emptyText || '暂无数据'
  const showBack = options.showBack !== false
  const isCatMode = categoryContext === 'all'
  if (timeMode === 'only') {
    return renderParallelCombinations(agg, { isCatMode, categoryContext, parallelCombo, showBack })
  }
  const rankList = buildRankList(agg, categoryContext, timeMode)
  if (rankList.length === 0) {
    return html`<div class="report-rank-bars"><div class="rank-empty">${emptyText}</div></div>`
  }

  const maxH = Math.max(...rankList.map(item => timeMode === 'include'
    ? item.pureH + item.fusedH
    : item.displayH), 1)
  return html`<div class="report-rank-bars">
    <div class="rank-heading">
      ${isCatMode
        ? '大类时间排行 (点击可查看详情)'
        : html`${showBack ? html`<button type="button" class="rank-back-btn" data-action="back-to-cat">‹ 返回</button>` : ''}
               <span>【${svcMetadata.TIME_META[categoryContext]?.label || categoryContext}】标签时间排行</span>`}
    </div>
    ${rankList.map(item => {
      const catKey = svcMetadata.TIME_META[item.cat] ? item.cat : 'basic'
      const hText = timeMode === 'include' && item.fusedH > 0
        ? `${svcDates.fmtH(item.pureH)} + ${svcDates.fmtH(item.fusedH)}`
        : svcDates.fmtH(item.displayH)
      const inner = html`
        <span class="td-bar-label"><span class="td-bar-name">${svcDom.catIcon(catKey, 15)} ${item.label}</span></span>
        ${timeMode === 'include'
          ? renderCombinedTrack(item, maxH)
          : fillTrack(item.pureH, maxH, svcMetadata.TIME_META[catKey].color)}
        <span class="td-bar-value">${hText}</span>`
      return isCatMode
        ? html`<button type="button" class="td-bar-item td-bar-clickable" data-action="drill-cat" data-cat="${item.key}"
            aria-label="查看${item.label}标签时间排行，${hText}">${inner}</button>`
        : html`<div class="td-bar-item">${inner}</div>`
    })}
  </div>`
}

/** 统一处理排行下钻与返回动作的状态转移 */
svcRankView.applyRankAction = (state, actionEl) => {
  const action = actionEl?.dataset?.action
  if (!action) return false
  if (action === 'drill-cat') {
    if (state.categoryContext === 'all') state.categoryReturnMode = state.timeMode
    state.categoryContext = actionEl.dataset.cat
    state.parallelCombo = null
  } else if (action === 'back-to-cat') {
    state.categoryContext = 'all'
    state.parallelCombo = null
    if (state.categoryReturnMode) state.timeMode = state.categoryReturnMode
    state.categoryReturnMode = null
  } else if (action === 'drill-parallel-combo') {
    state.parallelCombo = actionEl.dataset.combo
  } else if (action === 'back-to-parallel') {
    state.parallelCombo = null
  } else {
    state.categoryContext = 'all'
    state.parallelCombo = null
    state.categoryReturnMode = null
  }
  return true
}
