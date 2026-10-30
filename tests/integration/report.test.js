/**
 * 报告页集成测试 (tests/integration/report.test.js)
 * 以真实报告页验证：聚合口径（旧版分类键 + 新版多标签）、分区渲染、排行下钻与模式切换。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, click, plain } = require('../helpers/dom')

/** 生成相对今天偏移 offset 天的日期键（YYYY-MM-DD，本地时区） */
function dayKey(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 预置两天数据：昨天含旧版分类键与并行事项，今天为纯基础指标 */
function seededStorage() {
  const yesterday = dayKey(-1)
  const today = dayKey(0)
  return {
    quantilife_tags: { 编程: 'career', 阅读: 'learn' },
    [`quantilife_${yesterday}`]: {
      date: yesterday,
      basics: { steps: 6000, sleep: 7, water: 1500 },
      diet: [{ name: '午餐', carb: 100, protein: 30, fat: 20 }],
      timeEvents: [
        { name: '写代码', h: 3, tags: ['编程'] },
        { name: '睡眠', h: 7, tags: ['basic'] },
        { name: '边听边写', h: 1, tags: ['编程', '阅读'] },
      ],
      mood: 'great',
    },
    [`quantilife_${today}`]: {
      date: today,
      basics: { steps: 8000, sleep: 8, water: 2000 },
      diet: [{ name: '晚餐', carb: 60, protein: 10, fat: 5 }],
      timeEvents: [],
    },
  }
}

const setup = (storage = seededStorage()) => createPage('MAERS-QuantiLife/report.html', { storage })

test('聚合引擎：日均指标按有记录天数平均，标签与大类分别统计单一/并行时长', () => {
  const { QL, window } = setup()
  const end = new window.Date()
  const start = new window.Date(end.getFullYear(), end.getMonth(), end.getDate() - 6)
  const agg = QL.reportAggregator.totalAgg(start, end)

  assert.equal(agg.totalDays, 7)
  assert.equal(agg.recordDays, 2, '仅统计有记录的天数')
  assert.equal(agg.avgSteps, 7000)
  assert.equal(agg.avgCarb, 80)

  assert.equal(agg.tagStats['编程'].pureH, 3, '单一事项计入 pure')
  assert.equal(agg.tagStats['编程'].fusedH, 1, '多标签事项计入 fused')
  assert.equal(agg.tagStats['阅读'].fusedH, 1)
  assert.equal(agg.catStats.basic.pureH, 7, '旧版分类键标签应解析为大类并计入单一时长')
  assert.equal(agg.moods.great, 1)
})

test('分桶：精度合并相邻天，无记录分桶标记为 0 天', () => {
  const { QL, window } = setup()
  const end = new window.Date()
  const start = new window.Date(end.getFullYear(), end.getMonth(), end.getDate() - 3)

  const daily = QL.reportAggregator.buildBuckets(start, end, 1).buckets
  assert.equal(daily.length, 4)
  assert.equal(daily.filter(b => b.recordDays > 0).length, 2)

  const merged = QL.reportAggregator.buildBuckets(start, end, 2).buckets
  assert.equal(merged.length, 2)
  assert.equal(merged[1].recordDays, 2, '后两天合并为一个分桶')
  assert.equal(merged[1].steps, 7000)
})

test('报告渲染：默认今天（1/1），切换近 7 天后输出概览/基础/时间/饮食/心情五个分区', () => {
  const { document } = setup()
  const sections = document.querySelectorAll('#report-content > section.section')
  assert.equal(sections.length, 5)
  assert.equal(document.querySelector('.preset-btn[data-preset="1"]').getAttribute('aria-pressed'), 'true')
  assert.equal(document.querySelector('.kpi-value').textContent.replace(/\s/g, ''), '1/1')

  click(document.querySelector('.preset-btn[data-preset="7"]'))
  assert.equal(document.querySelector('.preset-btn[data-preset="7"]').getAttribute('aria-pressed'), 'true')
  assert.equal(document.querySelector('.kpi-value').textContent.replace(/\s/g, ''), '2/7')
  assert.ok(document.querySelectorAll('#report-content svg').length > 0, '应渲染 SVG 图表')
})

test('空区间：没有记录时展示空状态', () => {
  const { document } = setup({})
  assert.equal(document.querySelector('#report-content .empty-state') !== null, true)
  assert.equal(document.querySelectorAll('#report-content section.section').length, 0)
})

test('排行：大类点击下钻到标签排行，返回恢复大类视图', () => {
  const { QL, document } = setup()
  click(document.querySelector('.preset-btn[data-preset="7"]'))
  const cat = QL.resolveTagCategory('编程')
  const row = document.querySelector(`.td-bar-clickable[data-cat="${cat}"]`)
  assert.ok(row, '大类排行应可点击')

  click(row)
  assert.ok(document.querySelector('.rank-back-btn'), '下钻后应出现返回按钮')
  assert.equal(document.querySelector('.td-bar-clickable'), null, '标签排行不再下钻')
  assert.ok(document.querySelector('.report-rank-bars').textContent.includes('编程'))

  click(document.querySelector('.rank-back-btn'))
  assert.equal(document.querySelector('.rank-back-btn'), null)
  assert.ok(document.querySelector('.td-bar-clickable'))
})

test('并行事项模式：切换后重绘并保留选中状态', () => {
  const { document, window } = setup()
  const radio = document.querySelector('input[name="reportTimeMode"][value="pure"]')
  radio.checked = true
  radio.dispatchEvent(new window.Event('change', { bubbles: true }))

  const checked = document.querySelector('input[name="reportTimeMode"]:checked')
  assert.equal(checked.value, 'pure')
  assert.equal(plain([...document.querySelectorAll('input[name="reportTimeMode"]')].map(el => el.value)).length, 3)
})

test('包含并行以单条连续呈现单一与并行，仅并行按分类或标签组合排行', () => {
  const { document, window } = setup()
  click(document.querySelector('.preset-btn[data-preset="7"]'))
  const careerRow = document.querySelector('.td-bar-item[data-cat="career"]')
  assert.ok(careerRow, '包含并行时大类仍可点击查看详情')
  assert.equal(careerRow.querySelectorAll('.td-bar-track').length, 1, '每个大类只显示一条连续时间条')
  assert.equal(careerRow.querySelectorAll('.td-bar-fill, .td-bar-fill-fused').length, 2, '单一与并行在同一条内连续显示')
  assert.equal(careerRow.querySelectorAll('.td-dual-kind, .bar-text-inner, [data-tooltip]').length, 0,
    '时间条内部不显示单一/并行文字、时长或悬浮提示')
  assert.match(
    careerRow.querySelector('.td-bar-fill-fused').getAttribute('style'),
    /linear-gradient/,
    '跨大类并行应保留混合色，而不是统一套用当前大类的浅色',
  )

  const only = document.querySelector('input[name="reportTimeMode"][value="only"]')
  only.checked = true
  only.dispatchEvent(new window.Event('change', { bubbles: true }))
  const categoryCombination = document.querySelector('.td-combo-item')
  assert.match(categoryCombination.textContent, /学习内养类.*事业发展类/, '仅并行顶层按大类组合命名')

  const include = document.querySelector('input[name="reportTimeMode"][value="include"]')
  include.checked = true
  include.dispatchEvent(new window.Event('change', { bubbles: true }))
  click(document.querySelector('.td-bar-item[data-cat="career"]'))
  const detailOnly = document.querySelector('input[name="reportTimeMode"][value="only"]')
  detailOnly.checked = true
  detailOnly.dispatchEvent(new window.Event('change', { bubbles: true }))
  const tagCombination = document.querySelector('.td-combo-item')
  assert.match(tagCombination.textContent, /编程/)
  assert.match(tagCombination.textContent, /阅读/, '大类详情的仅并行按标签组合命名')
})

test('排行条：单一事项模式同样采用无内嵌文字与无悬浮提示的纯净时间条', () => {
  const { document, window } = setup()
  click(document.querySelector('.preset-btn[data-preset="7"]'))
  const pure = document.querySelector('input[name="reportTimeMode"][value="pure"]')
  pure.checked = true
  pure.dispatchEvent(new window.Event('change', { bubbles: true }))

  const careerRow = document.querySelector('.td-bar-item[data-cat="career"]')
  assert.ok(careerRow)
  assert.equal(careerRow.querySelectorAll('.td-bar-fill').length, 1)
  assert.equal(careerRow.querySelectorAll('.td-bar-fill-fused, .bar-text-inner, [data-tooltip]').length, 0,
    '单一事项模式不显示并行段、条内数值或悬浮提示')
  assert.equal(careerRow.querySelector('.td-bar-value').textContent.trim(), '3h')
})
