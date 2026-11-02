import { scheduleMetadata as svcScheduleMetadata } from './shared.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dom as svcDom } from '../../common/js/dom.js'

const svcWidgets = {}
export const widgets = svcWidgets

/**
 * MAERS Schedule — 视图公用控件 (widgets.js)
 * 职责：提供多个弹窗共用的小型交互控件，避免在各视图中重复实现。
 */
const html = svcDom.html

// ── 7 大分类单选组 ────────────────────────────────────
/**
 * 渲染分类单选组（role=radiogroup，方向键可切换）；选中值为分类键，色块颜色由分类派生
 * @param {Element} container
 * @param {string} selectedCategory 分类键
 */
svcWidgets.renderCategorySwatches = (container, selectedCategory) => {
  if (!container) return
  const current = svcScheduleMetadata.categoryMeta(selectedCategory).key
  container.setAttribute('role', 'radiogroup')
  svcDom.setHTML(container, html`${svcMetadata.CATEGORY_COLORS.map(c => {
    const checked = c.key === current
    return html`<button type="button" class="tb-color-swatch${checked ? ' selected' : ''}" role="radio"
      aria-checked="${String(checked)}" tabindex="${checked ? 0 : -1}" aria-label="${c.label}" title="${c.label}"
      data-category="${c.key}" style="--swatch-color:${c.color}"></button>`
  })}<span class="tb-selected-category" aria-live="polite">${svcScheduleMetadata.categoryMeta(current).label}</span>`)
}

/** 读取当前选中分类键；未选中时回退为第一个分类 */
svcWidgets.getSwatchCategory = (container) =>
  svcScheduleMetadata.categoryMeta(container?.querySelector('.tb-color-swatch.selected')?.dataset.category).key

function selectSwatch(container, sw) {
  container.querySelectorAll('.tb-color-swatch').forEach(s => {
    const on = s === sw
    s.classList.toggle('selected', on)
    s.setAttribute('aria-checked', String(on))
    s.tabIndex = on ? 0 : -1
  })
  const label = container.querySelector('.tb-selected-category')
  if (label) label.textContent = svcScheduleMetadata.categoryMeta(sw.dataset.category).label
}

/** 绑定分类单选组的点击与方向键交互（只绑定一次） */
svcWidgets.bindCategorySwatches = (container, onChange) => {
  if (!container || container.dataset.swatchBound) return
  container.dataset.swatchBound = '1'

  container.addEventListener('click', e => {
    const sw = e.target.closest('.tb-color-swatch')
    if (!sw) return
    selectSwatch(container, sw)
    onChange?.(sw.dataset.category)
  })

  container.addEventListener('keydown', e => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]
    if (!step) return
    e.preventDefault()
    const all = [...container.querySelectorAll('.tb-color-swatch')]
    const idx = all.findIndex(s => s.classList.contains('selected'))
    const next = all[(idx + step + all.length) % all.length]
    selectSwatch(container, next)
    next.focus()
    onChange?.(next.dataset.category)
  })
}


// ── 标签文本解析 ──────────────────────────────────────
/** 解析逗号（中英文）或加号分隔的标签输入 */
svcWidgets.parseTagInput = (value) => String(value || '').split(/[,，+]/).map(s => s.trim()).filter(Boolean)

// ── 长按详情/备注浮层 ────────────────────────────────
/**
 * 绑定长按浮层提示（长按 420ms 展示文本，自动避让视口边界并在点击/滚动时收起）
 */
svcWidgets.bindLongPressTip = (container, { tipEl, itemSelector, getText, ignoreSelector = '', preventContextOnItem = false }) => {
  if (!container || !tipEl) return { hideTip: () => {} }
  let pressTimer = 0
  let tipHideTimer = 0
  let pressStartX = 0
  let pressStartY = 0
  let longPressed = false

  const clearPressTimer = () => {
    if (pressTimer) {
      clearTimeout(pressTimer)
      pressTimer = 0
    }
  }

  const hideTip = () => {
    clearTimeout(tipHideTimer)
    if (!tipEl.hidden) tipEl.hidden = true
  }

  const showTip = (itemEl, text) => {
    clearTimeout(tipHideTimer)
    tipEl.textContent = text
    tipEl.hidden = false

    const rect = itemEl.getBoundingClientRect()
    const tipRect = tipEl.getBoundingClientRect()
    const vw = window.innerWidth || document.documentElement.clientWidth || 360
    const vh = window.innerHeight || document.documentElement.clientHeight || 640
    const left = svcMetadata.clamp(Math.round(rect.left + (rect.width - tipRect.width) / 2), 8, Math.max(8, vw - tipRect.width - 8))
    let top = Math.round(rect.top - tipRect.height - 4)
    if (top < 8) top = Math.min(vh - tipRect.height - 8, Math.round(rect.bottom + 4))
    tipEl.style.left = `${left}px`
    tipEl.style.top = `${top}px`

    tipHideTimer = setTimeout(hideTip, 2000)
  }

  container.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    hideTip()
    if (ignoreSelector && e.target.closest(ignoreSelector)) return
    const itemEl = e.target.closest(itemSelector)
    if (!itemEl || !container.contains(itemEl)) return
    const text = getText(itemEl)
    if (!text) return
    clearPressTimer()
    longPressed = false
    pressStartX = e.clientX
    pressStartY = e.clientY
    pressTimer = setTimeout(() => {
      pressTimer = 0
      longPressed = true
      showTip(itemEl, text)
    }, 420)
  })

  container.addEventListener('pointermove', e => {
    if (pressTimer && Math.hypot(e.clientX - pressStartX, e.clientY - pressStartY) > 8) {
      clearPressTimer()
    }
  }, { passive: true })
  container.addEventListener('pointerup', clearPressTimer)
  container.addEventListener('pointercancel', clearPressTimer)
  container.addEventListener('scroll', () => { clearPressTimer(); hideTip() }, { passive: true })
  container.addEventListener('contextmenu', e => {
    if (longPressed || (preventContextOnItem && e.target.closest(itemSelector))) e.preventDefault()
  })
  container.addEventListener('click', e => {
    if (longPressed) {
      longPressed = false
      e.preventDefault()
      e.stopPropagation()
      return
    }
    hideTip()
  }, true)

  return { hideTip }
}
