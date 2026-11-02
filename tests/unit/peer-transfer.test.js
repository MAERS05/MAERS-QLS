'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, waitFor } = require('../helpers/dom')

class Channel extends EventTarget {
  constructor() { super(); this.label = 'qls-transfer-v1'; this.readyState = 'connecting'; this.bufferedAmount = 0 }
  send(value) {
    if (this.readyState !== 'open') throw new Error('closed')
    const copy = typeof value === 'string' ? value : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    const size = typeof copy === 'string' ? copy.length : copy.byteLength
    this.bufferedAmount += size
    queueMicrotask(() => {
      this.bufferedAmount -= size
      if (this.other.readyState === 'open') this.other.onmessage?.({ data: copy })
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold) this.dispatchEvent(new Event('bufferedamountlow'))
    })
  }
  close() {
    if (this.readyState === 'closed') return
    this.readyState = 'closed'; this.onclose?.(); this.dispatchEvent(new Event('close'))
    this.other?.close()
  }
}
function transport({ gathering = false } = {}) {
  const pcs = []
  class Peer extends EventTarget {
    constructor(config) {
      super(); assert.equal(config.iceServers.length, 0)
      this.iceGatheringState = gathering ? 'gathering' : 'complete'
      this.connectionState = 'new'; this.sctp = { maxMessageSize: 2048 }; pcs.push(this)
    }
    createDataChannel() { this.channel = new Channel(); return this.channel }
    async createOffer() { return { type: 'offer', sdp: 'offer' } }
    async createAnswer() { return { type: 'answer', sdp: 'answer' } }
    async setLocalDescription(description) { this.localDescription = description }
    async setRemoteDescription(description) {
      if (description.type !== 'answer') return
      const sender = pcs[0], receiver = pcs[1]
      receiver.channel = new Channel()
      sender.channel.other = receiver.channel; receiver.channel.other = sender.channel
      receiver.ondatachannel({ channel: receiver.channel })
      sender.channel.readyState = receiver.channel.readyState = 'open'
      sender.channel.onopen(); receiver.channel.onopen()
    }
    close() { this.connectionState = 'closed'; this.channel?.close(); this.dispatchEvent(new Event('connectionstatechange')) }
  }
  return { pcs, factory: config => new Peer(config) }
}
async function pair() {
  const page = createPage('index.html'), api = page.module('common/js/peer-transfer.js').peerTransfer
  const network = transport(), events = { errors: [], states: [], progress: [], received: null, receipt: null }
  const callbacks = { onError: error => events.errors.push(error), onState: state => events.states.push(state),
    onPayload: text => { events.received = text }, onApplied: receipt => { events.receipt = receipt },
    onProgress: (done, total) => events.progress.push([done, total]), createPeer: network.factory }
  const sender = api.create({ ...callbacks, role: 'send' }), receiver = api.create({ ...callbacks, role: 'receive' })
  const offer = await sender.offer(), answer = await receiver.answer(offer)
  await sender.connect(answer)
  await waitFor(() => events.states.filter(state => state === 'connected').length === 2)
  return { page, api, sender, receiver, events, network, offer, answer }
}

test('直连协议：两端连接码绑定同一会话，分片重组中文，只有保存回执才算完成', async () => {
  const p = await pair()
  try {
    const id = 'transfer_test12345', text = JSON.stringify({ id, text: '中文🙂'.repeat(10000) })
    // 模拟发送缓冲区拥堵，直到 bufferedamountlow 才继续，避免一次塞入整库。
    p.network.pcs[0].channel.bufferedAmount = 300000
    const sending = p.sender.send({ envelope: { id }, text })
    setImmediate(() => {
      const channel = p.network.pcs[0].channel
      channel.bufferedAmount = 0; channel.dispatchEvent(new Event('bufferedamountlow'))
    })
    await sending
    await waitFor(() => p.events.received !== null)
    assert.equal(p.events.received, text)
    assert.equal(p.events.receipt, null)
    assert.ok(p.events.progress.length > 10)
    p.receiver.applied({ id, savedAt: 'now' })
    await waitFor(() => p.events.receipt !== null)
    assert.equal(p.events.receipt.id, id)
    assert.equal(p.events.errors.length, 0)
    await assert.rejects(p.sender.send({ envelope: { id }, text }), /重新配对/)
    p.receiver.reject()
    await waitFor(() => p.events.states.includes('rejected'))
  } finally { p.sender.close(); p.receiver.close() }
})

test('直连协议：无效类型、损坏和跨会话连接码均拒绝', async () => {
  const p = await pair()
  try {
    for (const code of ['bad', 'QLS1.%%%%', 'QLS1.' + 'a'.repeat(65536), 'QLS1.' + btoa('null')]) assert.throws(() => p.api.decode(code, 'offer'))
    assert.throws(() => p.api.decode(p.answer, 'offer'), /类型/)
    const wrong = JSON.parse(atob(p.answer.slice(5))); wrong.sessionId = 'peer_other12345'
    await assert.rejects(p.sender.connect('QLS1.' + btoa(JSON.stringify(wrong))), /不匹配/)
    assert.throws(() => p.api.create({ role: 'other' }), /选择/)
  } finally { p.sender.close(); p.receiver.close() }
})

test('直连协议：缺片、越界和意外消息不会交付业务数据', async () => {
  for (const bad of ['oversize', 'incomplete', 'unexpected']) {
    const p = await pair()
    try {
      const channel = p.network.pcs[1].channel
      const inject = message => channel.onmessage({ data: typeof message === 'string' ? message : JSON.stringify(message) })
      if (bad === 'oversize') inject({ type: 'begin', id: 'x', size: 10 * 1024 * 1024 + 1, checksum: 'bad' })
      if (bad === 'incomplete') {
        inject({ type: 'begin', id: 'x', size: 5, checksum: 'bad' })
        inject({ type: 'end', id: 'x' })
      }
      if (bad === 'unexpected') inject({ type: 'unknown' })
      assert.equal(p.events.received, null)
      assert.equal(p.events.errors.length, 1)
    } finally { p.sender.close(); p.receiver.close() }
  }
})

test('直连协议：生成连接码期间取消和传输期间断开都会结束等待', async () => {
  const page = createPage('index.html'), api = page.module('common/js/peer-transfer.js').peerTransfer
  const network = transport({ gathering: true })
  const sender = api.create({ role: 'send', createPeer: network.factory, onState() {}, onError() {} })
  const offer = sender.offer()
  await new Promise(resolve => setImmediate(resolve))
  sender.close()
  await assert.rejects(offer, /取消/)
  const p = await pair()
  try {
    p.network.pcs[0].channel.bufferedAmount = 300000
    const sending = p.sender.send({ envelope: { id: 'transfer_cut12345' }, text: JSON.stringify({ id: 'transfer_cut12345' }) })
    setImmediate(() => p.receiver.close())
    await assert.rejects(sending, /中断/)
    assert.equal(p.events.received, null)
  } finally { p.sender.close(); p.receiver.close() }
})
