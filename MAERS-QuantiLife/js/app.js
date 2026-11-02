import { quantiTransfer as svcQuantiTransfer } from './data-transfer.js'
import { dietView as svcDietView } from './diet.js'
import { records as svcRecords } from './records.js'
import { timeDetail as svcTimeDetail } from './time-detail.js'
import { timeStats as svcTimeStats } from './time-stats.js'
import { calendarPicker as svcCalendarPicker } from '../../common/js/calendar-picker.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { dayRecords as svcDayRecords } from '../../common/js/day-record.js'
import { dom as svcDom } from '../../common/js/dom.js'
import { storageState as svcStorageState } from '../../common/js/idb-store.js'
import { jsonTransfer as svcJsonTransfer } from '../../common/js/json-transfer.js'
import { storage as svcStorage } from '../../common/js/store.js'
import { ui as svcUi } from '../../common/js/ui.js'

const svcQuantiApp = {}
export const quantiApp = svcQuantiApp

/**
 * MAERS QuantiLife — 记录页主协调器 (app.js)
 * 负责：日期切换、日历选择、页面数据聚合与自动保存、心情选择、JSON 导入导出
 */

const $ = svcDom.$
const $$ = svcDom.$$
const dateKey = svcDates.dateKey
const addDays = svcDates.addDays
const formatDateCN = svcDates.formatDateCN
const showToast = svcUi.showToast

// ── 页面状态 ─────────────────────────────────────────
let currentDate = svcDates.parseDateKey(svcDates.today())
let selectedMood = null
let autoSaveTimer = null
let dirty = false
let editVersion = 0
let editorBase = null
let editorEpoch = 0
let savePromise = null
let saveRequested = false
let manualSaveRequested = false

const inputs = {
  steps: $('#input-steps'),
  sleep: $('#input-sleep'),
  water: $('#input-water'),
  note:  $('#mood-note'),
}

function updateDateDisplay() {
  $('#date-display').textContent = formatDateCN(currentDate)
}

/**
 * 同步事件（_isSync）由 Schedule 桥接层独占维护：保存时以存储中最新的同步事件为准，
 * 防止本页陈旧的内存状态抹掉其他标签页刚同步的计时记录。
 */
function mergeLatestSyncedEvents(events) {
  const latest = (svcRecords.loadDayData(currentDate)?.timeEvents || []).filter(ev => ev._isSync)
  return [...events.filter(ev => !ev._isSync), ...latest]
}

// ── 页面数据收集与持久化 ─────────────────────────────
function gatherData() {
  const timeEvents = mergeLatestSyncedEvents(svcTimeDetail.timeDetail.getEvents())
  return {
    ...editorBase,
    date: dateKey(currentDate),
    basics: {
      steps: parseFloat(inputs.steps.value) || 0,
      sleep: parseFloat(inputs.sleep.value) || 0,
      water: parseFloat(inputs.water.value) || 0,
    },
    diet: svcDietView.diet.getItems(),
    time: svcTimeStats.computeTimeCategorySumMap(timeEvents),
    timeEvents,
    mood: selectedMood,
    moodNote: inputs.note.value,
  }
}

const saveCurrentData = () => svcRecords.saveDayData(gatherData(), { base: editorBase })

function stageCurrentData() {
  const data = svcRecords.normalizeDayData(gatherData())
  const key = svcMetadata.QL_PREFIX + data.date
  if (!svcStorage.store.stage(key, svcRecords.isDataEmpty(data) ? null : data, { base: editorBase })) void persistCurrentData()
}

function persistCurrentData(manual = false) {
  clearTimeout(autoSaveTimer)
  autoSaveTimer = null
  if (svcStorage.store.mode !== 'indexeddb') {
    const saved = saveCurrentData()
    if (saved) {
      dirty = false
      editorBase = svcStorage.store.getCommitted(svcMetadata.QL_PREFIX + dateKey(currentDate), null)
      if (manual) svcStorage.showSavedToast('✅ 已保存 ' + dateKey(currentDate))
    }
    return Promise.resolve(saved)
  }
  saveRequested = true
  manualSaveRequested ||= manual
  if (savePromise) return savePromise
  // 先登记本轮完成 Promise，再同步启动首个提交；后续点击只请求保存最新表单。
  let finish
  savePromise = new Promise(resolve => { finish = resolve })
  const completion = savePromise
  void drainSaves().then(finish)
  return completion
}

async function drainSaves() {
  try {
    while (saveRequested) {
      saveRequested = false
      const version = editVersion, epoch = editorEpoch, date = dateKey(currentDate)
      const submitted = gatherData()
      if (!svcRecords.saveDayData(submitted, { base: editorBase })) return false
      await svcStorage.store.flush()
      if (date === dateKey(currentDate) && epoch === editorEpoch) {
        // 只用已提交快照推进基线，不能读取下一次保存留下的乐观缓存。
        const confirmed = svcStorage.store.getCommitted(svcMetadata.QL_PREFIX + date, null)
        const latest = svcRecords.normalizeDayData(confirmed, date) || svcDayRecords.createEmptyDay(date)
        if (version === editVersion) dirty = false
        else {
          const editing = gatherData()
          const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b)
          for (const key of ['steps', 'sleep', 'water']) {
            if (changed(editing.basics[key], submitted.basics[key])) latest.basics[key] = editing.basics[key]
          }
          for (const key of ['diet', 'mood', 'moodNote']) {
            if (changed(editing[key], submitted[key])) latest[key] = editing[key]
          }
        }
        editorBase = confirmed
        displayData(latest)
        if (dirty) stageCurrentData()
      }
    }
    if (manualSaveRequested && !dirty) showToast('✅ 已保存 ' + dateKey(currentDate))
    else if (!dirty) {
      const indicator = $('#autosave-indicator')
      indicator.classList.add('visible')
      setTimeout(() => indicator.classList.remove('visible'), 1200)
    }
    return true
  } catch { return false /* 保留最新输入与原来的已提交基线，允许原样重试。 */ }
  finally {
    saveRequested = false
    manualSaveRequested = false
    savePromise = null
  }
}
svcQuantiApp.flushEditor = persistCurrentData

function autoSave() {
  dirty = true
  editVersion++
  stageCurrentData()
  clearTimeout(autoSaveTimer)
  autoSaveTimer = setTimeout(() => persistCurrentData(), 800)
}

function setMood(mood) {
  selectedMood = mood
  $$('.mood-btn').forEach(b => {
    const on = b.dataset.mood === mood
    b.classList.toggle('active', on)
    b.setAttribute('aria-checked', String(on))
  })
}

function displayData(data) {
  inputs.steps.value = data?.basics.steps || ''
  inputs.sleep.value = data?.basics.sleep || ''
  inputs.water.value = data?.basics.water || ''
  inputs.note.value  = data?.moodNote || ''
  setMood(data?.mood || null)
  if (data) {
    svcDietView.diet.setItems(data.diet)
    svcTimeDetail.timeDetail.setEventsFromDayData(data)
  } else {
    svcDietView.diet.clear()
    svcDietView.diet.ensureOne()
    svcTimeDetail.timeDetail.clear()
  }
}

function loadData() {
  editorEpoch++
  editorBase = svcStorage.store.getCommitted(svcMetadata.QL_PREFIX + dateKey(currentDate), null)
  displayData(svcRecords.normalizeDayData(editorBase, dateKey(currentDate)))
}

// ── 心情选择（单选组） ───────────────────────────────
$('#mood-selector').addEventListener('click', e => {
  const btn = e.target.closest('.mood-btn')
  if (!btn) return
  setMood(btn.dataset.mood)
  autoSave()
})

// ── 日期导航与统一日历弹窗 ───────────────────────────
async function changeDate(newDate) {
  clearTimeout(autoSaveTimer)
  autoSaveTimer = null
  if (svcStorage.store.mode === 'indexeddb') {
    if ((dirty || savePromise) && !await persistCurrentData()) return
  } else if (dirty && !saveCurrentData()) return
  dirty = false
  editVersion++
  currentDate = newDate
  updateDateDisplay()
  loadData()
}

$('#prev-day').addEventListener('click', () => changeDate(addDays(currentDate, -1)))
$('#next-day').addEventListener('click', () => changeDate(addDays(currentDate, +1)))

const dateDisplayEl = $('#date-display')
dateDisplayEl.addEventListener('click', () => {
  svcCalendarPicker.openCalendarPicker({
    date: currentDate,
    anchorEl: dateDisplayEl,
    hasDataFn: (ds) => svcStorage.store.has(svcMetadata.QL_PREFIX + ds),
    onSelect: (picked) => { if (picked) changeDate(picked) },
  })
})

// ── 自动保存与操作栏绑定 ─────────────────────────────
Object.values(inputs).forEach(el => el.addEventListener('input', autoSave))
svcDietView.diet.onChange = autoSave

$('#save-btn').addEventListener('click', () => persistCurrentData(true))

// ── 导出与导入 ───────────────────────────────────────
$('#export-btn').addEventListener('click', async () => {
  if (svcStorage.store.mode === 'indexeddb') {
    if (!await persistCurrentData()) return
  } else if (!saveCurrentData()) return
  const { filename, data } = svcQuantiTransfer.exportBackup()
  svcJsonTransfer.downloadJson(filename, data)
})

const importFileEl = $('#import-file')
$('#import-btn').addEventListener('click', () => importFileEl.click())
svcJsonTransfer.bindJsonFileInput(importFileEl, async (json) => {
  if (savePromise) await savePromise
  const count = await svcQuantiTransfer.importBackup(json)
  if (count > 0) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = null
    dirty = false
    editVersion++
    svcStorage.store.discardDraft(svcMetadata.QL_PREFIX + dateKey(currentDate))
    loadData()
  }
  showToast(count > 0 ? `📥 已导入 ${count} 条记录` : '❌ 未找到可导入的 QuantiLife 数据')
})

// ── 跨标签页同步 ─────────────────────────────────────
// 其他标签页（如 Schedule 结束计时）修改了当日记录：用户没有未保存的编辑时整页重载；
// 有未保存的编辑时只更新同步事件，保留用户正在输入的内容。
svcStorage.onStoreChange(keys => {
  if (!keys.includes(svcMetadata.QL_PREFIX + dateKey(currentDate))) return
  if (!dirty) loadData()
  else svcTimeDetail.timeDetail.setEventsFromDayData({ timeEvents: mergeLatestSyncedEvents(svcTimeDetail.timeDetail.getEvents()) })
})

const saveOnLeave = () => {
  if (dirty) {
    stageCurrentData()
    void persistCurrentData()
  }
}
window.addEventListener('pagehide', saveOnLeave)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveOnLeave()
})

// ── 启动初始化 ───────────────────────────────────────
svcStorageState.onStorageReady(() => {
  svcRecords.cleanupEmptyRecords()
  updateDateDisplay()
  loadData()
})
