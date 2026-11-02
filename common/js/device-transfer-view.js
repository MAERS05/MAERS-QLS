import { deviceTransfer as data } from './device-transfer.js'
import { peerTransfer } from './peer-transfer.js'
import { storage } from './store.js'
import { storageState } from './idb-store.js'
import { dom } from './dom.js'
import { ui } from './ui.js'
import { publicPairingView } from './public-pairing-view.js'

const dialog = dom.$('#device-transfer-dialog')
const el = id => dom.$('#transfer-' + id)
let peer = null, role = 'send', generation = 0, busy = false, saving = false, connected = false
let prepared = null, local = null
let outcome = ''
let mode = 'public', publicSend = null
const publicView = publicPairingView.create({ getRole: () => role,
  onStatus(message) { if (!connected && !outcome) status(message) },
  onError(error) { if (!connected) { peer?.close(); peer = null; status(error.message, true) } },
  onSession(link) {
    if (busy || prepared || peer) { status('请先完成本次传输或重新配对。', true); return }
    role = link.role; publicSend = link.send
    dialog.querySelectorAll('[data-transfer-role]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.transferRole === role)))
    if (role === 'send') void run(async current => { const code = await createPeer().offer(); if (current === generation) publicSend(code) })
    else { createPeer(); status('设备已配对，等待建立直连…') }
  },
  onCode(code, nextRole) { void run(async current => {
    if (nextRole === 'send') await createPeer().connect(code)
    else { const answer = await createPeer().answer(code); if (current === generation) publicSend(answer) }
  }) },
})

function status(message, error = false) {
  el('status').textContent = message
  el('status').classList.toggle('error', error)
}
function controls() {
  dialog.querySelectorAll('button, textarea, input').forEach(control => { control.disabled = busy })
  el('close').disabled = saving
}
async function run(work) {
  if (busy) return
  busy = true; controls()
  const current = generation
  try { await work(current) } catch (error) { if (current === generation) status(error.message, true) }
  finally { if (current === generation) { busy = false; saving = false; controls() } }
}
function reset(nextRole = role) {
  publicView.stop(); publicSend = null
  peer?.close(); peer = null; generation++; role = nextRole; busy = false; saving = false; connected = false; prepared = null; local = null; outcome = ''
  dialog.querySelectorAll('[data-transfer-role]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.transferRole === role)))
  el('pairing').hidden = false
  el('local-field').hidden = true
  el('remote-field').hidden = role === 'send'
  el('remote-label').textContent = role === 'send' ? '粘贴对方的应答码' : '粘贴发送端的连接码'
  el('connect').textContent = role === 'send' ? '连接' : '生成应答码'
  el('local-code').value = ''; el('remote-code').value = ''
  el('instruction').textContent = role === 'send'
    ? '① 将自动生成的连接码交给接收端；② 将对方回传的应答码粘贴到这里，点击连接。'
    : '① 粘贴发送端的连接码，生成应答码；② 将应答码交回发送端，等待连接。'
  el('send').hidden = true; el('preview').hidden = true; el('progress').hidden = true
  controls(); status('请选择发送端和接收端，开始交换连接码。')
  dialog.querySelectorAll('[data-transfer-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.transferMode === mode)))
  el('public-panel').hidden = mode !== 'public'; el('code-panel').hidden = mode !== 'code'; el('public-retry').hidden = mode !== 'public'
  if (mode === 'public') void publicView.start()
  else if (role === 'send') generateCode()
}
function generateCode() {
  void run(async current => {
    status('正在生成连接码…')
    const code = await createPeer().offer()
    if (current !== generation) return
    el('local-code').value = code; el('local-label').textContent = '把此连接码交给接收端'
    el('local-field').hidden = false; el('remote-field').hidden = false
    status('等待接收端回传应答码。')
  })
}
function summary() {
  const incoming = prepared.summary
  const current = data.summary(local.data)
  el('summary').textContent = `收到 ${incoming.days} 天记录、${incoming.tasks} 项任务、${incoming.timers} 条计时、${incoming.templates} 套自定义时间表。本机现有 ${current.days} 天记录、${current.tasks} 项任务。`
  el('warning').textContent = incoming.keys
    ? '接收后将覆盖本机全部业务数据，并删除本机独有的记录。覆盖前会自动保留一份恢复副本。'
    : '发送端没有业务数据。确认后将清空本机业务数据，覆盖前会自动保留一份恢复副本。'
  el('accept').textContent = incoming.keys ? '备份并覆盖' : '备份并清空本机数据'
  el('preview').hidden = false
}
function createPeer() {
  if (peer) return peer
  if (typeof window.RTCPeerConnection !== 'function') throw new Error('当前浏览器不支持设备直连，请使用现代浏览器')
  const current = generation
  peer = peerTransfer.create({ role,
    onState(state) {
      if (current !== generation) return
      if (state === 'connected') {
        connected = true; el('pairing').hidden = true; el('send').hidden = role !== 'send'
        status(role === 'send' ? '已连接，可以发送本机数据。' : '已连接，等待对方发送数据。')
      } else if (state === 'disconnected') {
        connected = false; el('send').hidden = true
        status(outcome === 'saved' ? '传输完成，连接已关闭。' : outcome === 'rejected' ? '本次接收已取消，连接已关闭。' :
          prepared ? '连接已断开，数据已完整收到，仍可在本机确认保存。' : '连接已断开。如果已开始覆盖，请在接收端查看结果。')
      } else if (state === 'rejected') { outcome = 'rejected'; status('对方取消了本次接收。') }
      else if (state === 'receiving') status('正在接收数据…')
    },
    onProgress(done, total) {
      if (current !== generation) return
      el('progress').hidden = false; el('progress').max = total; el('progress').value = done
    },
    onPayload(text) {
      if (current !== generation) return
      void run(async session => {
        prepared = data.prepare(text)
        local = await data.local()
        if (session !== generation) return
        summary(); status('数据已收到，请核对后确认覆盖。')
      })
    },
    onApplied() { if (current === generation) { outcome = 'saved'; status('对方已确认并保存，传输完成。') } },
    onError(error) { if (current === generation) { status(error.message, true); connected = false; el('send').hidden = true; peer?.close() } },
  })
  return peer
}
async function showRecovery(current) {
  try {
    const snapshot = await storage.store.transferSnapshot()
    if (current === generation) el('restore').hidden = !snapshot.recovery
  } catch (error) { if (current === generation) status(error.message, true) }
}

storageState.onStorageReady(() => {
  dom.$('#qls-transfer-btn').addEventListener('click', () => {
    reset('send'); el('restore').hidden = true; ui.openDialog(dialog)
    if (typeof window.RTCPeerConnection !== 'function') status('当前浏览器不支持设备直连，请使用现代浏览器。', true)
    void showRecovery(generation)
  })
})
dialog.querySelectorAll('[data-transfer-role]').forEach(button => button.addEventListener('click', () => reset(button.dataset.transferRole)))
dialog.querySelectorAll('[data-transfer-mode]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.transferMode; reset() }))
el('connect').addEventListener('click', () => { void run(async current => {
  const code = el('remote-code').value.trim()
  if (!code) throw new Error('请先粘贴对方的连接码')
  status('正在建立设备连接…')
  if (role === 'send') await createPeer().connect(code)
  else {
    const answer = await createPeer().answer(code)
    if (current !== generation) return
    el('local-code').value = answer; el('local-label').textContent = '把此应答码交回发送端'
    el('local-field').hidden = false; el('remote-field').hidden = true
    status('请将应答码交回发送端，等待对方连接。')
  }
}) })
el('copy').addEventListener('click', () => { void run(async () => {
  try { await navigator.clipboard.writeText(el('local-code').value); ui.showToast('已复制连接码') }
  catch { el('local-code').disabled = false; el('local-code').focus(); el('local-code').select(); status('已选中连接码，请使用系统复制。') }
}) })
el('send').addEventListener('click', () => { void run(async current => {
  if (!connected) throw new Error('设备尚未连接')
  status('正在读取已保存的数据…')
  const outgoing = await data.outgoing()
  if (current !== generation) return
  await peer.send(outgoing)
  if (current === generation) { el('send').hidden = true; status('数据已发送，等待对方确认保存。') }
}) })
el('accept').addEventListener('click', () => { void run(async () => {
  if (!prepared || !local) throw new Error('没有可覆盖的数据')
  saving = true; controls(); status('正在备份并保存…')
  let receipt
  try { receipt = await data.accept(prepared, local) }
  catch (error) {
    local = await data.local()
    summary()
    throw error
  }
  try { peer.applied(receipt) } catch { /* 本机已保存；回执丢失不能撤销成功事务。 */ }
  el('preview').hidden = true; prepared = null; el('restore').hidden = false
  outcome = 'saved'
  status('已覆盖并保存。需要时可恢复上次覆盖前的数据。')
}) })
el('reject').addEventListener('click', () => {
  try { peer?.reject() } catch { /* 未写入业务数据，无需等待连接恢复。 */ }
  prepared = null; local = null; outcome = 'rejected'; el('preview').hidden = true; status('已取消接收，本机数据未更改。')
})
el('restore').addEventListener('click', () => {
  if (!confirm('恢复到上次覆盖前的数据？当前业务数据将被替换。')) return
  void run(async () => {
    saving = true; controls(); await data.restore(); status('已恢复到上次覆盖前的数据。'); el('preview').hidden = true; prepared = null
  })
})
el('restart').addEventListener('click', () => reset())
el('close').addEventListener('click', () => { if (!saving) ui.closeDialog(dialog) })
dialog.addEventListener('cancel', event => { if (saving) event.preventDefault() })
ui.bindDialog(dialog, { lightDismiss: false, onClose: () => { publicView.stop(); peer?.close(); peer = null; generation++; busy = false; saving = false; prepared = null; local = null } })
window.addEventListener('pagehide', () => { publicView.stop(); peer?.close() })
