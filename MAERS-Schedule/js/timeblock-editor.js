import { timeblocks as svcTimeblocks } from './timeblock-service.js'
import { widgets as svcWidgets } from './widgets.js'
import { calendarPicker as svcCalendarPicker } from '../../common/js/calendar-picker.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { dom as svcDom } from '../../common/js/dom.js'
import { repeatRules as svcRepeatRules } from '../../common/js/repeat-rules.js'
import { storage as svcStorage } from '../../common/js/store.js'
import { ui as svcUi } from '../../common/js/ui.js'
import { wheelPicker as svcWheelPicker } from '../../common/js/wheel-picker.js'

const svcTimeblockEditor = {}
export const timeblockEditor = svcTimeblockEditor

/** MAERS Schedule — 时间块编辑弹窗、系列操作与时间精度设置。 */
svcTimeblockEditor.createTimeblockEditor = ({ refreshAllColumnBlocks, updateColumnBlocks }) => {
  const $ = svcDom.$
const fmtClock = svcDates.fmtClock

  // ── 时间块弹窗（原生 <dialog>） ───────────────────────
  const TB_STEPS = svcMetadata.TB_STEPS
  const dlg = $('#tb-modal')
  const delDlg = $('#tb-del-modal')
  const delDescEl = $('#tb-del-desc')
  const delScopesEl = $('#tb-del-scopes')
  const delConfirmBtn = $('#tb-del-confirm')
  const stepWrap    = $('#tb-step-settings')
  let delModalMode = 'delete' // 'delete' | 'edit-warn'
  let delScope = 'single'     // 'single' | 'following' | 'all'
  const stepToggle  = $('#tb-step-toggle')
  const stepPopover = $('#tb-step-popover')
  const fields = {
    title:      $('#tb-modal-title'),
    label:      $('#tb-block-label'),
    date:       $('#tb-block-date'),
    idealLabel: $('#tb-block-ideal-label'),
    start:      $('#tb-block-start'),
    end:        $('#tb-block-end'),
    colors:     $('#tb-block-colors'),
    notes:      $('#tb-block-notes'),
    del:        $('#tb-block-delete'),
    missed:     $('#tb-block-missed'),
  }
  let modalCtx = null // { dateStr, block }
  let endEdited = false

  function getTbStep() {
    const saved = Number(svcStorage.store.get(svcMetadata.TB_STEP_KEY, 5))
    return TB_STEPS.includes(saved) ? saved : 5
  }

  function calcDefaultEndClock(startClock) {
    const startMins = Math.round(svcDates.clockToHours(startClock) * 60)
    const endMins = (startMins + getTbStep()) % (24 * 60)
    return svcDates.toClock(Math.floor(endMins / 60), endMins % 60)
  }

  function syncStepButtons() {
    const cur = getTbStep()
    stepPopover?.querySelectorAll('.tb-step-opt[data-step]').forEach(btn => {
      const active = Number(btn.dataset.step) === cur
      btn.classList.toggle('active', active)
      btn.setAttribute('aria-pressed', String(active))
    })
  }

  function closeStepPopover() {
    if (!stepPopover) return
    stepPopover.hidden = true
    stepWrap?.classList.remove('open')
    stepToggle?.setAttribute('aria-expanded', 'false')
  }

  function formatBlockDatesDisplay(mode, dates, repeat = null) {
    if (mode === 'repeat' && repeat) {
      const unitMap = { day: '天', week: '周', month: '月', year: '年' }
      return `每${repeat.interval || 1}${unitMap[repeat.unit] || '天'}重复`
    }
    if (!Array.isArray(dates) || dates.length === 0) return ''
    if (dates.length === 1) return dates[0]
    if (mode === 'range') return `${dates[0].slice(5)} ~ ${dates[dates.length - 1].slice(5)}`
    return `${dates[0].slice(5)} 等 ${dates.length} 日`
  }

  function openBlockModal({ dateStr, startH = 9, durationH, block = null }) {
    const base = svcStorage.store.getCommitted(svcMetadata.TIMEBLOCK_KEY, null)
    if (block) {
      block = svcTimeblocks.loadBlocks(dateStr, { base }).find(item => item.id === block.id)
      if (!block) { svcUi.showToast('此时间块尚未保存或已被删除，请刷新后重试'); return }
    }
    const isEdit = !!block
    const isIdeal = dateStr === 'ideal'
    const initRepeat = block?.repeat || null
    const initMode = initRepeat ? 'repeat' : 'single'
    modalCtx = {
      dateStr,
      block,
      base,
      dateMode: initMode,
      selectedDates: isIdeal ? [] : [dateStr],
      repeat: initRepeat,
    }
    endEdited = isEdit || durationH != null

    closeStepPopover()
    syncStepButtons()

    fields.title.textContent = isEdit ? '编辑时间块' : '添加时间块'
    fields.label.value = block ? block.label : ''
    fields.notes.value = block?.notes || ''
    fields.date.hidden = isIdeal
    fields.idealLabel.hidden = !isIdeal
    if (!isIdeal) {
      fields.date.value = formatBlockDatesDisplay(initMode, [dateStr], initRepeat)
      fields.date.dataset.dateMode = initMode
      fields.date.dataset.selectedDates = dateStr
      if (initRepeat) fields.date.dataset.repeatConfig = JSON.stringify(initRepeat)
      else delete fields.date.dataset.repeatConfig
      fields.date.title = initRepeat ? (svcRepeatRules.formatRepeatSummary?.(initRepeat) || fields.date.value) : dateStr
    }

    const initStart = block ? block.startH : startH
    fields.start.value = fmtClock(initStart)
    if (block) {
      fields.end.value = fmtClock(initStart + block.durationH)
    } else if (durationH != null) {
      fields.end.value = fmtClock(initStart + durationH)
    } else {
      fields.end.value = calcDefaultEndClock(fields.start.value)
    }

    fields.del.hidden = !isEdit
    fields.missed.hidden = !isEdit
    fields.missed.classList.toggle('active', !!block?.missed)
    fields.missed.setAttribute('aria-pressed', String(!!block?.missed))
    fields.missed.textContent = block?.missed ? '✓ 遗漏' : '遗漏'

    svcWidgets.renderCategorySwatches(fields.colors, block?.category)
    svcUi.openDialog(dlg)
  }

  /** 保存/删除后刷新受影响的日期列（包含 '*' 时刷新当前周全部列） */
  function finishModal(dates, toast) {
    const ctx = modalCtx
    const finish = () => {
      if (modalCtx === ctx) svcUi.closeDialog(dlg)
      const container = $('#view-timeblock')
      if (dates.includes('*')) refreshAllColumnBlocks(container)
      else new Set(dates.filter(Boolean)).forEach(ds => updateColumnBlocks(container, ds))
      svcUi.showToast(toast)
    }
    if (svcStorage.store.mode !== 'indexeddb') { finish(); return }
    const controls = [...dlg.querySelectorAll('input, textarea, button')].filter(el => !el.disabled)
    controls.forEach(el => { el.disabled = true })
    svcStorage.store.flush().then(finish, () => {
      svcUi.showToast('保存失败，输入已保留，请核对其他页面的修改后重试')
    }).finally(() => controls.forEach(el => { el.disabled = false }))
  }

  function saveBlockFromModal() {
    if (!modalCtx) return
    const label = fields.label.value.trim()
    if (!label) { svcUi.showToast('请输入名称'); return }

    const origDate = modalCtx.dateStr
    const isRepeatMode = origDate !== 'ideal' && modalCtx.dateMode === 'repeat' && modalCtx.repeat
    let targetDates = []
    if (origDate === 'ideal') {
      targetDates = ['ideal']
    } else if (isRepeatMode) {
      targetDates = [modalCtx.repeat.baseDate || origDate]
    } else if (modalCtx.selectedDates?.length > 1) {
      targetDates = modalCtx.selectedDates
    } else {
      const single = svcDates.normalizeDateKey(fields.date.value) || modalCtx.selectedDates?.[0]
      if (single) targetDates = [single]
    }
    if (targetDates.length === 0) { svcUi.showToast('请选择日期'); return }

    const startH = svcDates.clockToHours(fields.start.value)
    let endH     = svcDates.clockToHours(fields.end.value)
    if (endH < startH) endH += 24 // 跨午夜
    const durationH = endH - startH
    if (durationH <= 0) { svcUi.showToast('结束时间必须晚于开始时间'); return }

    const prev = modalCtx.block
    const category = svcWidgets.getSwatchCategory(fields.colors)
    const missed = !!prev?.missed
    const notes = fields.notes.value.trim()

    if (prev?.seriesId) {
      const seriesItems = svcTimeblocks.findSeriesBlocks(prev.seriesId)
      if (seriesItems.length > 1) {
        const dateChanged = isRepeatMode || targetDates.length !== 1 || targetDates[0] !== origDate
        const contentChanged = label !== prev.label
          || Math.abs(startH - prev.startH) > 1e-6
          || Math.abs(durationH - prev.durationH) > 1e-6
          || category !== prev.category
          || notes !== (prev.notes || '')
        if (dateChanged || contentChanged) {
          openSeriesDelModal('edit-warn')
          return
        }
        svcUi.closeDialog(dlg)
        return
      }
    }

    if (isRepeatMode) {
      if (!svcTimeblocks.saveBlocksFromEditor({ origDate, previous: prev, targetDates,
        block: { label, startH, durationH, category, notes }, repeat: modalCtx.repeat,
      }, modalCtx.base)) return
      finishModal(['*'], '已添加重复时间块')
      return
    }

    const seriesId = targetDates.length > 1
      ? (prev?.seriesId || svcMetadata.uid('tbs_'))
      : ''

    if (!svcTimeblocks.saveBlocksFromEditor({ origDate, previous: prev, targetDates,
      block: { label, startH, durationH, category, missed, notes, seriesId },
    }, modalCtx.base)) return
    const toast = targetDates.length > 1
      ? `已保存至 ${targetDates.length} 个日期`
      : (prev ? '已更新' : '已添加')
    finishModal([origDate, ...targetDates], toast)
  }

  function syncDelScopeUI(scope) {
    delScope = scope
    delScopesEl?.querySelectorAll('.tb-del-scope-btn[data-del-scope]').forEach(btn => {
      const on = btn.dataset.delScope === scope
      btn.classList.toggle('selected', on)
      btn.setAttribute('aria-checked', String(on))
    })
  }

  function openSeriesDelModal(mode) {
    if (!delDlg) return
    delModalMode = mode
    const isWarn = mode === 'edit-warn'
    if (delDescEl) delDescEl.hidden = !isWarn
    if (delScopesEl) delScopesEl.hidden = isWarn
    if (!isWarn) syncDelScopeUI('single')
    if (!delDlg.open) svcUi.openDialog(delDlg, { focus: delConfirmBtn })
  }

  function deleteBlockFromModal() {
    if (!modalCtx?.block) return
    const { dateStr, block } = modalCtx
    const seriesItems = block.seriesId ? svcTimeblocks.findSeriesBlocks(block.seriesId) : []
    if (seriesItems.length > 1 && delDlg) {
      openSeriesDelModal('delete')
      return
    }
    if (!confirm('删除此时间块？')) return
    if (!svcTimeblocks.deleteBlock(dateStr, block.id, { base: modalCtx.base })) return
    finishModal([dateStr], '已删除')
  }

  function toggleMissedFromModal() {
    if (!modalCtx?.block) return
    const { dateStr, block } = modalCtx
    const next = { ...block, missed: !block.missed }
    if (!svcTimeblocks.saveBlock(dateStr, next, { base: modalCtx.base })) return
    finishModal([dateStr], next.missed ? '已标记遗漏' : '已取消遗漏')
  }

  // ── 弹窗静态控件一次性绑定 ────────────────────────────
  svcUi.bindDialog(dlg, { onClose: () => { svcUi.closeDialog(delDlg); modalCtx = null; closeStepPopover() } })
  svcUi.bindDialog(delDlg)
  $('#tb-del-cancel')?.addEventListener('click', () => svcUi.closeDialog(delDlg))
  delScopesEl?.addEventListener('click', e => {
    const btn = e.target.closest('.tb-del-scope-btn[data-del-scope]')
    if (btn) syncDelScopeUI(btn.dataset.delScope)
  })
  delConfirmBtn?.addEventListener('click', () => {
    if (!modalCtx?.block) return
    const { dateStr, block } = modalCtx
    svcUi.closeDialog(delDlg)
    if (delModalMode === 'edit-warn' || delScope === 'single' || !block.seriesId) {
      if (!svcTimeblocks.deleteBlock(dateStr, block.id, { base: modalCtx.base })) return
      finishModal([dateStr], '已删除当天时间块')
    } else if (delScope === 'following') {
      const affected = svcTimeblocks.deleteSeriesBlocks(block.seriesId, dateStr)
      finishModal(affected, '已删除当天及以后时间块')
    } else {
      const affected = svcTimeblocks.deleteSeriesBlocks(block.seriesId)
      finishModal(affected, '已删除全部关联时间块')
    }
  })
  stepToggle?.addEventListener('click', e => {
    e.stopPropagation()
    const willOpen = stepPopover.hidden
    if (willOpen) syncStepButtons()
    stepPopover.hidden = !willOpen
    stepWrap?.classList.toggle('open', willOpen)
    stepToggle.setAttribute('aria-expanded', String(willOpen))
  })
  stepPopover?.addEventListener('click', e => {
    const opt = e.target.closest('.tb-step-opt[data-step]')
    if (!opt) return
    const step = Number(opt.dataset.step)
    if (TB_STEPS.includes(step)) {
      svcStorage.store.set(svcMetadata.TB_STEP_KEY, step)
      syncStepButtons()
      if (!endEdited) fields.end.value = calcDefaultEndClock(fields.start.value)
    }
    closeStepPopover()
  })
  dlg.addEventListener('click', e => {
    if (!stepPopover?.hidden && !e.target.closest('#tb-step-settings')) closeStepPopover()
  })
  svcCalendarPicker.bindDateInput(fields.date, {
    enableMulti: true,
    onChange: (dateStr, _pickedDate, meta) => {
      const mode = meta?.mode || 'single'
      const dates = meta?.dates?.length ? meta.dates : (dateStr ? [dateStr] : [])
      const repeat = meta?.repeat || null
      if (modalCtx) {
        modalCtx.dateMode = mode
        modalCtx.selectedDates = dates
        modalCtx.repeat = repeat
      }
      fields.date.dataset.dateMode = mode
      fields.date.dataset.selectedDates = dates.join(',')
      if (repeat) fields.date.dataset.repeatConfig = JSON.stringify(repeat)
      else delete fields.date.dataset.repeatConfig
      fields.date.value = formatBlockDatesDisplay(mode, dates, repeat)
      fields.date.title = repeat ? (svcRepeatRules.formatRepeatSummary?.(repeat) || fields.date.value) : dates.join(', ')
    },
  })
  svcWidgets.bindCategorySwatches(fields.colors)
  svcWheelPicker.bindClockInput(fields.start, {
    title: '开始时间',
    minStep: getTbStep,
    onChange: (clock) => {
      if (!endEdited) {
        fields.end.value = calcDefaultEndClock(clock)
        endEdited = true
      }
    },
  })
  svcWheelPicker.bindClockInput(fields.end, {
    title: '结束时间',
    minStep: getTbStep,
    onChange: () => { endEdited = true },
  })
  $('#tb-block-save').addEventListener('click', saveBlockFromModal)
  $('#tb-block-cancel').addEventListener('click', () => svcUi.closeDialog(dlg))
  fields.del.addEventListener('click', deleteBlockFromModal)
  fields.missed.addEventListener('click', toggleMissedFromModal)

  return { openBlockModal }
}
