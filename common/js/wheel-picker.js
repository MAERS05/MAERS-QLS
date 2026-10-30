import { dates as svcDates } from './date-utils.js'
import { dom as svcDom } from './dom.js'
import { ui as svcUi } from './ui.js'

const svcWheelPicker = {}
export const wheelPicker = svcWheelPicker

/**
 * MAERS QLS — 统一滚轮时间选择器 (common/js/wheel-picker.js)
 * 特性：鼠标拖拽 + 触屏滚动 + 键盘方向键 + 无限循环 + 惯性吸附
 * 基于原生模态 <dialog>：可叠加在其他模态弹窗之上。
 */
const html = svcDom.html

const ITEM_H  = 44                      // 每项高度 (px)
const VISIBLE = 5                       // 可见行数
const PAD     = Math.floor(VISIBLE / 2) // 上下留白行数

let dlg, titleEl, hCol, mCol, curCallback

// ── 无限循环：三倍复制 ─────────────────────────────
function fillInfinite(col, values, selected) {
  col._stopAnim?.()
  const triple = [...values, ...values, ...values]
  const pads = Array.from({ length: PAD }, () => html`<div class="wp-item wp-pad"></div>`)
  svcDom.setHTML(col, html`${pads}${triple.map((v, i) => html`<div class="wp-item" data-val="${v}" data-idx="${i}">${svcDates.pad2(v)}</div>`)}${pads}`)

  // 定位到中间段的选中项
  const selIdx = values.indexOf(selected)
  col.scrollTop = (values.length + (selIdx >= 0 ? selIdx : 0)) * ITEM_H
  col._vals = values
  col.setAttribute('aria-valuemin', String(values[0]))
  col.setAttribute('aria-valuemax', String(values[values.length - 1]))
}

function normScroll(s, span) {
  return span + (((s - span) % span + span) % span)
}

function loopScroll(col) {
  const vals = col._vals
  if (!vals || !vals.length) return
  const span = vals.length * ITEM_H
  if (col.scrollTop < span || col.scrollTop >= span * 2) {
    col.scrollTop = normScroll(col.scrollTop, span)
  }
}

// ── 读取当前选中值 ─────────────────────────────────
function getSelected(col) {
  const vals = col._vals
  const top = col._animTarget ?? col.scrollTop
  const idx = Math.round(top / ITEM_H) % vals.length
  return vals[(idx + vals.length) % vals.length]
}

function snapToNearest(col) {
  col.scrollTo({ top: Math.round(col.scrollTop / ITEM_H) * ITEM_H, behavior: 'smooth' })
}

// ── 高亮中间项并同步无障碍数值 ─────────────────────
function updateHighlight(col) {
  const centerIdx = Math.round(col.scrollTop / ITEM_H)
  col.querySelectorAll('.wp-item:not(.wp-pad)').forEach((el, i) => {
    const dist = Math.abs(i - centerIdx)
    el.classList.toggle('is-center', dist === 0)
    el.classList.toggle('is-near', dist === 1)
  })
  if (col._vals) col.setAttribute('aria-valuenow', String(getSelected(col)))
}

// ── 点击平滑滚动、拖拽、惯性与键盘 ─────────────────
function bindInteractions(col) {
  let pointerDown = false, dragging = false, justDragged = false
  let touchMoved = false
  let startY = 0, startScroll = 0, vel = 0, lastY = 0, lastT = 0, rafId = 0

  function stopAnim() {
    cancelAnimationFrame(rafId)
    col._animTarget = null
  }
  col._stopAnim = stopAnim

  function rollToIndex(idx) {
    const vals = col._vals
    if (!Number.isFinite(idx) || !vals || !vals.length) return
    stopAnim()
    const span = vals.length * ITEM_H
    const from = col.scrollTop
    const delta = idx * ITEM_H - from
    if (Math.abs(delta) < 1) return
    const finalScroll = normScroll(Math.round((from + delta) / ITEM_H) * ITEM_H, span)
    col._animTarget = finalScroll
    const duration = 180
    const startTime = performance.now()
    const step = (now) => {
      const t = Math.min(1, (now - startTime) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      if (t < 1) {
        col.scrollTop = Math.round(normScroll(from + delta * eased, span))
        updateHighlight(col)
        rafId = requestAnimationFrame(step)
      } else {
        col._animTarget = null
        col.scrollTop = finalScroll
        updateHighlight(col)
      }
    }
    rafId = requestAnimationFrame(step)
  }

  col.addEventListener('scroll', () => { loopScroll(col); updateHighlight(col) }, { passive: true })

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
      if (Math.abs(v) < 0.5) { snapToNearest(col); return }
      col.scrollTop -= v
      v *= 0.92
      rafId = requestAnimationFrame(momentum)
    }
    rafId = requestAnimationFrame(momentum)
  })

  col.addEventListener('click', e => {
    if (justDragged) { justDragged = false; return }
    const item = e.target.closest('.wp-item[data-idx]')
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
    if (touchMoved) snapToNearest(col)
  })

  // 键盘：↑/↓ 逐项调整，Enter 确认
  col.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      stopAnim()
      col.scrollTop = (Math.round(col.scrollTop / ITEM_H) + (e.key === 'ArrowDown' ? 1 : -1)) * ITEM_H
      loopScroll(col)
      updateHighlight(col)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      confirm()
    }
  })
}

// ── 创建 DOM ──────────────────────────────────────
function ensureDOM() {
  if (dlg) return
  dlg = document.createElement('dialog')
  dlg.className = 'wp-dialog'
  dlg.id = 'qls-wheel-picker'
  dlg.setAttribute('aria-labelledby', 'qls-wp-title')
  svcDom.setHTML(dlg, html`
    <div class="wp-panel">
      <div class="wp-title" id="qls-wp-title"></div>
      <div class="wp-body">
        <div class="wp-col" id="qls-wp-h" tabindex="0" role="spinbutton" aria-label="小时"></div>
        <div class="wp-sep" aria-hidden="true">:</div>
        <div class="wp-col" id="qls-wp-m" tabindex="0" role="spinbutton" aria-label="分钟"></div>
        <div class="wp-highlight" aria-hidden="true"></div>
      </div>
      <div class="wp-actions">
        <button type="button" class="wp-btn wp-cancel">取消</button>
        <button type="button" class="wp-btn wp-confirm">确认</button>
      </div>
    </div>`)
  document.body.appendChild(dlg)

  titleEl = dlg.querySelector('.wp-title')
  hCol = dlg.querySelector('#qls-wp-h')
  mCol = dlg.querySelector('#qls-wp-m')
  bindInteractions(hCol)
  bindInteractions(mCol)

  dlg.querySelector('.wp-cancel').addEventListener('click', () => svcUi.closeDialog(dlg))
  dlg.querySelector('.wp-confirm').addEventListener('click', confirm)
  svcUi.bindDialog(dlg, { onClose: () => { curCallback = null } })
}

// ── 打开与确认 ────────────────────────────────────
/**
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {number} [opts.h] 初始小时
 * @param {number} [opts.m] 初始分钟
 * @param {[number, number]} [opts.hourRange] 小时范围，默认 [0, 23]
 * @param {number} [opts.minStep] 分钟步长，默认 1
 * @param {({h, m}) => void} opts.onConfirm
 */
function openWheelPicker({ title, h, m, hourRange = [0, 23], minStep = 1, onConfirm }) {
  ensureDOM()
  titleEl.textContent = title || '选择'
  curCallback = onConfirm

  const hValues = []
  for (let i = hourRange[0]; i <= hourRange[1]; i++) hValues.push(i)
  const mValues = []
  for (let i = 0; i < 60; i += minStep) mValues.push(i)

  svcUi.openDialog(dlg)
  fillInfinite(hCol, hValues, h || 0)
  fillInfinite(mCol, mValues, Math.round((m || 0) / minStep) * minStep % 60)
  updateHighlight(hCol)
  updateHighlight(mCol)
  hCol.focus()
}

function confirm() {
  const cb = curCallback
  const value = { h: getSelected(hCol), m: getSelected(mCol) }
  svcUi.closeDialog(dlg)
  if (cb) cb(value)
}

/**
 * 以 "HH:MM" 字符串为输入/输出的便捷封装
 * @param {string} value 当前时钟值（非法值按 00:00 处理）
 * @param {{title?: string, minStep?: number, onPick: (clock: string) => void}} opts
 */
function pickClock(value, { title, minStep = 1, onPick }) {
  const clock = svcDates.parseClock(value)
  openWheelPicker({
    title,
    h: clock ? clock.hours % 24 : 0,
    m: clock ? clock.minutes : 0,
    minStep,
    onConfirm: ({ h, m }) => onPick(svcDates.toClock(h, m)),
  })
}

/** 将只读时间输入框绑定至滚轮选择器；选择后回写 value 并触发 onChange */
function bindClockInput(inputEl, { title, minStep = 1, onChange } = {}) {
  if (!inputEl || inputEl.dataset.clockBound) return
  inputEl.dataset.clockBound = '1'
  inputEl.addEventListener('click', () => {
    const step = typeof minStep === 'function' ? minStep() : minStep
    pickClock(inputEl.value, {
      title,
      minStep: step,
      onPick: (clock) => {
        inputEl.value = clock
        onChange?.(clock)
      },
    })
  })
}

svcWheelPicker.openWheelPicker = openWheelPicker
svcWheelPicker.pickClock = pickClock
svcWheelPicker.bindClockInput = bindClockInput
