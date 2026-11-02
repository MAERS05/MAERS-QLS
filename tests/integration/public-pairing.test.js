'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, createIdbFactory, click, type, waitFor } = require('../helpers/dom')

async function setup() {
  const page = createPage('index.html', { indexedDB: createIdbFactory(), beforeScripts(win) { win.RTCPeerConnection = function () { this.close = () => {} } } })
  await page.ready()
  const api = page.module('common/js/public-pairing.js').publicPairing
  const identity = page.module('common/js/device-identity.js').deviceIdentity
  page.contact = { id: 'qlsd-' + 'a'.repeat(32), name: '已有手机', secret: 'b'.repeat(64) }
  await identity.remember(page.contact)
  page.el = suffix => page.document.querySelector('#transfer-public-' + suffix)
  page.events = null; page.signals = []; page.closed = 0
  page.fake = {
    start: async () => page.events.onStatus('已连接公共配对服务'), advertise: async code => { page.code = code },
    connect: (code, role) => { page.connect = { code, role } }, dial: (id, role) => { page.dial = { id, role } },
    approve: () => { page.approved = true }, cancel: () => { page.cancelled = true }, close: () => { page.closed++ },
  }
  api.create = options => { page.events = options; return page.fake }
  api.randomCode = () => '123'
  page.protocol = { offer: async () => '本机长码', answer: async () => '本机应答', connect: async () => page.callbacks.onState('connected'), close() {} }
  page.module('common/js/peer-transfer.js').peerTransfer.create = callbacks => { page.callbacks = callbacks; return page.protocol }
  click(page.document.querySelector('#qls-transfer-btn'))
  await waitFor(() => page.document.querySelector('#transfer-status').textContent.includes('已连接公共'))
  return page
}

test('公共配对界面：名称保存、短码、首次确认，已有设备连接和忘记设备', async () => {
  const p = await setup(), status = () => p.document.querySelector('#transfer-status').textContent
  assert.equal(p.document.querySelector('#transfer-code-panel').hidden, true)
  assert.equal(p.el('devices').querySelector('button').textContent, '已有手机')
  type(p.el('name'), '新电脑'); click(p.el('rename')); await waitFor(() => status().includes('名称已保存'))
  assert.equal(p.QLS.store.getCommitted('qls_paired_devices').name, '新电脑')
  click(p.document.querySelector('[data-transfer-role="receive"]')); await waitFor(() => p.el('local-code').textContent === '123')
  assert.equal(p.el('local-code').textContent, '123')
  click(p.document.querySelector('[data-transfer-role="send"]')); await waitFor(() => status().includes('已连接公共'))
  type(p.el('remote-code'), '654'); click(p.el('connect'))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(p.connect.code, '654'); assert.equal(p.connect.role, 'send')
  p.events.onRequest({ id: p.contact.id, name: '<手机>' })
  assert.equal(p.el('request').hidden, false); assert.match(p.el('request-name').textContent, /<手机>/)
  assert.equal(p.el('request-name').querySelector('手机'), null)
  p.events.onStatus('对方已取消或关闭配对', true)
  assert.equal(p.el('request').hidden, true)
  p.events.onRequest({ id: p.contact.id, name: '<手机>' })
  click(p.el('approve')); assert.equal(p.approved, true)
  click(p.el('cancel')); assert.equal(p.cancelled, true); assert.equal(p.el('request').hidden, true)
  await new Promise(resolve => setImmediate(resolve))
  click(p.el('devices').querySelector('button')); assert.equal(p.dial.id, p.contact.id)
  await new Promise(resolve => setImmediate(resolve))
  click(p.el('devices').querySelectorAll('button')[1]); await waitFor(() => !p.el('empty').hidden)
  assert.equal(p.QLS.store.getCommitted('qls_paired_devices').peers.length, 0)
})

test('公共配对界面：配对完成自动交接原连接码协议，接收方向自动适配', async () => {
  const p = await setup()
  await p.events.remember({ id: 'qlsd-' + 'c'.repeat(32), name: '新手机', secret: 'd'.repeat(64) })
  assert.match(p.el('devices').textContent, /新手机/)
  p.events.onReady({ role: 'send', send: code => p.signals.push(code) })
  await waitFor(() => p.signals.length)
  assert.equal(p.signals[0], '本机长码')
  p.events.onCode('对方应答', 'send')
  await waitFor(() => !p.document.querySelector('#transfer-send').hidden)
  assert.equal(p.document.querySelector('#transfer-pairing').hidden, true)
  click(p.document.querySelector('#transfer-restart'))
  await waitFor(() => p.document.querySelector('#transfer-status').textContent.includes('已连接公共'))
  p.events.onReady({ role: 'receive', send: code => p.signals.push(code) })
  p.events.onCode('对方长码', 'receive')
  await waitFor(() => p.signals.length === 2)
  assert.equal(p.signals[1], '本机应答')
  assert.equal(p.document.querySelector('[data-transfer-role="receive"]').getAttribute('aria-pressed'), 'true')
})

test('公共配对界面：服务失败可重试或切回基础方式，迟到回调和名称保存失败保留当前输入', async () => {
  const p = await setup(), status = () => p.document.querySelector('#transfer-status').textContent
  p.events.onError(new Error('服务不可用')); assert.match(status(), /服务不可用/)
  const previous = p.events
  click(p.document.querySelector('[data-transfer-mode="code"]'))
  previous.onStatus('迟到状态'); previous.onError(new Error('迟到错误')); previous.onRequest({ name: '迟到设备' })
  assert.match(status(), /正在生成连接码/); assert.equal(p.el('request').hidden, true)
  click(p.document.querySelector('[data-transfer-mode="public"]'))
  await waitFor(() => status().includes('已连接公共'))
  p.pageIdentity = p.module('common/js/device-identity.js').deviceIdentity
  p.pageIdentity.rename = async () => { throw new Error('空间不足') }
  type(p.el('name'), '不要丢掉'); click(p.el('rename')); await waitFor(() => status().includes('空间不足'))
  assert.equal(p.el('name').value, '不要丢掉')
  click(p.el('retry')); await waitFor(() => status().includes('已连接公共'))
  assert.ok(p.closed > 0)
})
