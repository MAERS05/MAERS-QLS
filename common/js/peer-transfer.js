import { metadata } from './core.js'
import { transferFormat as format } from './transfer-format.js'

export const peerTransfer = {}
const PREFIX = 'QLS1.'
function encode(description, sessionId) {
  return PREFIX + btoa(JSON.stringify({ app: metadata.BACKUP_APP, version: 1, sessionId, type: description.type, sdp: description.sdp }))
}
function decode(code, type) {
  const clean = typeof code === 'string' ? code.replace(/\s/g, '') : ''
  if (!clean.startsWith(PREFIX) || clean.length > 65536) throw new Error('连接码格式不正确')
  let value
  try { value = JSON.parse(atob(clean.slice(PREFIX.length))) } catch { throw new Error('连接码不完整，请重新复制') }
  if (!value || value.app !== metadata.BACKUP_APP || value.version !== 1 || value.type !== type || typeof value.sdp !== 'string' ||
      value.sdp.length > 40000 || typeof value.sessionId !== 'string' || !/^peer_[\w-]{8,100}$/.test(value.sessionId)) throw new Error('连接码类型或版本不正确')
  return value
}
peerTransfer.decode = decode
peerTransfer.create = ({ role, onState, onPayload, onApplied, onProgress, onError, createPeer = config => new RTCPeerConnection(config) }) => {
  if (!['send', 'receive'].includes(role)) throw new Error('请选择发送或接收')
  const pc = createPeer({ iceServers: [] })
  let sessionId = role === 'send' ? metadata.uid('peer_') : ''
  let channel, ready = false, closed = false, offered = false, sentId = '', incoming = null, payloadReceived = false
  let connectionTimer = null
  const fail = error => { if (!closed) onError(error instanceof Error ? error : new Error('连接失败，请重新配对')) }
  const sendControl = value => {
    if (channel?.readyState !== 'open') throw new Error('设备连接已断开')
    channel.send(JSON.stringify(value))
  }
  const startConnectionTimer = () => {
    clearTimeout(connectionTimer)
    if (ready || closed) return
    connectionTimer = setTimeout(() => { if (!ready && !closed) fail(new Error('连接超时，请检查两端网络是否允许设备互访后重新配对')) }, 90000)
  }
  function bindChannel(next) {
    if (channel || next.label !== 'qls-transfer-v1') { next.close(); return }
    channel = next
    channel.binaryType = 'arraybuffer'
    channel.bufferedAmountLowThreshold = 65536
    channel.onopen = () => sendControl({ type: 'hello', sessionId, role, version: 1 })
    channel.onclose = () => { ready = false; clearTimeout(connectionTimer); if (!closed) onState('disconnected') }
    channel.onerror = () => fail(new Error('设备连接异常，请重新配对'))
    channel.onmessage = event => {
      try {
        if (typeof event.data !== 'string') {
          if (!ready || role !== 'receive' || !incoming || payloadReceived) throw new Error('收到意外的数据片段')
          const bytes = new Uint8Array(event.data)
          if (!bytes.length || bytes.length > 16384 || incoming.offset + bytes.length > incoming.size) throw new Error('传输数据长度不正确')
          incoming.bytes.set(bytes, incoming.offset); incoming.offset += bytes.length
          onProgress(incoming.offset, incoming.size)
          return
        }
        if (event.data.length > 2048) throw new Error('传输消息过大')
        const message = JSON.parse(event.data)
        if (message.type === 'hello') {
          if (ready || message.version !== 1 || message.sessionId !== sessionId || message.role === role || !['send', 'receive'].includes(message.role)) throw new Error('配对信息不匹配')
          ready = true; clearTimeout(connectionTimer); onState('connected'); return
        }
        if (!ready) throw new Error('设备尚未完成配对')
        if (message.type === 'begin' && role === 'receive' && !incoming && !payloadReceived) {
          if (!Number.isSafeInteger(message.size) || message.size <= 0 || message.size > metadata.MAX_IMPORT_BYTES ||
              typeof message.checksum !== 'string' || typeof message.id !== 'string') throw new Error('传输数据超过限制或格式不正确')
          incoming = { ...message, bytes: new Uint8Array(message.size), offset: 0 }
          onState('receiving'); return
        }
        if (message.type === 'end' && incoming && message.id === incoming.id && !payloadReceived) {
          if (incoming.offset !== incoming.size || format.checksum(incoming.bytes) !== incoming.checksum) throw new Error('数据不完整，请重新发送')
          payloadReceived = true
          const text = new TextDecoder('utf-8', { fatal: true }).decode(incoming.bytes)
          incoming.bytes = null
          if (JSON.parse(text)?.id !== incoming.id) throw new Error('传输编号不一致，请重新发送')
          onPayload(text)
          return
        }
        if (message.type === 'applied' && role === 'send' && sentId && message.receipt?.id === sentId) { onApplied(message.receipt); return }
        if (message.type === 'rejected' && role === 'send') { onState('rejected'); return }
        throw new Error('收到无法识别的传输消息')
      } catch (error) { fail(error); peer.close() }
    }
  }
  pc.ondatachannel = event => bindChannel(event.channel)
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') fail(new Error('无法直连，请确认两端在同一局域网且没有访客隔离'))
  }
  async function gather() {
    if (pc.iceGatheringState === 'complete') return
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', change); pc.removeEventListener('connectionstatechange', change)
        if (error) reject(error); else resolve()
      }
      const change = () => {
        if (closed || pc.connectionState === 'closed') finish(new Error('配对已取消'))
        else if (pc.iceGatheringState === 'complete') finish()
      }
      const timer = setTimeout(() => finish(new Error('生成连接码超时，请重新配对')), 15000)
      pc.addEventListener('icegatheringstatechange', change)
      pc.addEventListener('connectionstatechange', change)
      change()
    })
  }
  async function drain() {
    if (channel.bufferedAmount <= 262144) return
    await new Promise((resolve, reject) => {
      const done = error => {
        clearTimeout(timer); channel.removeEventListener('bufferedamountlow', low); channel.removeEventListener('close', disconnect)
        if (error) reject(error); else resolve()
      }
      const low = () => done()
      const disconnect = () => done(new Error('传输中断，请在接收端查看结果'))
      const timer = setTimeout(() => done(new Error('传输超时，请重新配对')), 30000)
      channel.addEventListener('bufferedamountlow', low); channel.addEventListener('close', disconnect)
    })
  }
  const peer = {
    async offer() {
      if (role !== 'send' || offered || closed) throw new Error('请重新开始配对')
      offered = true
      bindChannel(pc.createDataChannel('qls-transfer-v1', { ordered: true }))
      await pc.setLocalDescription(await pc.createOffer()); await gather()
      return encode(pc.localDescription, sessionId)
    },
    async answer(code) {
      if (role !== 'receive' || offered || closed) throw new Error('请重新开始配对')
      const description = decode(code, 'offer'); sessionId = description.sessionId; offered = true
      await pc.setRemoteDescription({ type: description.type, sdp: description.sdp })
      await pc.setLocalDescription(await pc.createAnswer()); await gather(); startConnectionTimer()
      return encode(pc.localDescription, sessionId)
    },
    async connect(code) {
      const description = decode(code, 'answer')
      if (role !== 'send' || !offered || closed || description.sessionId !== sessionId) throw new Error('应答码与本次连接不匹配')
      await pc.setRemoteDescription({ type: description.type, sdp: description.sdp }); startConnectionTimer()
    },
    async send(outgoing) {
      if (!ready || role !== 'send' || sentId) throw new Error('当前连接不能发送，请重新配对')
      const bytes = format.bytes(outgoing.text)
      if (!bytes.length || bytes.length > metadata.MAX_IMPORT_BYTES) throw new Error('数据超过 10 MiB 上限')
      sentId = outgoing.envelope.id
      sendControl({ type: 'begin', id: sentId, size: bytes.length, checksum: format.checksum(bytes) })
      const maximum = pc.sctp?.maxMessageSize || 16384
      const chunkSize = Math.min(16384, maximum)
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        await drain()
        if (!ready) throw new Error('设备连接已断开')
        channel.send(bytes.subarray(offset, offset + chunkSize))
        onProgress(Math.min(offset + chunkSize, bytes.length), bytes.length)
      }
      sendControl({ type: 'end', id: sentId })
    },
    applied(receipt) { sendControl({ type: 'applied', receipt }) },
    reject() { sendControl({ type: 'rejected' }) },
    close() { if (closed) return; closed = true; ready = false; incoming = null; clearTimeout(connectionTimer); channel?.close(); pc.close() },
  }
  return peer
}
