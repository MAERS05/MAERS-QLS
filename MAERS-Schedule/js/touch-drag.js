const svcTimelineDrag = {}
export const timelineDrag = svcTimelineDrag

/**
 * MAERS Schedule — 时间轴拖拽排序与 FLIP 动画控制器 (touch-drag.js)
 * 架构设计与职责：
 * 1. 交互分离：移动端专职手柄（.drag-handle）触发触控拖拽，彻底杜绝与页面原生滚动的竞态冲突；桌面端支持卡片与手柄鼠标拖拽；
 * 2. 帧率对齐与防抖重排：基于 requestAnimationFrame 统一批处理指针位移（Ghost translate）与边缘自动滚动，根除 120Hz 下 Layout Thrashing；
 * 3. 槽位判定优化：微幅位移防抖，跨越中心线时才触发 FLIP 挤压换位；落位时执行贝塞尔回弹并持久化新顺序。
 */
svcTimelineDrag.createTimelineDrag = ({ getLists, placeItem, commitOrder }) => {

// 拖拽激活最小像素位移阈值
const TOUCH_START_THRESHOLD = 3
const MOUSE_START_THRESHOLD = 4

// 自动滚动速度模型参数：按深入边缘距离调速 + 持续时长轻微缓入
const SCROLL_MIN_SPEED = 50
const SCROLL_MAX_SPEED = 180
const SCROLL_TOP_INNER_ZONE = 54
const SCROLL_TOP_OUTER_SPAN = 18
const SCROLL_BOTTOM_INNER_ZONE = 42
const SCROLL_BOTTOM_OUTER_SPAN = 32
const SCROLL_CURVE_EXP = 1.2
const SCROLL_TIME_BOOST_MAX = 1.00
const SCROLL_TIME_RAMP_SEC = 2.5
const SCROLL_TIME_CURVE_EXP = 1.45

// 位于交互控件上的按下不触发拖拽
const INTERACTIVE_SEL = '[data-action], button, a, input, textarea'

/**
 * 创建跟随指针的实心浮动纸卡副本（不带占位槽透明类）
 * @param {HTMLElement} item
 * @param {DOMRect} rect
 */
function createGhost(item, rect) {
  const ghost = item.cloneNode(true)
  ghost.classList.remove('dragging', 'is-touch-source')
  ghost.classList.add('touch-drag-ghost')
  ghost.setAttribute('aria-hidden', 'true')
  ghost.removeAttribute('tabindex')
  Object.assign(ghost.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
    translate: '0px 0px',
  })
  document.body.appendChild(ghost)
  return ghost
}

/**
 * 为单个时间轴列表绑定桌面鼠标与移动端触控拖拽（每个列表只绑定一次）
 * @param {HTMLElement} list
 * @param {string} tier
 */
function bindList(list, tier) {
  if (list.dataset.touchBound) return
  list.dataset.touchBound = '1'

  let item = null
  let ghost = null
  let initialRect = null
  let dragging = false

  let startX = 0
  let startY = 0
  let lastClientY = 0
  let currentDx = 0
  let currentDy = 0

  // rAF 批处理调度状态
  let rafId = null
  let pendingPointer = null
  let lastCheckedY = null

  // 自动滚动物理模型状态
  let scrollDir = 0          // -1=向上, 0=停止, 1=向下
  let scrollBaseSpeed = 0    // 基准速率 (px/s)
  let scrollElapsed = 0      // 连续滚动累计时长 (s)
  let virtualScrollTop = 0   // 浮点滚动位置
  let lastTickTime = 0

  /** 根据边缘距离计算基准滚动速率 */
  function computeBaseSpeed(dist, innerZone, outerSpan) {
    const clampedDist = Math.max(-outerSpan, dist)
    const depth = Math.min(1, Math.max(0, (innerZone - clampedDist) / (innerZone + outerSpan)))
    return SCROLL_MIN_SPEED + (SCROLL_MAX_SPEED - SCROLL_MIN_SPEED) * Math.pow(depth, SCROLL_CURVE_EXP)
  }

  /** 检测并更新自动滚动方向与基准速率 */
  function updateAutoScrollState(clientY) {
    if (!initialRect) return
    const listRect = list.getBoundingClientRect()
    const maxScroll = list.scrollHeight - list.clientHeight
    if (maxScroll <= 0) {
      scrollDir = 0
      return
    }

    const topZone = Math.min(SCROLL_TOP_INNER_ZONE, Math.max(38, listRect.height * 0.25))
    const bottomZone = Math.min(SCROLL_BOTTOM_INNER_ZONE, Math.max(34, listRect.height * 0.2))
    const ghostTop = initialRect.top + currentDy
    const ghostBottom = ghostTop + initialRect.height
    const effectiveTop = Math.min(clientY - 12, ghostTop)
    const effectiveBottom = Math.max(clientY, ghostBottom - 16)

    const topDist = effectiveTop - listRect.top
    const bottomDist = listRect.bottom - effectiveBottom

    const canScrollUp = clientY < startY - 2 || scrollDir === -1
    const canScrollDown = clientY > startY + 2 || scrollDir === 1

    if (topDist < topZone && list.scrollTop > 0 && canScrollUp) {
      if (scrollDir !== -1) {
        virtualScrollTop = list.scrollTop
        scrollElapsed = 0
        lastTickTime = performance.now()
      }
      scrollDir = -1
      scrollBaseSpeed = computeBaseSpeed(topDist, topZone, SCROLL_TOP_OUTER_SPAN)
    } else if (bottomDist < bottomZone && list.scrollTop < maxScroll && canScrollDown) {
      if (scrollDir !== 1) {
        virtualScrollTop = list.scrollTop
        scrollElapsed = 0
        lastTickTime = performance.now()
      }
      scrollDir = 1
      scrollBaseSpeed = computeBaseSpeed(bottomDist, bottomZone, SCROLL_BOTTOM_OUTER_SPAN)
    } else {
      scrollDir = 0
    }
  }

  /** 执行一步平滑自动滚动（按时间差 dt 增量） */
  function stepAutoScroll(now) {
    if (scrollDir === 0) return false
    const dt = Math.min(0.05, Math.max(0.001, (now - (lastTickTime || now)) / 1000))
    lastTickTime = now
    scrollElapsed += dt
    const timeProgress = Math.min(1, scrollElapsed / SCROLL_TIME_RAMP_SEC)
    const timeMultiplier = 1 + SCROLL_TIME_BOOST_MAX * Math.pow(timeProgress, SCROLL_TIME_CURVE_EXP)
    const effectiveSpeed = scrollBaseSpeed * timeMultiplier
    const maxScroll = Math.max(0, list.scrollHeight - list.clientHeight)
    const prevScroll = list.scrollTop
    virtualScrollTop = Math.max(0, Math.min(maxScroll, virtualScrollTop + scrollDir * effectiveSpeed * dt))
    list.scrollTop = Math.round(virtualScrollTop)
    return list.scrollTop !== prevScroll
  }

  /** 槽位命中检测与重排（防抖微幅震荡，仅跨越有效高度时触发） */
  function checkSlotPlacement(force = false) {
    if (!item || !initialRect) return
    const listRect = list.getBoundingClientRect()
    const ghostCenterY = initialRect.top + currentDy + initialRect.height / 2
    const clampedY = Math.max(listRect.top + 4, Math.min(listRect.bottom - 4, ghostCenterY))

    // 微幅抖动且未发生滚动跳过检测，节约重排开销
    if (!force && lastCheckedY !== null && Math.abs(clampedY - lastCheckedY) < 3) return
    lastCheckedY = clampedY

    placeItem(list, item, clampedY)
  }

  /** 单一 requestAnimationFrame 主渲染帧循环（对齐屏幕 VSync 刷新） */
  function renderFrame(now) {
    rafId = null
    if (!dragging || !item) return

    let pointerMoved = false
    if (pendingPointer) {
      lastClientY = pendingPointer.clientY
      currentDy = lastClientY - startY
      pendingPointer = null
      pointerMoved = true

      if (ghost) {
        ghost.style.translate = `0px ${currentDy.toFixed(1)}px`
      }
      updateAutoScrollState(lastClientY)
    }

    const scrolled = stepAutoScroll(now)
    if (pointerMoved || scrolled) {
      checkSlotPlacement(scrolled)
    }

    // 若处于自动滚动状态，持续按帧驱动
    if (scrollDir !== 0 && dragging && item) {
      scheduleFrame()
    }
  }

  function scheduleFrame() {
    if (rafId) return
    rafId = requestAnimationFrame(renderFrame)
  }

  /** 激活拖拽态：克隆实心浮动卡片，原位元素透明占位 */
  function activateDrag(vibrate = false) {
    if (!item || dragging) return
    dragging = true
    document.body.classList.add('is-touch-dragging')
    initialRect = item.getBoundingClientRect()
    if (item._flipAnim) {
      item._flipAnim.cancel()
      item._flipAnim = null
    }
    ghost = createGhost(item, initialRect)
    item.classList.add('dragging', 'is-touch-source')
    lastCheckedY = null
    if (vibrate) navigator.vibrate?.(35)
  }

  /** 结束拖拽：平滑过渡归位并提交新排序 */
  function finishDrag(vibrate = false) {
    document.body.classList.remove('is-touch-dragging')
    if (rafId) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    scrollDir = 0
    pendingPointer = null
    lastCheckedY = null

    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)

    const activeItem = item
    const activeGhost = ghost
    const startRect = initialRect
    const wasDragging = dragging

    item = null
    ghost = null
    initialRect = null
    dragging = false

    if (!wasDragging || !activeItem) {
      activeGhost?.remove()
      activeItem?.classList.remove('dragging', 'is-touch-source')
      return
    }

    list.dataset.justDragged = '1'
    setTimeout(() => { delete list.dataset.justDragged }, 0)

    commitOrder(tier, null, { rerender: false })
    if (vibrate) navigator.vibrate?.([20, 35])

    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    const targetRect = activeItem.getBoundingClientRect()
    if (activeGhost && startRect && !reducedMotion && typeof activeGhost.animate === 'function' && targetRect.height > 0) {
      const toDx = targetRect.left - startRect.left
      const toDy = targetRect.top - startRect.top
      activeGhost.classList.add('is-settling')
      const anim = activeGhost.animate(
        [
          { translate: `${currentDx.toFixed(1)}px ${currentDy.toFixed(1)}px` },
          { translate: `${toDx.toFixed(1)}px ${toDy.toFixed(1)}px` },
        ],
        { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' },
      )
      const cleanup = () => {
        activeGhost.remove()
        activeItem.classList.remove('dragging', 'is-touch-source')
      }
      anim.onfinish = cleanup
      anim.oncancel = cleanup
    } else {
      activeGhost?.remove()
      activeItem.classList.remove('dragging', 'is-touch-source')
    }
  }

  // ── 桌面端鼠标拖拽 ─────────────────────────────────
  function onMouseMove(e) {
    if (!item) return
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < MOUSE_START_THRESHOLD) return
      activateDrag(false)
    }
    e.preventDefault()
    pendingPointer = { clientX: e.clientX, clientY: e.clientY }
    scheduleFrame()
  }

  function onMouseUp() {
    finishDrag(false)
  }

  list.addEventListener('mousedown', e => {
    if (e.button !== 0) return
    // 点击交互控件（复选框、按钮、输入框）不触发拖拽
    if (e.target.closest(INTERACTIVE_SEL)) return
    const target = e.target.closest('[data-reorder]')
    if (!target) return

    item = target
    startX = e.clientX
    startY = e.clientY
    lastClientY = e.clientY
    currentDx = 0
    currentDy = 0
    dragging = false

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  })

  list.addEventListener('dragstart', e => {
    e.preventDefault()
  })

  // ── 移动端触控拖拽（方案 A：仅通过专职拖拽手柄 .drag-handle 触发） ──
  list.addEventListener('touchstart', e => {
    // 触控模式下只响应手柄按下，卡片主体完全保留给系统原生滚动与点击编辑
    const handle = e.target.closest('.drag-handle')
    if (!handle) return

    const target = handle.closest('[data-reorder]')
    if (!target) return

    item = target
    const touch = e.touches[0]
    startX = touch.clientX
    startY = touch.clientY
    lastClientY = touch.clientY
    currentDx = 0
    currentDy = 0
    dragging = false
  }, { passive: true })

  list.addEventListener('touchmove', e => {
    if (!item) return
    const touch = e.touches[0]

    if (!dragging) {
      // 在手柄上轻微滑动即可激活拖拽，手柄具备 touch-action: none 绝不与原生滚动竞态
      if (Math.hypot(touch.clientX - startX, touch.clientY - startY) >= TOUCH_START_THRESHOLD) {
        activateDrag(true)
      }
    }

    if (dragging) {
      if (e.cancelable) e.preventDefault()
      pendingPointer = { clientX: touch.clientX, clientY: touch.clientY }
      scheduleFrame()
    }
  }, { passive: false })

  list.addEventListener('touchend', () => finishDrag(false))
  list.addEventListener('touchcancel', () => finishDrag(false))
}

return () => {
  Object.entries(getLists()).forEach(([tier, sel]) => {
    const list = document.querySelector(sel)
    if (list) bindList(list, tier)
  })
}
}
