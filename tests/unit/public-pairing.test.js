'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { createPage, waitFor } = require('../helpers/dom')

function network() {
  const peers = new Map(), connections = []
  class Connection extends EventEmitter {
    constructor(peer, metadata) { super(); this.peer = peer; this.metadata = metadata; this.open = true; connections.push(this) }
    send(value) { const copy = structuredClone(value); queueMicrotask(() => { if (this.other.open) this.other.emit('data', copy) }) }
    close() { if (!this.open) return; this.open = false; this.emit('close'); this.other?.close() }
  }
  class Peer extends EventEmitter {
    constructor(id) {
      super(); this.id = id; this.open = false; this.links = []
      queueMicrotask(() => {
        if (this.destroyed) return
        if (peers.has(id)) { this.emit('error', { type: 'unavailable-id' }); return }
        peers.set(id, this); this.open = true; this.emit('open', id)
      })
    }
    connect(id, options) {
      const a = new Connection(id, options.metadata), remote = peers.get(id)
      this.links.push(a)
      if (!remote) { queueMicrotask(() => this.emit('error', { type: 'peer-unavailable' })); return a }
      const b = new Connection(this.id, options.metadata); a.other = b; b.other = a; remote.links.push(b)
      queueMicrotask(() => { remote.emit('connection', b); a.emit('open'); b.emit('open') })
      return a
    }
    disconnect() { if (peers.get(this.id) === this) peers.delete(this.id); this.open = false; this.emit('disconnected') }
    destroy() { this.destroyed = true; this.disconnect(); this.links.forEach(link => link.close()) }
  }
  return { makePeer: id => new Peer(id), peers, connections }
}
function setup(net, number, extra = {}) {
  const page = createPage('index.html'), api = page.module('common/js/public-pairing.js').publicPairing
  const device = { id: 'qlsd-' + String(number).repeat(32), name: '设备' + number, peers: [] }
  const events = { ready: [], errors: [], requests: [], statuses: [], codes: [] }
  const manager = api.create({ device, makePeer: net.makePeer,
    onReady: link => events.ready.push(link), onRequest: remote => events.requests.push(remote),
    onError: error => events.errors.push(error.message), onStatus: text => events.statuses.push(text), onCode: code => events.codes.push(code),
    remember: async contact => { device.peers = [...device.peers.filter(item => item.id !== contact.id), contact] }, ...extra,
  })
  return { api, page, device, events, manager }
}
async function first(a, b) {
  await a.manager.start(); await b.manager.start(); await b.manager.advertise('123')
  a.manager.connect('123')
  await waitFor(() => a.events.requests.length && b.events.requests.length)
}

test('公共配对：只有双方确认且保存后才交接连接码，凭据留在本机并可双向重连', async () => {
  const net = network(), a = setup(net, 1), b = setup(net, 2)
  try {
    await first(a, b)
    a.manager.approve(); await new Promise(resolve => setImmediate(resolve))
    assert.equal(a.events.ready.length, 0); assert.equal(b.device.peers.length, 0)
    b.manager.approve(); await waitFor(() => a.events.ready.length && b.events.ready.length)
    assert.equal(a.device.peers[0].secret, b.device.peers[0].secret)
    assert.equal(a.device.peers[0].id, b.device.id)
    assert.equal(net.peers.has('qlsp-123'), false, '配对成功释放公开短码，但保留控制连接')
    a.events.ready[0].send('连接码'); b.events.ready[0].send('应答码')
    await waitFor(() => a.events.codes.length && b.events.codes.length)
    assert.equal(a.events.codes[0], '应答码'); assert.equal(b.events.codes[0], '连接码')
    a.manager.cancel(); b.manager.cancel()
    a.manager.dial(b.device.id, 'receive')
    await waitFor(() => a.events.ready.length === 2 && b.events.ready.length === 2)
    assert.equal(a.events.ready[1].role, 'receive'); assert.equal(b.events.ready[1].role, 'send')
    assert.equal(a.events.requests.length, 1, '记住设备后不再弹首次配对确认')
    assert.equal(a.events.errors.length + b.events.errors.length, 0)
  } finally { a.manager.close(); b.manager.close() }
})

test('公共配对：拒绝、保存失败、错误凭据、重复会话和意外消息不会交接业务连接', async () => {
  for (const failure of ['reject', 'save', 'proof', 'early', 'huge']) {
    const net = network(), a = setup(net, 1), b = setup(net, 2, failure === 'save' ? { remember: async () => { throw new Error('保存设备失败') } } : {})
    try {
      await first(a, b)
      if (failure === 'reject') { b.manager.cancel(); await waitFor(() => a.events.statuses.some(text => text.includes('取消'))); continue }
      if (failure === 'early' || failure === 'huge') {
        net.connections[0].send({ app: 'MAERS-QLS-PAIR-1', type: failure === 'early' ? 'code' : 'bad', code: 'x'.repeat(failure === 'huge' ? 70001 : 1) })
      } else {
        a.manager.approve(); b.manager.approve()
        if (failure === 'proof') {
          await waitFor(() => a.events.ready.length && b.events.ready.length)
          a.manager.cancel(); b.manager.cancel(); a.events.ready = []; b.events.ready = []
          a.device.peers[0].secret = 'f'.repeat(64)
          a.manager.dial(b.device.id)
        }
      }
      await waitFor(() => a.events.errors.length || b.events.errors.length)
      assert.equal(a.events.ready.length + b.events.ready.length, 0)
      assert.equal(a.events.codes.length + b.events.codes.length, 0)
    } finally { a.manager.close(); b.manager.close() }
  }
})

test('公共配对：重复编号、无效短码、未在线设备和取消服务连接都有明确结果', async () => {
  const net = network(), a = setup(net, 1), b = setup(net, 2), duplicate = setup(net, 1)
  try {
    assert.throws(() => a.manager.connect('123'), /尚未就绪/)
    await a.manager.start(); await b.manager.start()
    await assert.rejects(duplicate.manager.start(), /其他互传窗口/)
    await a.manager.advertise('123')
    await assert.rejects(b.manager.advertise('123'), /配对码已被占用/)
    for (const code of ['', '12345', 'ABCDEF']) assert.throws(() => b.manager.connect(code), /3 位/)
    b.manager.connect('999'); await waitFor(() => b.events.errors.length)
    assert.match(b.events.errors[0], /未在线/)
    assert.match(a.api.randomCode(), /^\d{3}$/)
    const pending = setup(net, 3, { makePeer: () => ({ on() {}, destroy() {} }) })
    const starting = pending.manager.start(); pending.manager.close(); await assert.rejects(starting, /取消/)
    const timeout = setup(net, 4, { makePeer: () => ({ on() {}, destroy() {} }), openTimeout: 20 })
    await assert.rejects(timeout.manager.start(), /超时/); timeout.manager.close()
  } finally { a.manager.close(); b.manager.close(); duplicate.manager.close() }
})
