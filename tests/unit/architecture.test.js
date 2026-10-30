'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, createIdbFactory } = require('../helpers/dom')

test('兼容接口没有公共命名空间原型，内部模块在删除全局入口后仍能工作', () => {
  const page = createPage('index.html')
  const { MS, QL, QLS, MAERS_BRIDGE: bridge, window } = page
  assert.notEqual(Object.getPrototypeOf(MS), QLS)
  assert.notEqual(Object.getPrototypeOf(QL), QLS)
  delete window.QLS
  delete window.MS
  delete window.QL
  delete window.MAERS_BRIDGE
  const task = MS.saveTaskOrGoal({ title: '无全局依赖', tier: 'short' })
  assert.equal(MS.loadTasks()[0].id, task.id)
  bridge.saveQLTags({ 阅读: 'learn' })
  assert.equal(QL.resolveTagCategory('阅读'), 'learn')
  // Keep the helper's ready() accessor available for normal cleanup consumers.
  window.QLS = QLS
})

test('桥接与量化共享标签仓库；读取快照的修改不会绕过保存入口', () => {
  const { QL, MAERS_BRIDGE: bridge } = createPage('index.html')
  bridge.saveQLTags({ 阅读: 'learn' })
  const snapshot = QL.TAG_META
  snapshot.阅读 = 'waste'
  assert.equal(QL.loadTags().阅读, 'learn')
  QL.saveTag('运动', 'health')
  assert.equal(bridge.getQLTags().运动, 'health')
  QL.deleteTag('阅读')
  assert.equal(bridge.getQLTags().阅读, undefined)
})

test('存储初始化与任务入账不需要桥接或其他业务全局对象', async () => {
  const page = createPage('index.html', {
    indexedDB: createIdbFactory(),
    beforeScripts(window) {
      for (const name of ['QLS', 'MS', 'QL', 'MAERS_BRIDGE']) {
        Object.defineProperty(window, name, {
          configurable: true,
          get() { throw new Error('Unexpected global access: ' + name) },
          set(value) { Object.defineProperty(window, name, { value, writable: true, configurable: true }) },
        })
      }
    },
  })
  // Entry composition intentionally publishes compatibility views only after modules initialize.
  await page.ready()
  const start = new page.window.Date(2026, 9, 29, 9).getTime()
  const task = page.MS.startInProgressTask({ title: '独立入账', category: 'learn', tags: ['阅读'], now: start })
  delete page.window.MAERS_BRIDGE
  page.MS.finishInProgressTask(task.id, start + 3600000)
  await page.QLS.store.flush()
  assert.equal(page.QL.loadDayData('2026-10-29').time.learn, 1)
})
