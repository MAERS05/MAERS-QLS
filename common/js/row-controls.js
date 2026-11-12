export const rowControls = {}

const GROUPS = '.view-tabs, .tb-segment-tabs, .segmented-control, .transfer-roles, .cal-mode-switch'
const ITEM = 'button, a[href], label'
const HOLD_MS = 60
const MOVE_TOLERANCE = 8
let started = false

function bind(group, reducedMotion) {
  const kind = group.matches('.tb-segment-tabs') ? 'multi' : 'tabs'
  const indicator = document.createElement('span')
  indicator.className = 'row-control-indicator'
  indicator.setAttribute('aria-hidden', 'true')
  group.prepend(indicator)
  group.dataset.rowKind = kind
  const abort = new AbortController()
  const on = (name, handler, options = {}) => group.addEventListener(name, handler, { ...options, signal: abort.signal })
  let frame = 0, holdTimer = null, settleTimer = null, gesture = null, settlingTarget = null
  let currentItem = null
  let clientX = 0, handledAt = -Infinity, ready = false
  const items = () => [...group.children].filter(item => item.matches(ITEM) && !item.hidden && item.getClientRects().length)
  const enabled = item => !item.matches(':disabled, [aria-disabled="true"]')
  const selected = item => item.matches('[aria-selected="true"], [aria-pressed="true"], .active, .selected') || !!item.querySelector('input:checked')
  const controlOf = target => items().find(item => item === target || item.contains(target))
  const focus = item => (item.querySelector('input') || item).focus({ preventScroll: true })
  function request() {
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; refresh() })
  }
  function release(pointerId) {
    if (group.hasPointerCapture?.(pointerId)) group.releasePointerCapture(pointerId)
  }
  function geometry() {
    const rect = group.getBoundingClientRect()
    const list = items().map(item => ({ item, x: item.offsetLeft, y: item.offsetTop,
      width: item.offsetWidth, height: item.offsetHeight }))
    return { rect, list, x: clientX - rect.left - group.clientLeft + group.scrollLeft }
  }
  function nearest(list, x) {
    return list.filter(entry => enabled(entry.item)).reduce((best, entry) =>
      !best || Math.abs(entry.x + entry.width / 2 - x) < Math.abs(best.x + best.width / 2 - x) ? entry : best, null)
  }
  function refresh() {
    if (!group.isConnected || !group.getClientRects().length) return
    if (!group.classList.contains('row-control-group')) group.classList.add('row-control-group')
    const { list, x } = geometry()
    if (!list.length) { group.removeAttribute('data-row-visible'); return }
    list.forEach(({ item }) => {
      if (!item.classList.contains('row-control-item')) item.classList.add('row-control-item')
      item.toggleAttribute('data-row-selected', selected(item))
    })
    const pointing = gesture?.active === true
    const actual = list.find(entry => selected(entry.item))
    const remembered = list.find(entry => entry.item === currentItem)
    const target = (pointing ? nearest(list, x) : null) || (kind === 'tabs' ? actual : null) ||
      list.find(entry => entry.item === settlingTarget) || remembered || actual || list.find(entry => enabled(entry.item)) || list[0]
    if (!pointing) currentItem = target.item
    list.forEach(({ item }) => item.toggleAttribute('data-row-target', item === target?.item))
    group.toggleAttribute('data-row-visible', !!target)
    group.toggleAttribute('data-row-following', pointing)
    if (!target) return
    let width = pointing ? gesture.width : target.width
    let height = pointing ? gesture.height : target.height
    let left = target.x, top = target.y
    if (pointing && enabled(target.item) && !reducedMotion.matches) {
      const available = list.filter(entry => enabled(entry.item))
      const center = entry => entry.x + entry.width / 2
      const first = center(available[0]), last = center(available.at(-1))
      const followX = Math.max(first, Math.min(last, x))
      left = followX - width / 2
    }
    // 长按期间锁定实际宽高，仅移动位置；松手后再适配选项。
    const trackLeft = Math.max(2, Math.min(...list.map(entry => entry.x)))
    const trackRight = Math.min(group.clientWidth - 2, Math.max(...list.map(entry => entry.x + entry.width)))
    width = Math.max(1, Math.min(width, trackRight - trackLeft))
    height = Math.max(1, Math.min(height, group.clientHeight - 4))
    left = Math.max(trackLeft, Math.min(trackRight - width, left))
    top = Math.max(2, Math.min(group.clientHeight - 2 - height, top))
    group.style.setProperty('--row-width', width + 'px')
    group.style.setProperty('--row-height', height + 'px')
    group.style.setProperty('--row-x', left + 'px')
    group.style.setProperty('--row-y', top + 'px')
    if (!ready) {
      ready = true
      requestAnimationFrame(() => { if (group.isConnected) group.setAttribute('data-row-ready', '') })
    }
  }
  function finish(item = null) {
    clearTimeout(holdTimer); clearTimeout(settleTimer)
    const id = gesture?.id
    gesture = null; settlingTarget = item
    if (item) currentItem = item
    if (id !== undefined) release(id)
    if (item) {
      settleTimer = setTimeout(() => {
        settlingTarget = null; group.removeAttribute('data-row-sliding'); request()
      }, 260)
    } else group.removeAttribute('data-row-sliding')
    request()
  }
  const cancel = () => {
    if (!gesture && !settlingTarget) return
    const active = gesture?.active
    if (active) handledAt = performance.now()
    finish(active && kind === 'tabs' ? items().find(selected) : null)
  }
  on('pointerleave', () => { if (gesture && !gesture.active) cancel() })
  on('pointerdown', event => {
    if (!event.isPrimary || event.button !== 0 || gesture) return
    if (kind !== 'tabs') return
    const item = controlOf(event.target)
    if (!item || !enabled(item)) return
    finish()
    handledAt = -Infinity
    const pending = { id: event.pointerId, item, x: event.clientX, y: event.clientY,
      armed: false, active: false, canceled: false }
    gesture = pending; clientX = event.clientX
    holdTimer = setTimeout(() => {
      if (gesture !== pending || pending.canceled) return
      if (!group.isConnected || !item.isConnected || !enabled(item)) { finish(); return }
      const bounds = indicator.getBoundingClientRect()
      pending.width = bounds.width || item.offsetWidth
      pending.height = bounds.height || item.offsetHeight
      pending.armed = true
    }, HOLD_MS)
  })
  on('pointermove', event => {
    if (!gesture || gesture.id !== event.pointerId || gesture.canceled) return
    if (!gesture.active) {
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= MOVE_TOLERANCE) return
      if (!gesture.armed) {
        clearTimeout(holdTimer); gesture.canceled = true
        return
      }
      // 达到长按时间只准备滑动，实际移动后才接管指针，避免点击产生偏移。
      try { group.setPointerCapture(gesture.id) } catch { finish(); return }
      gesture.active = true
      group.setAttribute('data-row-sliding', '')
      focus(gesture.item)
    }
    if (event.cancelable) event.preventDefault()
    clientX = event.clientX
    request()
  }, { passive: false })
  on('pointerup', event => {
    if (!gesture || gesture.id !== event.pointerId) return
    if (!gesture.active) {
      if (gesture.canceled) { handledAt = performance.now(); event.preventDefault() }
      finish()
      return
    }
    clientX = event.clientX
    const { rect, list, x } = geometry()
    const inside = event.clientX >= rect.left - 16 && event.clientX <= rect.right + 16 &&
      event.clientY >= rect.top - 12 && event.clientY <= rect.bottom + 12
    const target = inside ? nearest(list, x)?.item : null
    handledAt = performance.now()
    finish(target || (kind === 'tabs' ? items().find(selected) : null))
    event.preventDefault()
    // 松手才切换，滑过其它选项时不会提前执行。
    if (target) { focus(target); target.click() }
    request()
  })
  on('pointercancel', cancel)
  on('lostpointercapture', event => {
    // 触屏从子按钮的隐式捕获转交给整组时，子按钮的事件也会冒泡到这里。
    if (event.target === group && gesture?.id === event.pointerId) cancel()
  })
  on('contextmenu', event => { if (gesture || settlingTarget) event.preventDefault() })
  on('dragstart', event => { if (gesture) event.preventDefault() })
  window.addEventListener('blur', cancel, { signal: abort.signal })
  window.addEventListener('scroll', cancel, { capture: true, passive: true, signal: abort.signal })
  on('click', event => {
    // 触控合成的后续 click 不能再次执行；键盘和 label 的原生激活照常处理。
    if (event.detail > 0 && performance.now() - handledAt < 500) {
      event.preventDefault(); event.stopImmediatePropagation()
    } else {
      const item = controlOf(event.target)
      if (item && enabled(item)) currentItem = item
      request()
    }
  }, { capture: true })
  on('change', request)
  on('focusin', event => {
    if (!gesture) {
      const item = controlOf(event.target)
      if (item && enabled(item)) currentItem = item
    }
    request()
  })
  on('focusout', request)
  on('keydown', () => {
    cancel()
    request()
  })
  return { request, destroy() {
    cancelAnimationFrame(frame); clearTimeout(holdTimer); clearTimeout(settleTimer); abort.abort()
    indicator.remove(); group.classList.remove('row-control-group')
    for (const name of ['data-row-sliding', 'data-row-ready', 'data-row-visible', 'data-row-following']) group.removeAttribute(name)
  } }
}

rowControls.init = () => {
  if (started || !window.PointerEvent) return
  started = true
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
  const groups = new Map()
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(entries => {
    entries.forEach(({ target }) => groups.get(target)?.request())
  }) : null
  function scan(node) {
    if (!(node instanceof Element) || !node.isConnected) return
    const candidates = [...(node.matches(GROUPS) ? [node] : []), ...node.querySelectorAll(GROUPS)]
    candidates.forEach(group => {
      if (groups.has(group) || [...group.children].filter(item => item.matches(ITEM)).length < 2) return
      const controller = bind(group, reducedMotion)
      groups.set(group, controller); resize?.observe(group); controller.request()
    })
  }
  scan(document.body)
  new MutationObserver(records => {
    records.forEach(record => {
      if (record.type === 'childList') record.addedNodes.forEach(scan)
      const group = record.target instanceof Element ? record.target.closest(GROUPS) : null
      groups.get(group)?.request()
    })
    groups.forEach((controller, group) => {
      if (!group.isConnected) { controller.destroy(); resize?.unobserve(group); groups.delete(group) }
    })
  }).observe(document.body, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['aria-selected', 'aria-pressed', 'checked', 'disabled', 'hidden', 'class'] })
  reducedMotion.addEventListener('change', () => groups.forEach(controller => controller.request()))
  window.addEventListener('resize', () => groups.forEach(controller => controller.request()))
}
