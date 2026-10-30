import { expectations as svcExpectations } from './expectation-store.js'
import { bridge as svcBridge } from '../../common/js/bridge.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dom as svcDom } from '../../common/js/dom.js'
import { storage as svcStorage } from '../../common/js/store.js'
import { ui as svcUi } from '../../common/js/ui.js'

const svcExpectationView = {}
export const expectationView = svcExpectationView

/**
 * MAERS QuantiLife — 期望设定面板 (expectations.js)
 * 交互约定：打开面板时载入草稿，增删行仅修改草稿；只有「保存期望」才持久化，「取消」/Esc 放弃修改。
 */

const $ = svcDom.$
const html = svcDom.html
const TIME_META = svcMetadata.TIME_META
const TIME_KEYS = svcMetadata.TIME_KEYS
const MOOD_META = svcMetadata.MOOD_META
const MOOD_KEYS = svcMetadata.MOOD_KEYS
const normalizeDietItem = svcMetadata.normalizeDietItem

const dlg = $('#exp-overlay')
const body = $('#exp-body')
let draft = null
let editorBase = null

const round2 = (v) => Math.round(v * 100) / 100
const numOrEmpty = (v) => (v ? round2(v) : '')

const BASIC_FIELDS = [
  { key: 'steps', label: '步数', unit: '步',   step: 500 },
  { key: 'sleep', label: '睡眠', unit: 'h',    step: 0.5 },
  { key: 'water', label: '饮水', unit: 'ml',   step: 100 },
  { key: 'cal',   label: '热量', unit: 'kcal', step: 50 },
]
const DIET_FIELDS = [
  { field: 'carb', label: '碳水' }, { field: 'protein', label: '蛋白' },
  { field: 'fat', label: '脂肪' },  { field: 'cal', label: '热量' },
]

// ── 渲染 ──────────────────────────────────────────────
function buildBasics(exp) {
  return html`
    <section class="exp-section" aria-labelledby="exp-sec-basics">
      <h3 class="exp-sec-title" id="exp-sec-basics">基础指标期望</h3>
      <div class="exp-basic-list">
        ${BASIC_FIELDS.map(c => html`
          <div class="exp-basic-row">
            <label for="exp-${c.key}">${c.label}</label>
            <input id="exp-${c.key}" data-basic="${c.key}" type="number" value="${exp[c.key] || ''}" min="0" step="${c.step}" placeholder="0">
            <span class="exp-u">${c.unit}</span>
          </div>`)}
      </div>
    </section>`
}

function buildDiet(exp) {
  return html`
    <section class="exp-section" aria-labelledby="exp-sec-diet">
      <h3 class="exp-sec-title" id="exp-sec-diet">饮食期望</h3>
      <div class="exp-food-header" aria-hidden="true">
        <span>食物名称</span>${DIET_FIELDS.map(f => html`<span>${f.label}</span>`)}<span></span>
      </div>
      <div id="exp-diet-list">
        ${exp.diet.map((item, i) => html`
          <div class="exp-food-row" data-di="${i}">
            <input class="exp-fi exp-fi-name" data-field="name" value="${item.name}" placeholder="食物名称..."
              aria-label="第 ${i + 1} 项食物名称" autocomplete="off">
            ${DIET_FIELDS.map(f => html`
              <input class="exp-fi exp-fi-num" data-field="${f.field}" type="number" value="${item[f.field] || ''}" min="0" placeholder="0"
                aria-label="第 ${i + 1} 项${f.label}">`)}
            <button type="button" class="exp-food-del" data-action="del-food" aria-label="删除第 ${i + 1} 项食物">×</button>
          </div>`)}
      </div>
      <button type="button" class="exp-add-btn" data-action="add-food">+ 添加食物</button>
    </section>`
}

function buildTime(exp) {
  return html`
    <section class="exp-section" aria-labelledby="exp-sec-time">
      <div class="exp-sec-title exp-sec-title-row">
        <h3 class="exp-sec-heading" id="exp-sec-time">时间分配期望</h3>
        ${svcBridge ? html`<button type="button" class="exp-sync-btn" data-action="sync">↻ 同步期望列</button>` : ''}
      </div>
      <div id="exp-time-cats">
        ${TIME_KEYS.map(k => {
          const meta = TIME_META[k]
          const tdata = exp.time[k]
          return html`
            <div class="exp-time-cat collapsed" data-tk="${k}">
              <div class="exp-time-cat-header" data-action="toggle-cat">
                <span class="exp-time-dot" style="--dot-color:${meta.color}" aria-hidden="true"></span>
                <span class="exp-time-cat-label" id="exp-cat-label-${k}">${meta.label}</span>
                <input class="exp-time-total" data-cat-total type="number" value="${numOrEmpty(tdata.hours)}"
                  min="0" max="24" step="0.5" placeholder="0" aria-labelledby="exp-cat-label-${k}">
                <span class="exp-ti-unit">h</span>
                <button type="button" class="exp-cat-toggle" data-action="toggle-cat" aria-expanded="false"
                  aria-controls="exp-ti-wrap-${k}" aria-label="展开${meta.label}事项">▼</button>
              </div>
              <div class="exp-time-items-wrap" id="exp-ti-wrap-${k}">
                <div class="exp-time-items">
                  ${tdata.items.map((it, i) => html`
                    <div class="exp-time-item" data-ii="${i}">
                      <input class="exp-ti-name" data-field="label" value="${it.label}" placeholder="具体事项..."
                        aria-label="${meta.label}第 ${i + 1} 项名称" autocomplete="off">
                      <input class="exp-ti-h" data-field="hours" type="number" value="${numOrEmpty(it.hours)}"
                        min="0" max="24" step="0.5" placeholder="0" aria-label="${meta.label}第 ${i + 1} 项时长">
                      <span class="exp-ti-unit">h</span>
                      <button type="button" class="exp-ti-del" data-action="del-item" aria-label="删除${meta.label}第 ${i + 1} 项">×</button>
                    </div>`)}
                </div>
                <button type="button" class="exp-add-ti" data-action="add-item">+ 添加事项</button>
              </div>
            </div>`
        })}
      </div>
    </section>`
}

function buildMood(exp) {
  return html`
    <section class="exp-section" aria-labelledby="exp-sec-mood">
      <h3 class="exp-sec-title" id="exp-sec-mood">心情期望</h3>
      <div class="exp-mood-row" role="radiogroup" aria-labelledby="exp-sec-mood">
        ${MOOD_KEYS.map(k => html`
          <button type="button" class="exp-mood-btn${exp.mood === k ? ' selected' : ''}" data-action="mood" data-mood="${k}"
            role="radio" aria-checked="${String(exp.mood === k)}">
            <span class="exp-mood-label">${MOOD_META[k].label}</span>
          </button>`)}
      </div>
    </section>`
}

/** 重绘面板并保留各分类展开状态 */
function render() {
  const expanded = new Set([...body.querySelectorAll('.exp-time-cat:not(.collapsed)')].map(el => el.dataset.tk))
  svcDom.setHTML(body, html`${buildBasics(draft)}${buildDiet(draft)}${buildTime(draft)}${buildMood(draft)}`)
  expanded.forEach(k => setCatExpanded(body.querySelector(`.exp-time-cat[data-tk="${k}"]`), true))
}

function setCatExpanded(catEl, open) {
  if (!catEl) return
  catEl.classList.toggle('collapsed', !open)
  catEl.querySelector('.exp-cat-toggle').setAttribute('aria-expanded', String(open))
}

// ── 草稿同步：将表单当前值写回 draft ─────────────────
function collect() {
  BASIC_FIELDS.forEach(({ key }) => {
    draft[key] = parseFloat(body.querySelector(`[data-basic="${key}"]`).value) || 0
  })
  draft.diet = [...body.querySelectorAll('.exp-food-row')].map(row => normalizeDietItem({
    name: row.querySelector('[data-field="name"]').value,
    ...Object.fromEntries(DIET_FIELDS.map(({ field }) =>
      [field, parseFloat(row.querySelector(`[data-field="${field}"]`).value) || 0])),
  }))
  TIME_KEYS.forEach(k => {
    const cat = body.querySelector(`.exp-time-cat[data-tk="${k}"]`)
    draft.time[k] = {
      hours: parseFloat(cat.querySelector('[data-cat-total]').value) || 0,
      items: [...cat.querySelectorAll('.exp-time-item')].map(row => ({
        label: row.querySelector('[data-field="label"]').value,
        hours: parseFloat(row.querySelector('[data-field="hours"]').value) || 0,
      })),
    }
  })
  return draft
}

// ── 操作表 ────────────────────────────────────────────
const ACTIONS = {
  'toggle-cat': (el) => {
    const cat = el.closest('.exp-time-cat')
    setCatExpanded(cat, cat.classList.contains('collapsed'))
  },
  'mood': (el) => {
    body.querySelectorAll('.exp-mood-btn').forEach(b => {
      const on = b === el
      b.classList.toggle('selected', on)
      b.setAttribute('aria-checked', String(on))
    })
    draft.mood = el.dataset.mood
  },
  'add-food': () => {
    collect().diet.push(normalizeDietItem())
    render()
    body.querySelector('.exp-food-row:last-child .exp-fi-name')?.focus()
  },
  'del-food': (el) => {
    const row = el.closest('.exp-food-row')
    const idx = Number(row.dataset.di)
    const name = row.querySelector('[data-field="name"]')?.value?.trim() || `第 ${idx + 1} 项`
    if (!confirm(`确定删除「${name}」？`)) return
    collect().diet.splice(idx, 1)
    render()
  },
  'add-item': (el) => {
    const k = el.closest('.exp-time-cat').dataset.tk
    collect().time[k].items.push({ label: '', hours: 0 })
    render()
    body.querySelector(`.exp-time-cat[data-tk="${k}"] .exp-time-item:last-child .exp-ti-name`)?.focus()
  },
  'del-item': (el) => {
    const k = el.closest('.exp-time-cat').dataset.tk
    collect().time[k].items.splice(Number(el.closest('.exp-time-item').dataset.ii), 1)
    render()
  },
  'sync': () => {
    const ok = svcBridge.syncIdealToQLExpectations(collect())
    draft = svcExpectations.normalizeExpectations(draft)
    render()
    svcUi.showToast(ok ? '✓ 已从规划期望列同步（保存后生效）' : '规划期望列暂无数据')
  },
}

body.addEventListener('click', e => {
  // 分类合计输入框位于可点击的分类头内，点击输入框不触发折叠
  if (e.target.closest('input')) return
  const el = e.target.closest('[data-action]')
  if (el) ACTIONS[el.dataset.action]?.(el)
})

// ── 面板开关 ──────────────────────────────────────────
function openPanel() {
  editorBase = svcStorage.store.getCommitted(svcMetadata.EXPECTATIONS_KEY, null)
  draft = svcExpectations.normalizeExpectations(editorBase) || svcExpectations.normalizeExpectations({})
  render()
  svcUi.openDialog(dlg)
}

const closePanel = () => svcUi.closeDialog(dlg)

async function saveAndClose() {
  if (!svcExpectations.saveExpectations(collect(), { base: editorBase })) return
  if (svcStorage.store.mode === 'indexeddb') {
      try { await svcStorage.store.flush() } catch { return }
    }
  svcUi.showToast('✅ 期望已保存')
  closePanel()
}

svcUi.bindDialog(dlg, { onClose: () => { draft = null } })
$('#exp-open-btn').addEventListener('click', openPanel)
$('#exp-close').addEventListener('click', closePanel)
$('#exp-cancel').addEventListener('click', closePanel)
$('#exp-save').addEventListener('click', saveAndClose)
