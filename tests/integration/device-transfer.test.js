'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, createIdbFactory, click, type, waitFor } = require('../helpers/dom')

async function open() {
  const page = createPage('index.html', { indexedDB: createIdbFactory(), beforeScripts(win) { win.RTCPeerConnection = function () { this.close = () => {} } } })
  await page.ready()
  page.data = page.module('common/js/device-transfer.js').deviceTransfer
  page.events = null; page.sent = null; page.applied = null; page.closed = 0; page.rejected = false
  page.fake = {
    offer: async () => '本机连接码', answer: async () => '本机应答码',
    connect: async () => page.events.onState('connected'),
    send: async outgoing => { page.sent = outgoing },
    applied: receipt => { page.applied = receipt }, reject: () => { page.rejected = true }, close: () => { page.closed++ },
  }
  page.module('common/js/peer-transfer.js').peerTransfer.create = callbacks => { page.events = callbacks; return page.fake }
  page.el = suffix => page.document.querySelector('#transfer-' + suffix)
  click(page.document.querySelector('#qls-transfer-btn'))
  click(page.document.querySelector('[data-transfer-mode="code"]'))
  await waitFor(() => page.el('local-code').value === '本机连接码')
  return page
}
async function idle(page) { await waitFor(() => !page.el('restart').disabled) }
async function receive(page, text) {
  click(page.document.querySelector('[data-transfer-role="receive"]'))
  type(page.el('remote-code'), '对方连接码'); click(page.el('connect')); await idle(page)
  assert.equal(page.el('local-code').value, '本机应答码')
  page.events.onState('connected'); page.events.onPayload(text)
  await waitFor(() => !page.el('preview').hidden)
}

test('设备互传界面：发送步骤、复制回退、保存回执和断开后的完成状态', async () => {
  const page = await open()
  page.MS.saveTaskOrGoal({ title: '发送任务' }); await page.QLS.store.flush()
  await idle(page)
  assert.equal(page.el('local-code').value, '本机连接码')
  let clipboard = ''
  Object.defineProperty(page.window.navigator, 'clipboard', { configurable: true, value: { writeText: async value => { clipboard = value } } })
  click(page.el('copy')); await idle(page)
  assert.equal(clipboard, '本机连接码')
  Object.defineProperty(page.window.navigator, 'clipboard', { value: undefined })
  click(page.el('copy')); await idle(page)
  assert.match(page.el('status').textContent, /系统复制/)
  assert.equal(page.el('local-code').selectionEnd, '本机连接码'.length)
  type(page.el('remote-code'), '对方应答码'); click(page.el('connect')); await idle(page)
  click(page.el('send')); await idle(page)
  assert.equal(page.sent.envelope.data.schedule_tasks[0].title, '发送任务')
  assert.match(page.el('status').textContent, /等待对方确认/)
  page.events.onApplied({ id: page.sent.envelope.id })
  assert.match(page.el('status').textContent, /对方已确认/)
  page.events.onState('disconnected')
  assert.match(page.el('status').textContent, /传输完成/)
  click(page.el('close'))
  assert.equal(page.document.querySelector('#device-transfer-dialog').open, false)
  assert.ok(page.closed > 0)
})

test('设备互传界面：取消不写入，预览后变更需重新确认，覆盖后可恢复', async () => {
  const source = await open(), page = await open()
  source.MS.saveTaskOrGoal({ title: '来源任务' }); await source.QLS.store.flush()
  page.MS.saveTaskOrGoal({ title: '本机任务' }); await page.QLS.store.flush()
  const outgoing = await source.data.outgoing()
  await receive(page, outgoing.text)
  click(page.el('reject'))
  assert.equal(page.rejected, true)
  assert.equal(page.MS.loadTasks()[0].title, '本机任务')
  click(page.el('restart'))
  await receive(page, outgoing.text)
  page.MS.saveTaskOrGoal({ title: '刚刚新增' }); await page.QLS.store.flush()
  click(page.el('accept')); await idle(page)
  assert.match(page.el('status').textContent, /重新确认/)
  assert.equal(page.MS.loadTasks().length, 2)
  click(page.el('accept')); await idle(page)
  assert.equal(page.MS.loadTasks()[0].title, '来源任务')
  assert.equal(page.applied.id, outgoing.envelope.id)
  assert.equal(page.el('restore').hidden, false)
  click(page.el('restore')); await idle(page)
  assert.equal(page.MS.loadTasks().length, 2)
  assert.match(page.el('status').textContent, /已恢复/)
})

test('设备互传界面：缺少或无效连接码不推进，损坏业务数据不显示覆盖按钮', async () => {
  const page = await open()
  click(page.document.querySelector('[data-transfer-role="receive"]'))
  click(page.el('connect')); await idle(page)
  assert.match(page.el('status').textContent, /先粘贴/)
  page.fake.answer = async () => { throw new Error('连接码不完整') }
  type(page.el('remote-code'), 'bad'); click(page.el('connect')); await idle(page)
  assert.match(page.el('status').textContent, /连接码不完整/)
  page.events.onPayload('invalid JSON'); await idle(page)
  assert.equal(page.el('preview').hidden, true)
  assert.equal(page.QLS.store.keys('schedule_').length, 0)
  page.events.onError(new Error('连接失败'))
  assert.match(page.el('status').textContent, /连接失败/)
})

test('设备互传界面：取消生成连接码后，迟到的异步结果不能改写新弹窗', async () => {
  const page = await open()
  click(page.document.querySelector('[data-transfer-role="receive"]'))
  let finish
  page.fake.offer = () => new Promise(resolve => { finish = resolve })
  click(page.document.querySelector('[data-transfer-role="send"]'))
  click(page.el('close'))
  page.fake.offer = async () => '新连接码'
  click(page.document.querySelector('#qls-transfer-btn'))
  finish('迟到的连接码')
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(page.el('local-code').value, '新连接码')
  assert.equal(page.el('local-field').hidden, false)
})
