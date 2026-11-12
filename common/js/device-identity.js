import { storage } from './store.js'

export const deviceIdentity = {}
const KEY = 'qls_paired_devices'
const idPattern = /^qlsd-[a-f0-9]{32}$/
const secretPattern = /^[a-f0-9]{64}$/
deviceIdentity.random = size => Array.from(crypto.getRandomValues(new Uint8Array(size)), value => value.toString(16).padStart(2, '0')).join('')
deviceIdentity.validId = value => typeof value === 'string' && idPattern.test(value)
deviceIdentity.validSecret = value => typeof value === 'string' && secretPattern.test(value)
deviceIdentity.name = value => String(value || '').trim().slice(0, 40) || '未命名设备'
function read() {
  const state = storage.store.getCommitted(KEY)
  if (state && state.version === 1 && deviceIdentity.validId(state.id) && Array.isArray(state.peers)) return {
    ...state, name: deviceIdentity.name(state.name), peers: state.peers.filter(peer => deviceIdentity.validId(peer.id) && deviceIdentity.validSecret(peer.secret)).slice(0, 100),
  }
  return { version: 1, id: 'qlsd-' + deviceIdentity.random(16), name: /Android|iPhone|iPad/i.test(navigator.userAgent) ? '我的手机' : '我的电脑', peers: [] }
}
async function write(state) {
  if (!storage.store.set(KEY, state)) throw new Error('无法保存设备记录，请检查本机存储')
  await storage.store.flush()
  return state
}
deviceIdentity.load = async () => {
  await storage.store.flush()
  const state = read()
  if (storage.store.getCommitted(KEY)?.id !== state.id) await write(state)
  return state
}
deviceIdentity.rename = async name => write({ ...read(), name: deviceIdentity.name(name) })
deviceIdentity.remember = async peer => {
  if (!deviceIdentity.validId(peer.id) || !deviceIdentity.validSecret(peer.secret)) throw new Error('设备配对信息不正确')
  const state = read()
  if (peer.id === state.id) throw new Error('不能配对本机')
  return write({ ...state, peers: [...state.peers.filter(item => item.id !== peer.id), { id: peer.id, name: deviceIdentity.name(peer.name), secret: peer.secret }].slice(-100) })
}
deviceIdentity.forget = async id => { const state = read(); return write({ ...state, peers: state.peers.filter(peer => peer.id !== id) }) }
