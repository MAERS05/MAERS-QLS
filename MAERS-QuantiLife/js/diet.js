import { metadata as svcMetadata } from '../../common/js/core.js'
import { dom as svcDom } from '../../common/js/dom.js'

const svcDietView = {}
export const dietView = svcDietView

/**
 * MAERS QuantiLife — 饮食管理模块 (diet.js)
 */

const $ = svcDom.$
const html = svcDom.html
const normalizeDietItem = svcMetadata.normalizeDietItem

const MACRO_FIELDS = [
  { field: 'carb',    label: '碳水 (g)',    step: '0.1' },
  { field: 'protein', label: '蛋白质 (g)',  step: '0.1' },
  { field: 'fat',     label: '脂肪 (g)',    step: '0.1' },
  { field: 'cal',     label: '热量 (kcal)', step: '1' },
]

const listEl = $('#food-list')
let foodItems = []

const notifyChange = () => svcDietView.diet.onChange?.()

function renderFoodItem(item, idx) {
  const n = idx + 1
  return html`
    <div class="food-item" data-idx="${idx}">
      <input class="food-name" type="text" placeholder="食物名称..." value="${item.name}" data-field="name"
        aria-label="第 ${n} 项食物名称" autocomplete="off" />
      ${MACRO_FIELDS.map(({ field, label, step }) => html`
        <div class="food-macro"><input type="number" placeholder="0" value="${item[field] || ''}" data-field="${field}"
          min="0" step="${step}" aria-label="第 ${n} 项${label}" /></div>`)}
      <button type="button" class="remove-btn" data-remove title="删除" aria-label="删除第 ${n} 项食物">×</button>
    </div>`
}

function updateDietSummary() {
  const sum = { carb: 0, protein: 0, fat: 0, cal: 0 }
  foodItems.forEach(f => Object.keys(sum).forEach(k => { sum[k] += f[k] || 0 }))
  $('#sum-carb').textContent    = sum.carb.toFixed(1)
  $('#sum-protein').textContent = sum.protein.toFixed(1)
  $('#sum-fat').textContent     = sum.fat.toFixed(1)
  $('#sum-cal').textContent     = Math.round(sum.cal)
}

function renderFoodList() {
  svcDom.setHTML(listEl, html`${foodItems.map(renderFoodItem)}`)
  updateDietSummary()
}

// 输入事件委托：只更新内存数据与汇总，不重绘列表，保持输入焦点
listEl.addEventListener('input', e => {
  const row = e.target.closest('.food-item')
  const field = e.target.dataset.field
  if (!row || !field) return
  const item = foodItems[Number(row.dataset.idx)]

  if (field === 'name') {
    item.name = e.target.value
  } else {
    item[field] = parseFloat(e.target.value) || 0
    // 自动计算热量 (碳水*4 + 蛋白*4 + 脂肪*9)
    if (field !== 'cal') {
      item.cal = Math.round(item.carb * 4 + item.protein * 4 + item.fat * 9)
      row.querySelector('[data-field="cal"]').value = item.cal || ''
    }
  }
  updateDietSummary()
  notifyChange()
})

listEl.addEventListener('click', e => {
  const btn = e.target.closest('[data-remove]')
  if (!btn) return
  // 删除前二次确认，防止误操作
  const idx = Number(btn.closest('.food-item').dataset.idx)
  const name = foodItems[idx]?.name?.trim() || `第 ${idx + 1} 项`
  if (!confirm(`确定删除「${name}」？`)) return
  foodItems.splice(idx, 1)
  renderFoodList()
  notifyChange()
})

/** 追加空行；仅用户主动添加时聚焦，程序补齐空行不得抢焦点（会触发页面滚动跳转） */
function addEmptyFood({ focus = false } = {}) {
  foodItems.push(normalizeDietItem())
  renderFoodList()
  if (focus) listEl.querySelector('.food-item:last-child .food-name')?.focus()
}

$('#add-food-btn').addEventListener('click', () => addEmptyFood({ focus: true }))

svcDietView.diet = {
  getItems:  () => foodItems.map(normalizeDietItem),
  setItems:  (items) => { foodItems = (items || []).map(normalizeDietItem); renderFoodList() },
  clear:     () => { foodItems = []; renderFoodList() },
  ensureOne: () => { if (foodItems.length === 0) addEmptyFood() },
  onChange:  null,
}
