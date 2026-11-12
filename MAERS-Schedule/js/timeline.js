import { scheduleMetadata as svcScheduleMetadata } from './shared.js'
import { tasks as svcTasks } from './task-service.js'
import { timelineSort as svcTimelineSort } from './timeline-sort.js'
import { timelineDrag as svcTimelineDrag } from './touch-drag.js'
import { widgets as svcWidgets } from './widgets.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { dom as svcDom } from '../../common/js/dom.js'
import { storage as svcStorage } from '../../common/js/store.js'
import { ui as svcUi } from '../../common/js/ui.js'

const svcTimeline = {}
export const timeline = svcTimeline

/**
 * MAERS Schedule — 三层时间轴与多维排序视图 (timeline.js)
 * 交互约定：
 * - 列表事件全部委托到 #short-list / #mid-list / #long-list，渲染时不再逐项绑定；
 * - 三个层级的可排序条目统一使用 [data-reorder] 与 data-id；
 * - 排序方式：桌面拖拽、移动端长按（touch-drag.js）、键盘 Alt+↑/↓，三者共用 commitTierOrder。
 */
const $ = svcDom.$
const $$ = svcDom.$$
const html = svcDom.html
const QUADRANTS = svcScheduleMetadata.QUADRANTS

let editTask = () => {}, editGoal = () => {}
svcTimeline.configureTimeline = handlers => { editTask = handlers.editTask; editGoal = handlers.editGoal }
const bindTimelineTouchDrag = svcTimelineDrag.createTimelineDrag({
  getLists: () => TIER_LISTS,
  placeItem: (...args) => svcTimeline.placeDraggedItem(...args),
  commitOrder: (...args) => commitTierOrder(...args),
  onDragStart: item => {
    closeContextMenu({ restoreFocus: false })
    closeAllSwipeRows(false, item?.closest('#view-timeline') || document)
    resetSwipeRow(item, false)
  },
  onDragEnd: item => resetSwipeRow(item, false),
})

const TIER_LISTS = { short: '#short-list', mid: '#mid-list', long: '#long-list' }
const REORDER_SEL = '[data-reorder]'

let sortDropdownBound = false
let listEventsBound = false
let ctxMenuBound = false
let swipeResizeObserver = null
let lastPointerType = 'mouse'
const ctxState = { id: null, row: null, fromKeyboard: false }

// ── 桌面端右键菜单与移动端双向滑动删除 ────────────────
const SWIPE_OPEN_TOLERANCE = 20

function supportsAnchorMenuPositioning() {
  return typeof window.CSS?.supports === 'function'
    && window.CSS.supports('position-area', 'block-end span-inline-end')
    && window.CSS.supports('anchor-name', '--timeline-ctx-anchor')
}

function clearCtxHighlight() {
  if (ctxState.row) {
    ctxState.row.querySelector('.timeline-swipe-content')?.classList.remove('is-ctx-active')
  }
  ctxState.id = null
  ctxState.row = null
  ctxState.fromKeyboard = false
}

/**
 * 关闭桌面端时间轴右键菜单并清理激活卡片高亮。
 * @param {{ restoreFocus?: boolean }} [options]
 */
function closeContextMenu({ restoreFocus = false } = {}) {
  const menuEl = $('#timeline-ctx-menu')
  const prevRow = ctxState.row
  const shouldFocus = restoreFocus && ctxState.fromKeyboard && prevRow?.isConnected
  clearCtxHighlight()
  if (!menuEl) return
  if (typeof menuEl.hidePopover === 'function') {
    try {
      if (menuEl.matches(':popover-open')) menuEl.hidePopover()
    } catch { /* 兼容非顶层打开状态 */ }
  }
  menuEl.hidden = true
  if (shouldFocus) prevRow.focus({ preventScroll: true })
}
svcTimeline.closeContextMenu = closeContextMenu

/**
 * 直接删除时间轴条目（右键菜单或滑动抽屉已构成两步操作，不再弹原生 confirm）。
 * @param {string} id
 * @param {{ restoreFocus?: boolean, tier?: string }} [options]
 */
function deleteTimelineItem(id, { restoreFocus = false, tier = '' } = {}) {
  if (!id) return false
  let nextFocusId = null
  let resolvedTier = tier
  if (restoreFocus) {
    const currentRow = $(`#view-timeline ${REORDER_SEL}[data-id="${CSS.escape(id)}"]`)
    resolvedTier = resolvedTier || currentRow?.dataset.tier || ''
    const nextRow = currentRow?.nextElementSibling?.matches(REORDER_SEL)
      ? currentRow.nextElementSibling
      : currentRow?.previousElementSibling?.matches(REORDER_SEL)
        ? currentRow.previousElementSibling
        : null
    nextFocusId = nextRow?.dataset.id || null
  }
  closeContextMenu({ restoreFocus: false })
  if (!svcTasks.deleteTaskOrGoal(id)) return false
  renderTimeline(svcTasks.loadTasks(), svcTasks.loadGoals())
  svcStorage.showSavedToast('已删除')
  if (restoreFocus && resolvedTier) {
    const list = $(TIER_LISTS[resolvedTier])
    const focusTarget = nextFocusId
      ? list?.querySelector(`${REORDER_SEL}[data-id="${CSS.escape(nextFocusId)}"]`)
      : list?.querySelector('.timeline-inline-add')
    focusTarget?.focus({ preventScroll: true })
  }
  return true
}

function openContextMenu(row, event) {
  const id = row?.dataset.id
  const menuEl = $('#timeline-ctx-menu')
  const anchorEl = $('#timeline-ctx-anchor')
  const delBtn = $('#timeline-ctx-del')
  if (!id || !menuEl || !anchorEl || !delBtn) return

  setSortMenuOpen(false)
  const tipEl = $('#timeline-detail-tip')
  if (tipEl) tipEl.hidden = true
  closeAllSwipeRows(false, row.closest('#view-timeline') || document)
  closeContextMenu({ restoreFocus: false })

  const fromKeyboard = event.button === 0 && event.clientX === 0 && event.clientY === 0
  const cardEl = row.querySelector('.timeline-swipe-content') || row
  const rect = cardEl.getBoundingClientRect()
  const rawX = fromKeyboard ? rect.left + 16 : event.clientX
  const rawY = fromKeyboard ? rect.bottom - 4 : event.clientY

  anchorEl.style.left = `${rawX}px`
  anchorEl.style.top = `${rawY}px`

  ctxState.id = id
  ctxState.row = row
  ctxState.fromKeyboard = fromKeyboard
  cardEl.classList.add('is-ctx-active')

  menuEl.hidden = false
  if (typeof menuEl.showPopover === 'function') {
    try {
      menuEl.showPopover({ source: anchorEl })
    } catch {
      try { menuEl.showPopover() } catch { /* 兼容非顶层环境 */ }
    }
  }

  if (supportsAnchorMenuPositioning()) {
    menuEl.style.left = ''
    menuEl.style.top = ''
  } else {
    const vw = window.innerWidth || 1024
    const vh = window.innerHeight || 768
    const menuW = menuEl.offsetWidth || 124
    const menuH = menuEl.offsetHeight || 42
    const margin = 8
    const offset = 4
    const nextX = rawX + offset + menuW > vw - margin ? rawX - menuW - offset : rawX + offset
    const nextY = rawY + offset + menuH > vh - margin ? rawY - menuH - offset : rawY + offset
    menuEl.style.left = `${Math.max(margin, Math.min(nextX, vw - menuW - margin))}px`
    menuEl.style.top = `${Math.max(margin, Math.min(nextY, vh - menuH - margin))}px`
  }

  delBtn.focus({ preventScroll: true })
}

function bindContextMenuEvents() {
  if (ctxMenuBound) return
  const menuEl = $('#timeline-ctx-menu')
  const delBtn = $('#timeline-ctx-del')
  if (!menuEl || !delBtn) return
  ctxMenuBound = true

  // 不支持原生 focusgroup 的浏览器补齐 ARIA 菜单语义与方向键巡航
  const groupEl = menuEl.querySelector('[focusgroup]')
  if (groupEl && !('focusGroup' in window.HTMLElement.prototype)) {
    groupEl.setAttribute('role', 'menu')
    const items = [...groupEl.querySelectorAll('.timeline-ctx-item')]
    items.forEach(item => item.setAttribute('role', 'menuitem'))
    groupEl.addEventListener('keydown', e => {
      const activeItems = items.filter(el => !el.hidden && !el.disabled)
      if (!activeItems.length) return
      const cur = activeItems.indexOf(document.activeElement)
      let next = -1
      if (e.key === 'ArrowDown') next = cur < activeItems.length - 1 ? cur + 1 : 0
      else if (e.key === 'ArrowUp') next = cur > 0 ? cur - 1 : activeItems.length - 1
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = activeItems.length - 1
      if (next !== -1) {
        e.preventDefault()
        activeItems[next].focus({ preventScroll: true })
      }
    })
  }

  menuEl.addEventListener('toggle', e => {
    if (e.newState === 'closed') {
      const prevRow = ctxState.row
      const shouldFocus = ctxState.fromKeyboard && prevRow?.isConnected
      clearCtxHighlight()
      menuEl.hidden = true
      if (shouldFocus) prevRow.focus({ preventScroll: true })
    }
  })

  menuEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeContextMenu({ restoreFocus: true })
    }
  })

  delBtn.addEventListener('click', e => {
    e.stopPropagation()
    const targetId = ctxState.id
    const tier = ctxState.row?.dataset.tier || ''
    const restoreFocus = ctxState.fromKeyboard
    deleteTimelineItem(targetId, { restoreFocus, tier })
  })

  document.addEventListener('pointerdown', e => {
    if (!menuEl.hidden && !menuEl.contains(e.target)) closeContextMenu({ restoreFocus: false })
  })

  document.addEventListener('click', e => {
    if (!menuEl.hidden && !menuEl.contains(e.target)) closeContextMenu({ restoreFocus: false })
  })

  document.addEventListener('contextmenu', e => {
    if (!menuEl.hidden && !menuEl.contains(e.target) && !e.target.closest('#view-timeline [data-reorder]')) {
      closeContextMenu({ restoreFocus: false })
    }
  })

  window.addEventListener('resize', () => {
    if (!menuEl.hidden) closeContextMenu({ restoreFocus: false })
  }, { passive: true })

  window.addEventListener('scroll', () => {
    if (!menuEl.hidden) closeContextMenu({ restoreFocus: false })
  }, { passive: true })
}

function getRestScrollLeft(row) {
  const leading = row?.querySelector('.timeline-swipe-leading')
  return leading ? leading.offsetWidth : 0
}

function isSwipeRowOpen(row) {
  if (!row) return false
  if (row.classList.contains('is-swipe-open')) return true
  const rest = getRestScrollLeft(row)
  return rest > 0 && Math.abs(row.scrollLeft - rest) > SWIPE_OPEN_TOLERANCE
}

function syncSwipeRowState(row) {
  if (!row) return
  const rest = getRestScrollLeft(row)
  if (rest <= 0) {
    row.classList.remove('is-swipe-open')
    return
  }
  const delta = row.scrollLeft - rest
  const openLeading = delta < -SWIPE_OPEN_TOLERANCE
  const openTrailing = delta > SWIPE_OPEN_TOLERANCE
  row.classList.toggle('is-swipe-open', openLeading || openTrailing)
  const leadBtn = row.querySelector('.timeline-swipe-leading .timeline-swipe-del')
  const trailBtn = row.querySelector('.timeline-swipe-trailing .timeline-swipe-del')
  if (leadBtn) leadBtn.tabIndex = openLeading ? 0 : -1
  if (trailBtn) trailBtn.tabIndex = openTrailing ? 0 : -1
}

function resetSwipeRow(row, smooth = true) {
  if (!row) return
  const rest = getRestScrollLeft(row)
  row.classList.remove('is-swipe-open')
  row.querySelectorAll('.timeline-swipe-del').forEach(btn => { btn.tabIndex = -1 })
  if (typeof row.scrollTo === 'function' && typeof window.CSS?.supports === 'function') {
    row.scrollTo({ left: rest, behavior: smooth ? 'smooth' : 'instant' })
  } else {
    row.scrollLeft = rest
  }
}

function closeAllSwipeRows(smooth = true, scope = document, exceptRow = null) {
  scope.querySelectorAll('#view-timeline .timeline-swipe-row').forEach(row => {
    if (row === exceptRow) return
    if (isSwipeRowOpen(row)) resetSwipeRow(row, smooth)
  })
}

function initSingleSwipeRow(row) {
  const rest = getRestScrollLeft(row)
  if (rest <= 0) return
  if (row.dataset.swipeInit !== '1') {
    row.classList.remove('is-swipe-ready')
    row.scrollLeft = rest
    row.dataset.swipeInit = '1'
    queueMicrotask(() => row.classList.add('is-swipe-ready'))
  }
}

function initSwipeRows() {
  const rows = $$('#view-timeline .timeline-swipe-row')
  if (!swipeResizeObserver && typeof window.ResizeObserver === 'function') {
    swipeResizeObserver = new window.ResizeObserver(entries => {
      entries.forEach(entry => initSingleSwipeRow(entry.target))
    })
  }
  swipeResizeObserver?.disconnect()
  rows.forEach(row => {
    initSingleSwipeRow(row)
    swipeResizeObserver?.observe(row)
  })
}

// ── 排序下拉菜单标签与激活状态同步 ───────────────────
function formatSortButtonLabel(sortCfg) {
  if (sortCfg.mode === 'startDate') return '排序：按开始时间'
  if (sortCfg.mode === 'deadline')  return '排序：按截止时间'
  if (sortCfg.mode === 'quadrant') {
    if (sortCfg.subTimeSort === 'startDate') return '排序：重要紧急 · 开始时间'
    if (sortCfg.subTimeSort === 'deadline')  return '排序：重要紧急 · 截止时间'
    return '排序：重要紧急程度'
  }
  return '排序：手动拖拽'
}

function syncSortDropdownUI(sortCfg) {
  const labelEl = $('#timeline-sort-label')
  if (labelEl) labelEl.textContent = formatSortButtonLabel(sortCfg)

  $$('#timeline-sort-menu .sort-menu-item[data-sort-mode]').forEach(btn => {
    const active = btn.dataset.sortMode === sortCfg.mode
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-pressed', String(active))
  })

  const subSortBox = $('#timeline-sort-sub')
  const subSortDisabled = sortCfg.mode !== 'quadrant'
  subSortBox?.classList.toggle('is-disabled', subSortDisabled)
  subSortBox?.setAttribute('aria-disabled', String(subSortDisabled))

  $$('#timeline-sort-sub .sort-sub-btn[data-sub-sort]').forEach(btn => {
    const active = (sortCfg.subTimeSort || 'none') === btn.dataset.subSort
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-pressed', String(active))
    btn.disabled = subSortDisabled
  })
}

function setSortMenuOpen(open) {
  $('#timeline-sort-dropdown')?.classList.toggle('open', open)
  $('#timeline-sort-btn')?.setAttribute('aria-expanded', String(open))
}
svcTimeline.closeSortMenu = () => setSortMenuOpen(false)

function bindSortDropdownEvents() {
  if (sortDropdownBound) return
  const dropdown = $('#timeline-sort-dropdown')
  const btn      = $('#timeline-sort-btn')
  const menu     = $('#timeline-sort-menu')
  if (!dropdown || !btn || !menu) return
  sortDropdownBound = true

  btn.addEventListener('click', e => {
    e.stopPropagation()
    setSortMenuOpen(!dropdown.classList.contains('open'))
  })

  document.addEventListener('click', e => {
    if (!dropdown.contains(e.target)) setSortMenuOpen(false)
  })

  menu.addEventListener('click', e => {
    const modeBtn = e.target.closest('.sort-menu-item[data-sort-mode]')
    const subBtn  = e.target.closest('.sort-sub-btn[data-sub-sort]')
    if (!modeBtn && !subBtn) return
    e.stopPropagation()

    const cfg = svcTimelineSort.loadTimelineSort()
    if (modeBtn) {
      cfg.mode = modeBtn.dataset.sortMode
    } else {
      if (cfg.mode !== 'quadrant') return
      cfg.subTimeSort = subBtn.dataset.subSort || 'none'
    }
    syncSortDropdownUI(svcTimelineSort.saveTimelineSort(cfg))
    renderTimeline(svcTasks.loadTasks(), svcTasks.loadGoals())
    // 选择「重要紧急程度」后保持菜单展开，便于继续选择二级排序
    if (subBtn || cfg.mode !== 'quadrant') setSortMenuOpen(false)
  })
}

// ── 统一排序提交与 FLIP 动画（桌面指针 / 触屏 / 键盘共用） ──
/**
 * 读取列表当前 DOM 顺序并持久化；短/中期由 reorderTimelineTier 自动切回手动排序。
 * @param {string} tier
 * @param {string} [focusId] 需要恢复焦点的条目 ID（键盘排序使用）
 * @param {{ rerender?: boolean }} [options] 拖拽动画落位后可设 rerender: false 避免重绘闪烁
 */
function commitTierOrder(tier, focusId, { rerender = true } = {}) {
  const list = $(TIER_LISTS[tier])
  if (!list) return
  const orderedIds = [...list.querySelectorAll(REORDER_SEL)].map(el => el.dataset.id).filter(Boolean)
  const prevMode = svcTimelineSort.loadTimelineSort().mode
  svcTimelineSort.reorderTimelineTier(tier, orderedIds)
  const nextCfg = svcTimelineSort.loadTimelineSort()
  syncSortDropdownUI(nextCfg)
  if (tier !== 'long' && prevMode !== 'manual') svcUi.showToast('已切换为手动拖拽排序')
  if (rerender) renderTimeline(svcTasks.loadTasks(), svcTasks.loadGoals())
  if (focusId) $(TIER_LISTS[tier])?.querySelector(`${REORDER_SEL}[data-id="${CSS.escape(focusId)}"]`)?.focus()
}
svcTimeline.commitTierOrder = commitTierOrder

/**
 * FLIP (First-Last-Invert-Play) 列表重排动画：
 * 在 DOM 换位前后采集兄弟卡片的视觉纵坐标，取消进行中的旧动画后以 translate 平滑过渡到新槽位。
 * 同时锁定容器 scrollTop，防止浏览器滚动锚定（Scroll Anchoring）在向上跨越锚点插入节点时将滚动条向下回弹。
 */
svcTimeline.animateFlipReorder = (list, mutateDom) => {
  const prevScrollTop = list.scrollTop
  const siblings = [...list.querySelectorAll(`${REORDER_SEL}:not(.is-touch-source)`)]
  const firstTops = new Map(siblings.map(el => [el, el.getBoundingClientRect().top]))
  mutateDom()
  if (list.scrollTop !== prevScrollTop) list.scrollTop = prevScrollTop
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return

  siblings.forEach(el => {
    const firstTop = firstTops.get(el)
    if (firstTop == null) return
    if (el._flipAnim) {
      el._flipAnim.cancel()
      el._flipAnim = null
    }
    if (list.scrollTop !== prevScrollTop) list.scrollTop = prevScrollTop
    const lastTop = el.getBoundingClientRect().top
    const dy = firstTop - lastTop
    if (Math.abs(dy) < 1 || typeof el.animate !== 'function') return
    const anim = el.animate(
      [{ translate: `0 ${dy}px` }, { translate: '0 0' }],
      { duration: 250, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    )
    el._flipAnim = anim
    const clear = () => { if (el._flipAnim === anim) el._flipAnim = null }
    anim.onfinish = clear
    anim.oncancel = clear
  })
}

/**
 * 计算指针纵坐标对应的插入锚点元素。
 * 优先使用不受 translate 动画影响的纯布局坐标（offsetTop），杜绝 FLIP 动画进行中反复横跳。
 */
svcTimeline.getDragAfterElement = (container, y) => {
  const containerRect = container.getBoundingClientRect()
  const els = [...container.querySelectorAll(`${REORDER_SEL}:not(.dragging)`)]
  return els.reduce((closest, child) => {
    const box = child.getBoundingClientRect()
    const layoutTop = child.offsetHeight > 0
      ? containerRect.top + child.offsetTop - container.scrollTop
      : box.top
    const height = child.offsetHeight > 0 ? child.offsetHeight : box.height
    const offset = y - (layoutTop + height / 2)
    return offset < 0 && offset > closest.offset ? { offset, element: child } : closest
  }, { offset: Number.NEGATIVE_INFINITY }).element
}

/** 将拖拽中的条目放到指针位置，目标槽位变化时触发兄弟卡片 FLIP 过渡 */
svcTimeline.placeDraggedItem = (list, item, y) => {
  const afterEl = svcTimeline.getDragAfterElement(list, y)
  const targetRef = afterEl ?? list.querySelector('.timeline-inline-add')
  if (item === targetRef || item.nextElementSibling === targetRef) return false
  svcTimeline.animateFlipReorder(list, () => {
    list.insertBefore(item, targetRef)
    // 节点换位会重置原生横向滚动位置，立即收起两侧删除抽屉。
    resetSwipeRow(item, false)
  })
  return true
}

// ── 列表事件委托（只绑定一次） ───────────────────────

function bindListEvents() {
  if (listEventsBound) return
  listEventsBound = true

  const viewEl = $('#view-timeline')
  const tipEl = $('#timeline-detail-tip')
  if (viewEl) {
    viewEl.addEventListener('pointerdown', e => {
      if (e.pointerType) lastPointerType = e.pointerType
    }, true)
    viewEl.addEventListener('pointermove', e => {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') lastPointerType = e.pointerType
    }, { capture: true, passive: true })
    viewEl.addEventListener('touchstart', () => {
      lastPointerType = 'touch'
    }, { capture: true, passive: true })
    viewEl.addEventListener('pointerdown', e => {
      if (tipEl && !tipEl.hidden && !e.target.closest('.timeline-list')) tipEl.hidden = true
      if (!e.target.closest('.timeline-swipe-row')) closeAllSwipeRows(true, viewEl)
    })
  }

  Object.entries(TIER_LISTS).forEach(([tier, sel]) => {
    const list = $(sel)
    if (!list) return

    if (tier !== 'long') {
      svcWidgets.bindLongPressTip(list, {
        tipEl,
        itemSelector: REORDER_SEL,
        ignoreSelector: '[data-action], button, a, input, textarea, .drag-handle, .timeline-swipe-panel',
        getText: row => row.querySelector('[data-notes]')?.dataset.notes || row.dataset.notes || '',
      })
    }

    list.addEventListener('scroll', e => {
      if (tipEl && !tipEl.hidden) tipEl.hidden = true
      const target = e.target
      if (target === list) {
        closeContextMenu({ restoreFocus: false })
        return
      }
      if (!(target instanceof window.HTMLElement) || !target.classList.contains('timeline-swipe-row')) return
      if (target.dataset.swipeInit !== '1') return
      syncSwipeRowState(target)
      if (target.classList.contains('is-swipe-open')) {
        closeAllSwipeRows(true, viewEl || document, target)
      }
    }, { capture: true, passive: true })

    list.addEventListener('contextmenu', e => {
      if (e.target.closest('.timeline-swipe-panel')) {
        e.preventDefault()
        return
      }
      const row = e.target.closest(REORDER_SEL)
      if (!row || !list.contains(row)) return
      const pType = typeof e.pointerType === 'string' && e.pointerType ? e.pointerType : lastPointerType
      e.preventDefault()
      // 触屏长按保留查看备注气泡与手柄拖拽，不弹桌面端右键菜单
      if (pType === 'touch') return
      openContextMenu(row, e)
    })

    list.addEventListener('click', e => {
      // 拖拽刚落位时屏蔽点击，防止误触
      if (list.dataset.justDragged === '1') {
        e.preventDefault()
        e.stopPropagation()
        return
      }

      const actionEl = e.target.closest('[data-action]')
      if (actionEl && list.contains(actionEl)) {
        // 命中明确交互控件：按自身语义处理，不再向上冒泡触发卡片编辑
        e.stopPropagation()
        const { action, id } = actionEl.dataset
        if (action === 'toggle') {
          if (svcTasks.toggleTaskStatus(id)) renderTimeline(svcTasks.loadTasks(), svcTasks.loadGoals())
        } else if (action === 'subtask') {
          if (svcTasks.toggleSubtask(id, Number(actionEl.dataset.subIdx))) renderTimeline(svcTasks.loadTasks(), svcTasks.loadGoals())
        } else if (action === 'swipe-delete') {
          deleteTimelineItem(id, { restoreFocus: false, tier })
        }
        return
      }

      // 点击滑动面板空白区或拖拽手柄时不触发编辑
      if (e.target.closest('.drag-handle, .timeline-swipe-panel')) return

      // 点击卡片本体（排序条目范围内）：若存在已滑开的删除抽屉则优先收起，否则触发编辑
      const card = e.target.closest(REORDER_SEL)
      if (!card || !list.contains(card)) return
      if (isSwipeRowOpen(card)) {
        e.preventDefault()
        e.stopPropagation()
        resetSwipeRow(card, true)
        return
      }
      const scope = viewEl || document
      const openOther = [...scope.querySelectorAll('.timeline-swipe-row')].find(r => r !== card && isSwipeRowOpen(r))
      if (openOther) {
        e.preventDefault()
        e.stopPropagation()
        closeAllSwipeRows(true, scope)
        return
      }
      const id = card.dataset.id
      if (!id) return
      // 主动失焦，防止 :focus-within 让拖拽手柄一直显示
      card.blur()
      if (tier === 'long') editGoal(id)
      else editTask(id)
    })

    list.addEventListener('keydown', e => {
      const item = e.target.closest(REORDER_SEL)
      if (!item || item !== e.target) return

      // 回车键直接打开当前聚焦条目的编辑弹窗
      if (!e.altKey && !e.ctrlKey && !e.metaKey && e.key === 'Enter') {
        e.preventDefault()
        const id = item.dataset.id
        if (!id) return
        if (tier === 'long') editGoal(id)
        else editTask(id)
        return
      }

      // 键盘排序：Alt + ↑/↓ 在同层级内移动当前聚焦条目并播放 FLIP 过渡
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      e.preventDefault()
      const sibling = e.key === 'ArrowUp' ? item.previousElementSibling : item.nextElementSibling
      if (!sibling?.matches(REORDER_SEL)) return
      svcTimeline.animateFlipReorder(list, () => {
        if (e.key === 'ArrowUp') list.insertBefore(item, sibling)
        else list.insertBefore(sibling, item)
      })
      commitTierOrder(tier, item.dataset.id, { rerender: false })
    })

    // 拦截浏览器原生 HTML5 dragstart（避免原生拖拽劫持自动滚动），统一由 touch-drag.js 指针/触控引擎接管
    list.addEventListener('dragstart', e => {
      if (e.target.closest(REORDER_SEL)) e.preventDefault()
    })
  })
}

// ── 通用条目片段 ──────────────────────────────────────
function buildQuadrantIndicator(qKey) {
  const label = QUADRANTS[qKey].label
  return html`<span class="task-q-indicator" data-q="${qKey}" role="img" aria-label="${label}" title="${label}"></span>`
}

function buildDateBadges(task) {
  const overdue = task.deadline && svcDates.isOverdue(task.deadline) && task.status !== 'done'
  return html`
    ${task.startDate ? html`<span class="task-start-date">起 ${svcDates.formatDate(task.startDate)}</span>` : ''}
    ${task.deadline ? html`<span class="task-deadline${overdue ? ' overdue' : ''}">止 ${svcDates.formatDate(task.deadline)}</span>` : ''}`
}

// 操作栏：仅保留拖拽手柄，编辑通过点击卡片、删除通过桌面右键或移动端左右滑完成
function buildItemActions(id, title) {
  return html`
    <span class="drag-handle" title="拖拽排序" aria-label="拖拽调整「${title}」顺序"><span class="drag-handle-bar"><span></span><span></span><span></span></span></span>`
}

/** 可排序条目公共属性：可聚焦、可拖拽、提供键盘排序提示 */
function reorderAttrs(title) {
  return html`draggable="true" data-reorder tabindex="0" aria-label="${title}（Alt+↑/↓ 调整顺序）"`
}

function buildSwipeDeletePanel(id, title, side) {
  return html`
    <div class="timeline-swipe-panel timeline-swipe-${side}">
      <button type="button" class="timeline-swipe-del" data-action="swipe-delete" data-id="${id}"
        tabindex="-1" aria-label="删除「${title}」">删除</button>
    </div>`
}

function renderSwipeRow(id, tier, title, cardContent, quadrant = '') {
  return html`
    <div class="timeline-swipe-row" ${reorderAttrs(title)} data-id="${id}" data-tier="${tier}" data-q="${quadrant}">
      ${buildSwipeDeletePanel(id, title, 'leading')}
      ${cardContent}
      ${buildSwipeDeletePanel(id, title, 'trailing')}
    </div>`
}

function renderTaskItem(task) {
  const isDone = task.status === 'done'
  const qKey   = QUADRANTS[task.quadrant] ? task.quadrant : 'do'
  const notes  = (task.notes || '').trim()
  return renderSwipeRow(task.id, 'short', task.title, html`
    <div class="task-item timeline-swipe-content${isDone ? ' done' : ''}" data-q="${qKey}"
      ${notes ? html`title="${notes}" data-notes="${notes}"` : ''}>
      <button type="button" class="task-check${isDone ? ' checked' : ''}" data-action="toggle" data-id="${task.id}"
        role="checkbox" aria-checked="${String(isDone)}" aria-label="完成「${task.title}」"></button>
      <div class="task-info">
        <div class="task-title-row">${buildQuadrantIndicator(qKey)}<div class="task-title">${task.title}</div></div>
        <div class="task-meta">
          ${buildDateBadges(task)}
        </div>
      </div>
      <div class="task-actions">${buildItemActions(task.id, task.title)}</div>
    </div>`, qKey)
}

const INLINE_ADD_COPY = {
  short: { title: '添加短期待办', hint: '记录接下来要完成的事情' },
  mid:   { title: '添加中期目标', hint: '把阶段目标拆解并持续推进' },
  long:  { title: '添加长期愿景', hint: '写下希望逐步实现的方向' },
}

function renderInlineAddCard(tier, isEmpty) {
  const copy = INLINE_ADD_COPY[tier]
  return html`
    <button type="button" class="timeline-inline-add${isEmpty ? ' is-empty' : ''}" data-tier="${tier}">
      <span class="timeline-inline-add-icon" aria-hidden="true">＋</span>
      <span class="timeline-inline-add-copy">
        <span class="timeline-inline-add-title">${copy.title}</span>
        <span class="timeline-inline-add-hint">${isEmpty ? copy.hint : '继续添加'}</span>
      </span>
    </button>`
}

function renderMidCard(task) {
  const subs      = task.subtasks || []
  const doneCount = subs.filter(s => s.done).length
  const progress  = subs.length > 0 ? Math.round(doneCount / subs.length * 100) : 0
  const qKey      = QUADRANTS[task.quadrant] ? task.quadrant : 'do'
  const notes     = (task.notes || '').trim()
  const dateBadges = buildDateBadges(task)

  return renderSwipeRow(task.id, 'mid', task.title, html`
    <div class="goal-card timeline-swipe-content" data-q="${qKey}"
      ${notes ? html`title="${notes}" data-notes="${notes}"` : ''}>
      <div class="quadrant-header">
        <div class="task-title-row">${buildQuadrantIndicator(qKey)}<div class="goal-title">${task.title}</div></div>
        <div class="quadrant-header-right">
          ${dateBadges ? html`<div class="goal-dates">${dateBadges}</div>` : ''}
          ${buildItemActions(task.id, task.title)}
        </div>
      </div>
      ${subs.length > 0 ? html`
        <div class="goal-progress-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
          <div class="goal-progress-fill" style="width:${progress}%"></div>
        </div>
        <div class="goal-progress-text">${doneCount}/${subs.length} 完成 (${progress}%)</div>
        <div class="goal-subtasks">
          ${subs.map((s, i) => html`
            <button type="button" class="goal-subtask${s.done ? ' done' : ''}" data-action="subtask" data-id="${task.id}" data-sub-idx="${i}"
              role="checkbox" aria-checked="${String(Boolean(s.done))}">${s.done ? '☑' : '☐'} ${s.text}</button>`)}
        </div>` : ''}
    </div>`, qKey)
}

function renderVisionCard(goal) {
  return renderSwipeRow(goal.id, 'long', goal.title, html`
    <div class="vision-card timeline-swipe-content">
      <div class="quadrant-header">
        <div class="vision-title">${goal.title}</div>
        <div class="quadrant-header-right">${buildItemActions(goal.id, goal.title)}</div>
      </div>
      ${goal.notes ? html`<div class="vision-desc">${goal.notes}</div>` : ''}
    </div>`)
}

function renderTier(tier, items, count, renderItem) {
  const list = $(TIER_LISTS[tier])
  if (!list) return
  const countEl = $(`#${tier}-count`)
  if (countEl) countEl.textContent = count
  svcDom.setHTML(list, html`${items.map(renderItem)}${renderInlineAddCard(tier, items.length === 0)}`)
}

// ── 渲染时间轴 ────────────────────────────────────────
function renderTimeline(tasks = [], goals = []) {
  bindSortDropdownEvents()
  bindContextMenuEvents()
  bindListEvents()
  closeContextMenu({ restoreFocus: false })
  const sortCfg = svcTimelineSort.loadTimelineSort()
  syncSortDropdownUI(sortCfg)

  const shortTasks = tasks.filter(t => t.tier === 'short')
  const activeShort = svcTimelineSort.sortTimelineTasks(shortTasks.filter(t => t.status === 'active'), sortCfg)
  const doneShort   = svcTimelineSort.sortTimelineTasks(shortTasks.filter(t => t.status === 'done'), sortCfg)
  renderTier('short', [...activeShort, ...doneShort], activeShort.length, renderTaskItem)

  const midTasks = svcTimelineSort.sortTimelineTasks(tasks.filter(t => t.tier === 'mid' && t.status === 'active'), sortCfg)
  renderTier('mid', midTasks, midTasks.length, renderMidCard)

  renderTier('long', goals, goals.length, renderVisionCard)

  initSwipeRows()
  bindTimelineTouchDrag()
}

svcTimeline.TIER_LISTS = TIER_LISTS
svcTimeline.renderTimeline = renderTimeline
