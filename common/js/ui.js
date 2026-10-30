const svcUi = {}
export const ui = svcUi

/** MAERS QLS — Toast 与原生 dialog 的统一交互。 */
let toastTimer = null
let toastHideTimer = null
svcUi.showToast = (msg) => {
  const el = document.getElementById('toast')
  if (!el) return
  clearTimeout(toastTimer)
  clearTimeout(toastHideTimer)
  el.textContent = msg
  // 原生模态 dialog 位于 top layer，普通 fixed Toast 会被压在遮罩下面；
  // 使用非模态 popover 将 Toast 放入 top layer，保证弹窗内的校验提示可见。
  if (typeof el.showPopover === 'function' && !el.matches(':popover-open')) el.showPopover()
  el.classList.add('show')
  toastTimer = setTimeout(() => {
    el.classList.remove('show')
    toastHideTimer = setTimeout(() => {
      if (el.matches?.(':popover-open')) el.hidePopover()
    }, 260)
  }, 2200)
}

// ── 9. 原生 <dialog> 弹窗辅助 ──────────────────────────
/**
 * 以模态方式打开 <dialog>：浏览器原生提供焦点陷阱、背景 inert、Esc 关闭与 top layer 渲染。
 * 默认将初始焦点落在 <dialog> 容器自身，阻止浏览器 dialog focusing steps 自动聚焦首个输入框而调起虚拟键盘；
 * 若显式传入 focus（选择器或元素），则聚焦指定目标。
 */
svcUi.openDialog = (dlg, { focus } = {}) => {
  if (!dlg) return
  const target = typeof focus === 'string' ? dlg.querySelector(focus) : focus
  if (!dlg.open) {
    if (target) {
      dlg.removeAttribute('autofocus')
    } else {
      if (!dlg.hasAttribute('tabindex')) dlg.setAttribute('tabindex', '-1')
      dlg.setAttribute('autofocus', '')
    }
    dlg.showModal()
  }
  if (target) {
    target.focus?.()
  } else if (dlg.contains(document.activeElement) && document.activeElement !== dlg) {
    dlg.focus?.()
  }
}

svcUi.closeDialog = (dlg) => {
  if (dlg?.open) dlg.close()
}

/**
 * 一次性绑定弹窗通用行为：
 * - lightDismiss：点击 ::backdrop 关闭（要求按下与松开都发生在背景上，防止拖拽误关）
 * - onClose：无论经由按钮、Esc 还是背景关闭，都会触发，用于统一清理上下文状态
 */
svcUi.bindDialog = (dlg, { onClose, lightDismiss = true } = {}) => {
  if (!dlg || dlg.dataset.dialogBound) return
  dlg.dataset.dialogBound = '1'
  if (lightDismiss) {
    let pressedOnBackdrop = false
    dlg.addEventListener('pointerdown', (e) => { pressedOnBackdrop = e.target === dlg })
    dlg.addEventListener('click', (e) => {
      if (pressedOnBackdrop && e.target === dlg) dlg.close()
      pressedOnBackdrop = false
    })
  }
  if (onClose) dlg.addEventListener('close', onClose)
}
