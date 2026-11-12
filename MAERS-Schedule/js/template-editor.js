import { timeblocks as svcTimeblocks } from './timeblock-service.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dom as svcDom } from '../../common/js/dom.js'
import { storage as svcStorage } from '../../common/js/store.js'
import { ui as svcUi } from '../../common/js/ui.js'

const svcTemplateEditor = {}
export const templateEditor = svcTemplateEditor

/** 自定义列弹窗：创建、重命名、切换和删除，提交成功后才更新界面。 */
svcTemplateEditor.createTemplateEditor = ({ onChanged }) => {
  const dialog = svcDom.$('#tb-templates-modal')
  const list = svcDom.$('#tb-templates-list')
  const nameInput = svcDom.$('#tb-template-name')
  let base = null
  let busy = false
  let session = 0
  let editingId = ''

  // 渲染已创建的自定义时间列，无条目时隐藏列表容器且不展示空状态提示
  function render() {
    const state = svcTimeblocks.loadTemplates({ base })
    list.hidden = state.items.length === 0
    svcDom.setHTML(list, svcDom.html`${state.items.map(item => item.id === editingId ? svcDom.html`
      <div class="tb-template-row">
        <input class="modal-input tb-template-rename" data-template-rename-input="${item.id}" value="${item.name}"
          maxlength="24" aria-label="重命名${item.name}" autocomplete="off" />
        <button type="button" class="tb-template-action" data-template-rename-save="${item.id}" aria-label="保存名称">✓</button>
        <button type="button" class="tb-template-action" data-template-rename-cancel aria-label="取消重命名">×</button>
      </div>` : svcDom.html`
      <div class="tb-template-row">
        <button type="button" class="tb-template-choice${item.id === state.activeId ? ' active' : ''}"
          data-template-select="${item.id}" aria-pressed="${String(item.id === state.activeId)}">
          <span>${item.name}</span><span class="tb-template-status">${item.id === state.activeId ? '使用中' : '选择'}</span>
        </button>
        <button type="button" class="tb-template-action" data-template-rename="${item.id}" aria-label="重命名${item.name}">✎</button>
        <button type="button" class="tb-template-delete" data-template-delete="${item.id}" aria-label="删除${item.name}">×</button>
      </div>`)}`)
  }

  /** 进入或退出行内重命名；进入时聚焦并选中原名称。 */
  function setEditing(id) {
    editingId = id
    render()
    const input = list.querySelector('[data-template-rename-input]')
    if (input) { input.focus(); input.select() }
  }

  async function commit(operation, { close = false, clearName = false, keepScroll = false, endEdit = false } = {}) {
    if (busy || !operation()) return
    busy = true
    const currentSession = session
    const controls = [...dialog.querySelectorAll('button, input')]
    controls.forEach(control => { control.disabled = true })
    try {
      await svcStorage.store.flush()
      onChanged({ keepScroll })
      if (currentSession !== session) return
      base = svcStorage.store.getCommitted(svcMetadata.TIMEBLOCK_KEY, null)
      if (clearName) nameInput.value = ''
      if (endEdit) editingId = ''
      if (close) svcUi.closeDialog(dialog)
      else render()
    } catch {
      svcUi.showToast('保存失败，名称已保留，请核对其他页面的修改后重试')
    } finally {
      busy = false
      controls.forEach(control => { control.disabled = false })
    }
  }

  function addTemplate() {
    const name = nameInput.value.trim()
    if (!name) { svcUi.showToast('请输入自定义名称'); nameInput.focus(); return }
    const state = svcTimeblocks.loadTemplates({ base })
    if (state.items.some(item => item.name.toLowerCase() === name.toLowerCase())) {
      svcUi.showToast('这个名称已经存在'); return
    }
    void commit(() => svcTimeblocks.createTemplate(name, { base }), { clearName: true })
  }

  /** 提交行内重命名：校验空名称与重名，名称未变化时仅退出编辑。 */
  function submitRename(id) {
    const input = list.querySelector('[data-template-rename-input]')
    const name = input?.value.trim() || ''
    if (!name) { svcUi.showToast('请输入自定义名称'); input?.focus(); return }
    const items = svcTimeblocks.loadTemplates({ base }).items
    const item = items.find(template => template.id === id)
    if (!item) { setEditing(''); return }
    if (name === item.name) { setEditing(''); return }
    if (items.some(template => template.id !== id && template.name.toLowerCase() === name.toLowerCase())) {
      svcUi.showToast('这个名称已经存在'); input.focus(); return
    }
    void commit(() => svcTimeblocks.renameTemplate(id, name, { base }), { keepScroll: true, endEdit: true })
  }

  list.addEventListener('click', event => {
    const select = event.target.closest('[data-template-select]')
    if (select) {
      void commit(() => svcTimeblocks.selectTemplate(select.dataset.templateSelect, { base }), { close: true })
      return
    }
    const rename = event.target.closest('[data-template-rename]')
    if (rename) { setEditing(rename.dataset.templateRename); return }
    const save = event.target.closest('[data-template-rename-save]')
    if (save) { submitRename(save.dataset.templateRenameSave); return }
    if (event.target.closest('[data-template-rename-cancel]')) { setEditing(''); return }
    const remove = event.target.closest('[data-template-delete]')
    const item = svcTimeblocks.loadTemplates({ base }).items.find(template => template.id === remove?.dataset.templateDelete)
    if (item && confirm(`删除“${item.name}”及其中的时间块？`)) {
      void commit(() => svcTimeblocks.deleteTemplate(item.id, { base }))
    }
  })
  // 重命名输入框：回车提交（跳过输入法组合阶段），Esc 仅取消重命名而不关闭弹窗
  list.addEventListener('keydown', event => {
    const input = event.target.closest('[data-template-rename-input]')
    if (!input) return
    if (event.key === 'Enter') {
      event.preventDefault()
      if (!event.isComposing) submitRename(input.dataset.templateRenameInput)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setEditing('')
    }
  })
  svcDom.$('#tb-template-add').addEventListener('click', addTemplate)
  nameInput.addEventListener('keydown', event => {
    if (event.key === 'Enter') {
      event.preventDefault()
      // 输入法候选词组合阶段不触发提交
      if (event.isComposing) return
      addTemplate()
    }
  })
  svcDom.$('#tb-templates-close').addEventListener('click', () => svcUi.closeDialog(dialog))
  svcUi.bindDialog(dialog, { onClose: () => { session++; editingId = '' } })

  return {
    open() {
      if (busy) return
      session++
      base = svcStorage.store.getCommitted(svcMetadata.TIMEBLOCK_KEY, null)
      nameInput.value = ''
      editingId = ''
      render()
      svcUi.openDialog(dialog, { focus: nameInput })
    },
  }
}
