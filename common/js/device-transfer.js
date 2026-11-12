import { quantiTransfer } from '../../MAERS-QuantiLife/js/data-transfer.js'
import { scheduleTransfer } from '../../MAERS-Schedule/js/data-transfer.js'
import { metadata } from './core.js'
import { storage } from './store.js'
import { transferFormat as format } from './transfer-format.js'

export const deviceTransfer = {}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function checkCollections(before, after) {
  if (Array.isArray(before)) {
    if (!before.length && after === undefined) return
    if (!Array.isArray(after) || before.length !== after.length) throw new Error('数据中有无法识别的记录，请先检查或通过备份恢复')
    before.forEach((item, index) => checkCollections(item, after[index]))
  } else if (object(before)) {
    Object.entries(before).forEach(([key, value]) => {
      if (value && typeof value === 'object') checkCollections(value, after?.[key])
    })
  }
}
function normalize(data) {
  if (!object(data) || Object.keys(data).some(key => !format.isBusinessKey(key))) throw new Error('数据范围或格式不正确')
  const backup = { app: metadata.BACKUP_APP, version: metadata.BACKUP_VERSION, data }
  const entries = [...quantiTransfer.prepareImportEntries(backup).entries, ...scheduleTransfer.prepareImportEntries(backup).entries]
  if (entries.length !== Object.keys(data).length) throw new Error('数据中有当前版本无法识别的项目')
  const clean = Object.fromEntries(entries.map(({ key, value }) => [key, value]))
  checkCollections(data, clean)
  return clean
}
function ensurePaused(data) {
  if (data[metadata.INPROGRESS_KEY]?.some(task => task.status === 'running')) throw new Error('请先暂停正在计时的任务，再进行设备互传')
}
deviceTransfer.summary = data => ({
  days: Object.keys(data).filter(key => key.startsWith(metadata.QL_PREFIX) && /^\d{4}-\d{2}-\d{2}$/.test(key.slice(metadata.QL_PREFIX.length))).length,
  tasks: (data[metadata.TASKS_KEY]?.length || 0) + (data[metadata.GOALS_KEY]?.length || 0),
  timers: data[metadata.INPROGRESS_KEY]?.length || 0,
  templates: data[metadata.TIMEBLOCK_KEY]?._templates?.items?.length || 0,
  keys: Object.keys(data).length,
})
deviceTransfer.outgoing = async () => {
  const local = await storage.store.transferSnapshot()
  const data = normalize(local.data)
  ensurePaused(data)
  const envelope = { app: metadata.BACKUP_APP, version: 1, scope: format.SCOPE, schema: metadata.SCHEMA_VERSION,
    complete: true, id: metadata.uid('transfer_'), createdAt: new Date().toISOString(), data }
  const text = JSON.stringify(envelope)
  format.parse(text)
  return { envelope, text, summary: deviceTransfer.summary(data) }
}
deviceTransfer.prepare = text => {
  const envelope = format.parse(text)
  if (!object(envelope) || envelope.app !== metadata.BACKUP_APP || envelope.version !== 1 || envelope.schema !== metadata.SCHEMA_VERSION ||
      envelope.scope !== format.SCOPE || envelope.complete !== true || typeof envelope.id !== 'string' || !/^transfer_[\w-]{8,100}$/.test(envelope.id)) {
    throw new Error('传输格式或应用版本不一致，请两端使用同一版本')
  }
  const data = normalize(envelope.data)
  ensurePaused(data)
  return { envelope: { ...envelope, data }, checksum: format.checksum(format.bytes(text)), summary: deviceTransfer.summary(data) }
}
deviceTransfer.local = async () => {
  const snapshot = await storage.store.transferSnapshot()
  ensurePaused(snapshot.data)
  return snapshot
}
deviceTransfer.accept = (prepared, local, mode = 'replace') => storage.store.replaceSnapshot(prepared.envelope.data, {
  baseline: local.baseline, id: prepared.envelope.id, checksum: prepared.checksum, mode,
})
deviceTransfer.restore = async () => {
  const local = await deviceTransfer.local()
  return storage.store.replaceSnapshot({}, { baseline: local.baseline, id: metadata.uid('restore_'), checksum: 'restore', restore: true })
}
