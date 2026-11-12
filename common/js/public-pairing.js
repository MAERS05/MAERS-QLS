import { PeerClient } from './vendor/peerjs.js'
import { deviceIdentity as identity } from './device-identity.js'

export const publicPairing = {}
publicPairing.makePeer = id => new PeerClient(id, { host: '0.peerjs.com', port: 443, secure: true, config: { iceServers: [] }, debug: 0 })
const APP = 'MAERS-QLS-PAIR-1'
const codeId = code => 'qlsp-' + code
function checkCode(code) {
  if (!/^\d{3}$/.test(code)) throw new Error('请输入 3 位配对码')
  return code
}
publicPairing.randomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000).padStart(3, '0')
publicPairing.create = ({ device, onStatus, onRequest, onReady, onCode, onError, remember = identity.remember, makePeer = publicPairing.makePeer, openTimeout = 20000, sessionTimeout = 120000 }) => {
  let host = null, alias = null, session = null, closed = false
  const waiting = new Set()
  const fail = error => { if (!closed) onError(error instanceof Error ? error : new Error('配对失败')) }
  const message = (error, id) => new Error(error?.type === 'unavailable-id' ? id.startsWith('qlsp-') ? '配对码已被占用，请点击重新配对换一个' : '本机设备编号正在使用，请关闭其他互传窗口后重试' :
    error?.type === 'peer-unavailable' ? '对方未在线或配对码已失效，请让对方打开互传页' : '无法连接公共配对服务，请检查网络或切换连接码配对')
  function drop() {
    if (!session) return
    const previous = session; session = null; clearTimeout(previous.timer); previous.connection.close()
  }
  async function open(id) {
    if (closed) throw new Error('配对已关闭')
    const peer = makePeer(id)
    await new Promise((resolve, reject) => {
      let settled = false
      const finish = error => {
        if (settled) return
        settled = true; clearTimeout(timer); waiting.delete(cancel)
        if (error) { peer.destroy(); reject(error) } else resolve()
      }
      const cancel = () => finish(new Error('配对已取消'))
      const timer = setTimeout(() => finish(new Error('公共配对服务连接超时，请重试或使用连接码配对')), openTimeout)
      waiting.add(cancel)
      peer.on('open', () => finish())
      peer.on('error', error => { if (!settled) finish(message(error, id)); else { drop(); fail(message(error, id)) } })
      peer.on('disconnected', () => { if (!closed && peer === host) onStatus('公共配对服务已断开，可重新配对或使用连接码方式') })
    })
    if (closed) { peer.destroy(); throw new Error('配对已关闭') }
    return peer
  }
  function bind(connection, { incoming, kind, role, contact, nonce }) {
    if (session || closed || !['pair', 'known'].includes(kind)) { connection.close(); return }
    const state = { connection, incoming, kind, role, contact, nonce, remote: null, approved: false, accepted: false, pairing: false, ready: false }
    session = state
    state.timer = setTimeout(() => { if (session === state) { drop(); fail(new Error('设备连接或确认超时，请重新配对')) } }, sessionTimeout)
    const send = value => { if (session !== state || !connection.open) throw new Error('配对连接已断开'); connection.send({ app: APP, ...value }) }
    const current = () => !closed && session === state
    const finish = () => {
      if (!current() || state.ready) return
      state.ready = true; clearTimeout(state.timer); alias?.disconnect()
      onReady({ role: state.role, device: state.remote, send: code => send({ type: 'code', code }) })
    }
    const hello = () => send({ type: 'hello', id: device.id, name: device.name, role: state.role, nonce: state.nonce, proof: contact?.secret })
    async function pair() {
      if (!state.approved || !state.accepted || !state.incoming || state.pairing) return
      state.pairing = true
      const secret = identity.random(32)
      await remember({ ...state.remote, secret })
      if (current()) send({ type: 'paired', secret })
    }
    connection.on('open', () => { if (!incoming && current()) hello() })
    connection.on('close', () => { if (current()) { drop(); onStatus(state.ready ? '设备连接已关闭' : '对方已取消或关闭配对', true) } })
    connection.on('error', () => { if (current()) { drop(); fail(new Error('设备连接失败，请重新配对')) } })
    connection.on('data', value => {
      void (async () => {
        if (!current()) return
        if (!value || value.app !== APP || JSON.stringify(value).length > 70000) throw new Error('收到无效的配对信息')
        if (value.type === 'hello') {
          if (state.remote || !identity.validId(value.id) || value.id === device.id || typeof value.name !== 'string' || value.name.length > 40 ||
              value.nonce !== state.nonce || value.role !== (state.role === 'send' ? 'receive' : 'send')) throw new Error('设备身份或传输方向不匹配')
          if (incoming && value.id !== connection.peer) throw new Error('设备编号不匹配')
          if (kind === 'known' && (!contact || value.id !== contact.id || value.proof !== contact.secret)) throw new Error('设备配对凭据不匹配，请删除记录后重新添加设备')
          state.remote = { id: value.id, name: identity.name(value.name) }
          if (incoming) hello()
          if (kind === 'known') { finish(); return }
          onRequest({ ...state.remote, role: state.role })
          return
        }
        if (!state.remote) throw new Error('设备尚未握手')
        if (value.type === 'accept' && kind === 'pair' && !state.accepted) { state.accepted = true; await pair(); return }
        if (value.type === 'paired' && kind === 'pair' && !incoming && state.approved && state.accepted && !state.pairing && identity.validSecret(value.secret)) {
          state.pairing = true; await remember({ ...state.remote, secret: value.secret })
          if (current()) { send({ type: 'paired-ack' }); finish() }
          return
        }
        if (value.type === 'paired-ack' && kind === 'pair' && incoming && state.pairing && !state.ready) { finish(); return }
        if (value.type === 'code' && state.ready && typeof value.code === 'string' && value.code.length <= 65536) { onCode(value.code, state.role); return }
        throw new Error('收到意外的配对消息')
      })().catch(error => { if (current()) { drop(); fail(error) } })
    })
    state.approve = () => { if (!state.remote || state.approved) return; state.approved = true; send({ type: 'accept' }); void pair().catch(error => { if (current()) { drop(); fail(error) } }) }
  }
  const incoming = connection => {
    const meta = connection.metadata
    if (!meta || meta.app !== APP || !['send', 'receive'].includes(meta.role) || !/^[a-f0-9]{32}$/.test(meta.nonce)) { connection.close(); return }
    const contact = device.peers.find(item => item.id === connection.peer)
    if (meta.kind === 'known' && !contact) { connection.close(); return }
    bind(connection, { incoming: true, kind: meta.kind, role: meta.role === 'send' ? 'receive' : 'send', contact, nonce: meta.nonce })
  }
  const api = {
    async start() { host = await open(device.id); host.on('connection', incoming); onStatus('已连接公共配对服务') },
    async advertise(code) {
      checkCode(code)
      if (!host?.open || closed) throw new Error('公共配对服务尚未就绪')
      drop(); alias?.destroy(); alias = null
      alias = await open(codeId(code)); alias.on('connection', connection => {
        if (connection.metadata?.kind !== 'pair') { connection.close(); return }
        incoming(connection)
      })
    },
    connect(code, role = 'send') { api.dial(codeId(checkCode(code)), role) },
    dial(id, role = 'send') {
      if (!host?.open || closed) throw new Error('公共配对服务尚未就绪')
      if (session) throw new Error('请先完成或取消当前连接')
      const contact = device.peers.find(item => item.id === id), kind = contact ? 'known' : 'pair', nonce = identity.random(16)
      const connection = host.connect(id, { serialization: 'json', reliable: true, metadata: { app: APP, kind, role, nonce } })
      bind(connection, { incoming: false, kind, role, contact, nonce })
    },
    approve() { session?.approve() },
    cancel() { drop() },
    close() { closed = true; [...waiting].forEach(cancel => cancel()); drop(); alias?.destroy(); host?.destroy(); alias = host = null },
  }
  return api
}
