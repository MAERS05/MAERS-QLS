'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, createIdbFactory } = require('../helpers/dom')

test('设备记录：本机身份持久化、命名与删除，业务整体覆盖不导出或替换设备凭据', async () => {
  const factory = createIdbFactory(), page = createPage('index.html', { indexedDB: factory }), other = createPage('index.html', { indexedDB: createIdbFactory() })
  await page.ready(); await other.ready()
  const api = page.module('common/js/device-identity.js').deviceIdentity, peer = other.module('common/js/device-identity.js').deviceIdentity
  const local = await api.load(), remote = await peer.load()
  assert.equal(page.window.Peer, undefined, '客户端不暴露全局 Peer')
  assert.notEqual(local.id, remote.id)
  await api.rename('  测试手机  '); assert.equal((await api.load()).name, '测试手机')
  const secret = api.random(32)
  await api.remember({ id: remote.id, name: '电脑', secret })
  assert.equal((await api.load()).peers.length, 1)
  await assert.rejects(api.remember({ id: 'invalid', secret }), /不正确/)
  await assert.rejects(api.remember({ id: local.id, secret }), /本机/)
  other.MS.saveTaskOrGoal({ title: '业务' }); await other.QLS.store.flush()
  const data = other.module('common/js/device-transfer.js').deviceTransfer, receiving = page.module('common/js/device-transfer.js').deviceTransfer
  const snapshot = await data.outgoing()
  assert.equal(Object.hasOwn(snapshot.envelope.data, 'qls_paired_devices'), false)
  await receiving.accept(receiving.prepare(snapshot.text), await receiving.local())
  assert.equal((await api.load()).id, local.id)
  assert.equal((await api.load()).peers[0].secret, secret)
  await api.forget(remote.id); assert.equal((await api.load()).peers.length, 0)
  const reload = createPage('index.html', { indexedDB: factory }); await reload.ready()
  assert.equal((await reload.module('common/js/device-identity.js').deviceIdentity.load()).id, local.id)
})
