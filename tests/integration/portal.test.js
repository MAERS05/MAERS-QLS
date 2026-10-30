/**
 * 门户（主页）全局备份导入集成测试 (tests/integration/portal.test.js)
 * 验证跨系统原子导入：QuantiLife 与 Schedule 条目合并后一次性写入，任一失败整体回滚。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, waitFor } = require('../helpers/dom')

/** 通过隐藏的文件选择框向主页注入一份备份 JSON */
function importViaPortal({ window, document }, json) {
  const input = document.getElementById('qls-import-file')
  const text = JSON.stringify(json)
  Object.defineProperty(input, 'files', {
    configurable: true,
    value: [{ size: text.length, text: async () => text }],
  })
  input.dispatchEvent(new window.Event('change'))
}

const dayData = (date, steps) => ({
  date, basics: { steps, sleep: 0, water: 0 }, diet: [], timeEvents: [], mood: null,
})

/** 等待 Toast 出现指定文案 */
const waitToast = (document, fragment) => waitFor(() => document.body.textContent.includes(fragment))

test('门户导入：QuantiLife 与 Schedule 条目一次性写入并同步内存标签库', async () => {
  const page = createPage('index.html')
  const { QL, QLS, document } = page
  await page.ready()

  importViaPortal(page, QLS.createBackup({
    quantilife_tags: { 新标签: 'career' },
    'quantilife_2026-10-15': dayData('2026-10-15', 9000),
    [QLS.SCH_ENTRY_KEY]: 'timeline',
  }))
  await waitToast(document, '已恢复 3 条')

  assert.equal(QL.loadDayData('2026-10-15').basics.steps, 9000)
  assert.equal(QL.TAG_META['新标签'], 'career')
  assert.equal(page.read(QLS.SCH_ENTRY_KEY), 'timeline')
})

test('门户导入：仅含 QuantiLife 数据的备份可正常导入（Schedule 无条目）', async () => {
  const page = createPage('index.html')
  const { QL, QLS, document } = page
  await page.ready()

  importViaPortal(page, QLS.createBackup({
    'quantilife_2026-10-15': dayData('2026-10-15', 4321),
  }))
  await waitToast(document, '已恢复 1 条')
  assert.equal(QL.loadDayData('2026-10-15').basics.steps, 4321)
})

test('门户导入：仅含 Schedule 数据的备份可正常导入（QuantiLife 无条目）', async () => {
  const page = createPage('index.html')
  const { QLS, document } = page
  await page.ready()

  importViaPortal(page, QLS.createBackup({ [QLS.SCH_ENTRY_KEY]: 'inprogress' }))
  await waitToast(document, '已恢复 1 条')
  assert.equal(page.read(QLS.SCH_ENTRY_KEY), 'inprogress')
})

test('门户导入：无可识别数据时提示警告且不写入', async () => {
  const page = createPage('index.html')
  const { QLS, document, localStorage } = page
  await page.ready()
  const before = localStorage.length

  importViaPortal(page, QLS.createBackup({ unknown_key: 1 }))
  await waitToast(document, '没有可识别的 QLS 数据')
  assert.equal(localStorage.length, before)
})

test('门户导入：后一子系统写入失败时，前一子系统数据同样整体回滚', async () => {
  const page = createPage('index.html')
  const { QL, QLS, document, localStorage } = page
  await page.ready()
  QL.saveTag('旧标签', 'learn')

  const proto = Object.getPrototypeOf(localStorage)
  const originalSetItem = proto.setItem
  const originalError = console.error
  console.error = () => {}
  try {
    Object.defineProperty(proto, 'setItem', {
      configurable: true,
      value(key, value) {
        // QuantiLife 条目先写入，Schedule 条目在其后失败，验证跨系统回滚
        if (key === QLS.SCH_ENTRY_KEY) throw new Error('quota exceeded')
        return originalSetItem.call(this, key, value)
      },
    })
    importViaPortal(page, QLS.createBackup({
      quantilife_tags: { 新标签: 'career' },
      'quantilife_2026-10-15': dayData('2026-10-15', 9000),
      [QLS.SCH_ENTRY_KEY]: 'timeline',
    }))
    await waitToast(document, '导入失败')

    assert.equal(QL.loadDayData('2026-10-15'), null, 'QuantiLife 日记录必须回滚')
    assert.equal(QL.loadTags()['新标签'], undefined)
    assert.equal(QL.TAG_META['旧标签'], 'learn')
    assert.equal(QL.TAG_META['新标签'], undefined, '失败时不得更新内存标签库')
  } finally {
    Object.defineProperty(proto, 'setItem', { configurable: true, value: originalSetItem })
    console.error = originalError
  }
})

test('门户导入：不改写“上次导出备份”时间', async () => {
  const stamp = '2020-01-01T00:00:00.000Z'
  const page = createPage('index.html', { storage: { qls_last_exported_at: stamp } })
  const { QLS, document } = page
  await page.ready()

  importViaPortal(page, { ...QLS.createBackup({ [QLS.SCH_ENTRY_KEY]: 'timeline' }), exportedAt: new Date().toISOString() })
  await waitToast(document, '已恢复 1 条')
  assert.equal(page.read('qls_last_exported_at'), stamp)
})

test('示例数据集 (qls-test-data.json)：符合 Schema v2 格式且可经门户完整导入', async () => {
  const backup = require('../qls-test-data.json')
  const page = createPage('index.html')
  const { QL, MS, QLS, document } = page
  await page.ready()

  importViaPortal(page, backup)
  const totalKeys = Object.keys(backup.data).length
  await waitToast(document, `已恢复 ${totalKeys} 条`)

  assert.ok(QL.loadDayData('2026-10-27'), '应包含锚点日 2026-10-27 的量化记录')
  assert.ok(MS.loadBlocks('2026-10-27').length > 0, '应包含锚点日时间块与重复规则命中')

  const blocks = Object.values(backup.data.schedule_timeblocks).flat()
  const inprogress = backup.data.schedule_inprogress
  assert.equal([...blocks, ...inprogress].some(item => 'color' in item), false, '不得残留旧版 color 字段')
  assert.equal([...blocks, ...inprogress].every(item => Boolean(QLS.TIME_META[item.category])), true, '分类键必须全部合法')
})
