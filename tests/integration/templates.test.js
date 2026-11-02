'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, createIdbFactory, click, type, waitFor, plain } = require('../helpers/dom')

async function open(factory, pathname = 'MAERS-Schedule/index.html') {
  const page = createPage(pathname, { indexedDB: factory })
  await page.ready()
  return page
}

async function addTemplate(page, name) {
  const { document } = page
  if (!document.querySelector('#tb-templates-modal').open) click(document.querySelector('#tb-toggle-ideal'))
  type(document.querySelector('#tb-template-name'), name)
  click(document.querySelector('#tb-template-add'))
  await waitFor(() => document.querySelector('#tb-template-name').value === '' && !document.querySelector('#tb-template-add').disabled)
  return page.MS.loadTemplates().items.find(item => item.name === name)
}

test('默认占位：Schedule 空白处提示先创建，量化默认按钮只提示且不打开配置', async () => {
  const factory = createIdbFactory()
  const schedule = await open(factory)
  const quanti = await open(factory, 'MAERS-QuantiLife/index.html')
  assert.equal(schedule.document.querySelector('.tb-ideal-title').textContent, '默认')
  assert.equal(quanti.document.querySelector('#exp-active-name').textContent, '默认')
  click(schedule.document.querySelector('.tb-day-body[data-date="ideal"]'))
  await waitFor(() => schedule.document.querySelector('#toast')?.textContent.includes('请点击默认框创建自定义后添加'))
  assert.equal(schedule.document.querySelector('#tb-modal').open, false)
  click(quanti.document.querySelector('#exp-open-btn'))
  assert.equal(quanti.document.querySelector('#exp-overlay').open, false)
  assert.match(quanti.document.querySelector('#toast').textContent, /未发现schedule里的自定义列/)
  assert.equal(schedule.QLS.store.has(schedule.QLS.TIMEBLOCK_KEY), false)
})

test('创建、切换和删除命名时间列：独立时间表、量化按钮及时间分配同步更新', async () => {
  const factory = createIdbFactory()
  const schedule = await open(factory)
  const quanti = await open(factory, 'MAERS-QuantiLife/index.html')
  const { MS, QLS, document } = schedule
  MS.saveBlock('2026-11-01', { id: 'actual', label: '实际安排', startH: 9, durationH: 1, category: 'career' })
  await QLS.store.flush()
  const actual = plain(MS.loadBlocks('2026-11-01'))

  const work = await addTemplate(schedule, '工作')
  click(document.querySelector(`[data-template-select="${work.id}"]`))
  await waitFor(() => !document.querySelector('#tb-templates-modal').open)
  await waitFor(() => quanti.document.querySelector('#exp-active-name').textContent === '工作')
  MS.openBlockModal({ dateStr: 'ideal', startH: 9, durationH: 2 })
  assert.equal(document.querySelector('#tb-block-ideal-label').value, '工作')
  type(document.querySelector('#tb-block-label'), '专注工作')
  click(document.querySelector('#tb-block-save'))
  await waitFor(() => !document.querySelector('#tb-modal').open)
  await waitFor(() => quanti.QL.loadExpectations().time.basic.hours === 2)
  assert.match(document.querySelector('.tb-day-body[data-date="ideal"]').textContent, /专注工作/)

  const holiday = await addTemplate(schedule, '假期')
  click(document.querySelector(`[data-template-select="${holiday.id}"]`))
  await waitFor(() => !document.querySelector('#tb-templates-modal').open)
  await waitFor(() => quanti.document.querySelector('#exp-active-name').textContent === '假期')
  assert.equal(MS.loadBlocks('ideal').length, 0)
  assert.equal(quanti.QL.loadExpectations().time.basic.hours, 0)
  click(quanti.document.querySelector('#exp-open-btn'))
  assert.equal(quanti.document.querySelector('#exp-title').textContent, '假期')
  assert.match(quanti.document.querySelector('[data-action="sync"]').textContent, /同步当前方案/)
  click(quanti.document.querySelector('#exp-cancel'))

  click(document.querySelector('#tb-toggle-ideal'))
  click(document.querySelector(`[data-template-select="${work.id}"]`))
  await waitFor(() => !document.querySelector('#tb-templates-modal').open)
  await waitFor(() => quanti.QL.loadExpectations().time.basic.hours === 2)
  assert.equal(document.querySelector('.tb-ideal-title').textContent, '工作')
  assert.deepEqual(plain(MS.loadBlocks('2026-11-01')), actual)

  click(document.querySelector('#tb-toggle-ideal'))
  click(document.querySelector(`[data-template-delete="${work.id}"]`))
  await waitFor(() => MS.loadTemplates().items.length === 1 && !document.querySelector('#tb-template-add').disabled)
  click(document.querySelector(`[data-template-delete="${holiday.id}"]`))
  await waitFor(() => MS.loadActiveTemplate() === null && !document.querySelector('#tb-template-add').disabled)
  await waitFor(() => quanti.document.querySelector('#exp-active-name').textContent === '默认')
  assert.equal(document.querySelector('.tb-ideal-title').textContent, '默认')
  assert.equal(quanti.QL.loadExpectations().time.basic.hours, 0)
})

test('自定义弹窗：精简文案与无障碍属性、空名称和重名校验、中文输入法保护及重复开关', async () => {
  const page = await open(createIdbFactory())
  const { document, window } = page
  click(document.querySelector('#tb-toggle-ideal'))
  assert.equal(document.querySelector('label[for="tb-template-name"]'), null)
  assert.equal(document.querySelector('#tb-templates-list').hidden, true)
  assert.doesNotMatch(document.querySelector('#tb-templates-modal').textContent, /还没有自定义列|新增名称/)
  assert.equal(document.querySelector('#tb-template-add').textContent.trim(), '+')
  assert.equal(document.querySelector('#tb-template-name').getAttribute('aria-label'), '自定义时间列名称')
  assert.equal(document.querySelector('#tb-template-add').getAttribute('aria-label'), '添加自定义时间列')
  click(document.querySelector('#tb-template-add'))
  assert.match(document.querySelector('#toast').textContent, /请输入自定义名称/)
  type(document.querySelector('#tb-template-name'), '组词中')
  document.querySelector('#tb-template-name').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))
  assert.equal(page.MS.loadTemplates().items.length, 0)
  const work = await addTemplate(page, '<工作>')
  assert.equal(document.querySelector('#tb-templates-list').hidden, false)
  assert.equal(document.querySelector('[data-template-select] span').textContent, '<工作>')
  type(document.querySelector('#tb-template-name'), '<工作>')
  click(document.querySelector('#tb-template-add'))
  assert.equal(page.MS.loadTemplates().items.length, 1)
  assert.match(document.querySelector('#toast').textContent, /名称已经存在/)
  click(document.querySelector('#tb-templates-close'))
  assert.equal(document.querySelector('#tb-templates-modal').open, false)
  click(document.querySelector('#tb-toggle-ideal'))
  assert.ok(document.querySelector(`[data-template-select="${work.id}"]`))
})

test('自定义弹窗：行内重命名同步标题与量化按钮，校验空名称、重名，Esc 仅取消编辑', async () => {
  const factory = createIdbFactory()
  const page = await open(factory)
  const quanti = await open(factory, 'MAERS-QuantiLife/index.html')
  const { document, window } = page
  const work = await addTemplate(page, '工作')
  const life = await addTemplate(page, '生活')
  const openEditor = id => {
    click(document.querySelector(`[data-template-rename="${id}"]`))
    return document.querySelector('[data-template-rename-input]')
  }

  let input = openEditor(work.id)
  assert.equal(input.value, '工作')
  type(input, '   ')
  click(document.querySelector(`[data-template-rename-save="${work.id}"]`))
  assert.match(document.querySelector('#toast').textContent, /请输入自定义名称/)
  type(input, '生活')
  click(document.querySelector(`[data-template-rename-save="${work.id}"]`))
  assert.match(document.querySelector('#toast').textContent, /名称已经存在/)
  assert.equal(page.MS.loadTemplates().items.find(item => item.id === work.id).name, '工作')

  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  assert.equal(document.querySelector('[data-template-rename-input]'), null)
  assert.equal(document.querySelector('#tb-templates-modal').open, true)

  input = openEditor(life.id)
  type(input, '假期')
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  await waitFor(() => page.MS.loadTemplates().items.some(item => item.name === '假期') && !document.querySelector('[data-template-rename-input]'))
  const state = page.MS.loadTemplates()
  assert.equal(state.activeId, life.id)
  assert.deepEqual(plain(state.items.map(item => item.id)), [work.id, life.id])
  assert.equal(document.querySelector('.tb-ideal-title').textContent, '假期')
  await waitFor(() => quanti.document.querySelector('#exp-active-name').textContent === '假期')
})

test('自定义弹窗：持久化失败保留新增名称，重试成功后才清空输入', async t => {
  t.mock.method(console, 'error', () => {})
  const factory = createIdbFactory()
  const page = await open(factory)
  const { document } = page
  click(document.querySelector('#tb-toggle-ideal'))
  type(document.querySelector('#tb-template-name'), '工作')
  const request = factory.open('maers-qls-data', 1)
  const db = await new Promise(resolve => { request.onsuccess = () => resolve(request.result) })
  const proto = Object.getPrototypeOf(db.transaction('keyvalue').objectStore('keyvalue'))
  const original = proto.put
  proto.put = function (value, ...args) {
    if (value.key === page.QLS.EXPECTATIONS_KEY) throw new Error('disk full')
    return original.call(this, value, ...args)
  }
  try {
    click(document.querySelector('#tb-template-add'))
    await assert.rejects(page.QLS.store.flush())
    await waitFor(() => !document.querySelector('#tb-template-add').disabled)
    assert.equal(document.querySelector('#tb-template-name').value, '工作')
    assert.equal(document.querySelector('#tb-templates-modal').open, true)
    assert.equal(page.MS.loadTemplates().items.length, 0)
  } finally { proto.put = original; db.close() }
  click(document.querySelector('#tb-template-add'))
  await waitFor(() => document.querySelector('#tb-template-name').value === '')
  assert.equal(page.MS.loadActiveTemplate().name, '工作')
})
