import { publicPairing } from './public-pairing.js'
import { deviceIdentity } from './device-identity.js'
import { dom } from './dom.js'

export const publicPairingView = {}
publicPairingView.create = ({ getRole, onSession, onCode, onStatus, onError }) => {
  const el = id => dom.$('#transfer-public-' + id)
  let manager = null, device = null, generation = 0, ready = false, working = false
  function render() {
    el('devices').replaceChildren()
    el('empty').hidden = Boolean(device?.peers.length)
    for (const contact of device?.peers || []) {
      const row = document.createElement('div'), connect = document.createElement('button'), forget = document.createElement('button')
      row.className = 'transfer-actions'
      connect.type = forget.type = 'button'; connect.className = 'transfer-button'; forget.className = 'transfer-copy'
      connect.textContent = contact.name; forget.textContent = '删除'; forget.setAttribute('aria-label', '删除设备 ' + contact.name)
      connect.addEventListener('click', () => { void run(() => { manager.dial(contact.id, getRole()); onStatus('正在连接 ' + contact.name + '…') }) })
      forget.addEventListener('click', () => { void run(async () => {
        if (!confirm('删除与“' + contact.name + '”的配对记录？下次需要重新添加设备。')) return
        const current = generation, next = await deviceIdentity.forget(contact.id)
        if (current === generation) { device.peers = next.peers; render() }
      }) })
      row.append(connect, forget); el('devices').append(row)
    }
  }
  function stop() { generation++; ready = false; working = false; manager?.close(); manager = null; el('approve').disabled = false; el('request').hidden = true; el('local').hidden = true }
  async function start() {
    stop(); const current = generation
    let sessionReady = false
    const receiving = getRole() === 'receive'
    el('local').hidden = !receiving; el('remote-field').hidden = receiving; el('remote-code').value = ''
    el('local-code').textContent = receiving ? '正在生成…' : ''
    try {
      device = await deviceIdentity.load()
      if (current !== generation) return
      el('name').value = device.name; render()
      manager = publicPairing.create({ device,
        onStatus(message, ended = false) {
          if (current !== generation) return
          if (ended) { el('request').hidden = true; el('approve').disabled = false }
          onStatus(message)
        },
        onError(error) { if (current === generation) { el('request').hidden = true; onError(error) } },
        onRequest(remote) {
          if (current !== generation) return
          el('request-name').textContent = '确认配对设备：“' + remote.name + '”？请在两边核对名称并确认。'
          el('approve').disabled = false; el('request').hidden = false; onStatus('等待双方确认设备配对。')
        },
        async remember(contact) {
          if (current !== generation) throw new Error('配对已取消')
          const next = await deviceIdentity.remember(contact)
          if (current === generation) { device.peers = next.peers; render() }
        },
        onReady(link) { if (current === generation) { sessionReady = true; el('request').hidden = true; el('local').hidden = true; el('remote-field').hidden = true; onSession(link) } },
        onCode(code, role) { if (current === generation) onCode(code, role) },
      })
      onStatus('正在连接公共配对服务…')
      await manager.start()
      if (current !== generation) return
      ready = true
      if (receiving && !sessionReady) {
        const code = publicPairing.randomCode()
        await manager.advertise(code)
        if (current !== generation || sessionReady) return
        el('local-code').textContent = code
        onStatus('请在发送端输入此配对码；首次配对需要双方确认名称。')
      }
    } catch (error) { if (current === generation) { el('local').hidden = true; onError(error) } }
  }
  async function run(work) {
    if (working) return
    if (!ready) { onError(new Error('公共配对服务尚未就绪，请重试或切换连接码配对')); return }
    working = true; const current = generation
    try { await work() } catch (error) { if (current === generation) onError(error) }
    finally { if (current === generation) working = false }
  }
  el('rename').addEventListener('click', () => { void run(async () => {
    const current = generation, next = await deviceIdentity.rename(el('name').value)
    if (current === generation) { device.name = next.name; el('name').value = next.name; onStatus('本机名称已保存。') }
  }) })
  el('connect').addEventListener('click', () => { void run(() => { manager.connect(el('remote-code').value.trim(), getRole()); onStatus('正在连接对方设备…') }) })
  el('approve').addEventListener('click', () => { void run(() => { manager.approve(); el('approve').disabled = true; onStatus('本机已确认，等待对方确认。') }) })
  el('cancel').addEventListener('click', () => { manager?.cancel(); el('request').hidden = true; onStatus('已取消配对，本机业务数据未更改。') })
  el('retry').addEventListener('click', () => { el('approve').disabled = false; void start() })
  return { start, stop }
}
