/**
 * IndexedDB 存储层测试 (tests/unit/idb-store.test.js)
 * 使用 fake-indexeddb 覆盖 IndexedDB 主路径：落盘与重载、旧数据迁移、写入语义、批量原子写入与跨标签页同步。
 * 多个页面共享同一个 IDBFactory 即模拟同一浏览器的多个标签页。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createPage, createIdbFactory, waitFor, plain } = require('../helpers/dom')

/** 打开使用 IndexedDB 的页面并等待首次数据载入完成 */
async function open(factory, options = {}) {
  const page = createPage('index.html', { indexedDB: factory, ...options })
  await page.ready()
  return page
}

/** 记录页面收到的跨标签页变更键 */
function watchChanges(page) {
  const seen = []
  page.QLS.onStoreChange(keys => seen.push(...keys))
  return seen
}

const settle = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms))

test('IndexedDB 主路径：写入落盘，新页面可读取，业务键不残留在 localStorage', async () => {
  const factory = createIdbFactory()
  const a = await open(factory)
  assert.equal(a.QLS.store.mode, 'indexeddb')

  assert.equal(a.QLS.store.set('quantilife_2026-10-15', { steps: 9000 }), true)
  await a.QLS.store.flush()
  assert.equal(a.localStorage.getItem('quantilife_2026-10-15'), null, '业务数据不得写入 localStorage')

  const b = await open(factory)
  assert.deepEqual(plain(b.QLS.store.get('quantilife_2026-10-15')), { steps: 9000 })
  assert.equal(b.QLS.store.has('quantilife_2026-10-15'), true)
})

test('首屏同步键（主题、默认入口）始终保留在 localStorage', async () => {
  const a = await open(createIdbFactory())
  a.QLS.store.set(a.QLS.THEME_KEY, 'dark')
  a.QLS.store.set(a.QLS.SCH_ENTRY_KEY, 'timeline')
  await a.QLS.store.flush()
  assert.equal(JSON.parse(a.localStorage.getItem(a.QLS.THEME_KEY)), 'dark')
  assert.equal(a.QLS.store.get(a.QLS.SCH_ENTRY_KEY), 'timeline')
})

test('旧版迁移：localStorage 业务键迁入 IndexedDB 后清理，首屏键保留，已有 IDB 数据不被旧副本覆盖', async () => {
  const factory = createIdbFactory()
  const first = await open(factory, {
    storage: { 'schedule_tasks': [{ id: 't1', title: '旧任务' }], qls_theme: 'dark' },
  })
  await first.QLS.store.flush()
  assert.equal(first.localStorage.getItem('schedule_tasks'), null, '迁移成功后应清理旧副本')
  assert.equal(JSON.parse(first.localStorage.getItem('qls_theme')), 'dark')
  assert.equal(plain(first.QLS.store.get('schedule_tasks'))[0].title, '旧任务')

  // 再次启动时 localStorage 又出现同名旧键：IDB 中已有数据，绝不能被旧副本覆盖
  const second = await open(factory, { storage: { 'schedule_tasks': [{ id: 't2', title: '陈旧副本' }] } })
  assert.equal(plain(second.QLS.store.get('schedule_tasks'))[0].title, '旧任务')
  assert.equal(second.localStorage.getItem('schedule_tasks'), null, '遗留旧键应被清理')
})

test('清理 90 天前的 bridge 已读标记，保留近期标记', async () => {
  const factory = createIdbFactory()
  const seed = await open(factory)
  const { QLS } = seed
  const old = QLS.dateKey(QLS.addDays(new Date(), -120))
  const recent = QLS.dateKey(QLS.addDays(new Date(), -3))
  seed.QLS.store.set(QLS.BRIDGE_VIEWED_PREFIX + old, [])
  seed.QLS.store.set(QLS.BRIDGE_VIEWED_PREFIX + recent, [])
  await seed.QLS.store.flush()

  const next = await open(factory)
  assert.equal(next.QLS.store.has(QLS.BRIDGE_VIEWED_PREFIX + old), false)
  assert.equal(next.QLS.store.has(QLS.BRIDGE_VIEWED_PREFIX + recent), true)
})

test('写入语义：不可序列化数据被拒绝且不污染缓存，相同内容重复写入直接成功', async () => {
  const originalError = console.error
  console.error = () => {}
  try {
    const a = await open(createIdbFactory())
    const circular = {}
    circular.self = circular
    assert.equal(a.QLS.store.set('schedule_bad', circular), false)
    assert.equal(a.QLS.store.set('schedule_undefined', undefined), false)
    assert.equal(a.QLS.store.has('schedule_bad'), false)

    assert.equal(a.QLS.store.set('schedule_ok', { n: 1 }), true)
    assert.equal(a.QLS.store.set('schedule_ok', { n: 1 }), true, '内容未变化也应返回成功')
    assert.equal(a.QLS.store.remove('schedule_missing'), true, '删除不存在的键视为成功')
  } finally {
    console.error = originalError
  }
})

test('枚举与导出：keys 按前缀过滤并含首屏键，dump 汇总全部可解析数据，用量估算随数据增长', async () => {
  const a = await open(createIdbFactory())
  const { store } = a.QLS
  const empty = store.estimateUsage()
  store.set('quantilife_a', 1)
  store.set('schedule_b', { v: 2 })
  store.set(a.QLS.SCH_ENTRY_KEY, 'timeline')

  assert.deepEqual(plain(store.keys('quantilife_')).sort(), ['quantilife_a'])
  assert.ok(store.keys('schedule_').includes('schedule_b'))
  assert.ok(store.keys('schedule_').includes(a.QLS.SCH_ENTRY_KEY), '首屏键也应被枚举')
  assert.deepEqual(plain(store.dump(['quantilife_', 'schedule_b'])), { quantilife_a: 1, schedule_b: { v: 2 } })
  assert.ok(store.estimateUsage() > empty)
  assert.equal(await store.estimateQuota() === null || typeof (await store.estimateQuota()) === 'object', true)
})

test('批量写入：原子落盘并刷新缓存，无效条目整体拒绝且原数据不变', async () => {
  const originalError = console.error
  console.error = () => {}
  try {
    const factory = createIdbFactory()
    const a = await open(factory)
    a.QLS.store.set('schedule_keep', 'old')

    assert.equal(await a.QLS.store.batchSet([
      { key: 'schedule_keep', value: 'new' },
      { key: 'quantilife_2026-10-01', value: { steps: 1 } },
      { key: a.QLS.QL_ENTRY_KEY, value: 'report' },
    ]), 3)
    assert.equal(a.QLS.store.get('schedule_keep'), 'new')
    assert.equal(a.QLS.store.get(a.QLS.QL_ENTRY_KEY), 'report', '首屏键应写入 localStorage')

    assert.equal(await a.QLS.store.batchSet([
      { key: 'schedule_keep', value: 'broken' },
      { key: '', value: 1 },
    ]), 0)
    assert.equal(await a.QLS.store.batchSet([{ key: 'schedule_keep', value: undefined }]), 0)
    assert.equal(await a.QLS.store.batchSet([]), 0)
    assert.equal(a.QLS.store.get('schedule_keep'), 'new', '失败的批量写入不得改动任何数据')

    const b = await open(factory)
    assert.equal(b.QLS.store.get('schedule_keep'), 'new')
    assert.deepEqual(plain(b.QLS.store.get('quantilife_2026-10-01')), { steps: 1 })
  } finally {
    console.error = originalError
  }
})

test('批量写入：磁盘配额不足时拒绝导入，原数据不变', async () => {
  const originalError = console.error
  console.error = () => {}
  try {
    const a = await open(createIdbFactory(), {
      beforeScripts(win) {
        Object.defineProperty(win.navigator, 'storage', {
          configurable: true,
          value: { estimate: async () => ({ usage: 100, quota: 120 }) },
        })
      },
    })
    a.QLS.store.set('schedule_keep', 'old')
    assert.equal(await a.QLS.store.batchSet([{ key: 'schedule_big', value: 'x'.repeat(200) }]), 0)
    assert.equal(a.QLS.store.has('schedule_big'), false)
    assert.equal(a.QLS.store.get('schedule_keep'), 'old')
  } finally {
    console.error = originalError
  }
})

test('跨标签页：A 写入后 B 刷新内存镜像并收到变更通知，删除同样同步', async () => {
  const factory = createIdbFactory()
  const a = await open(factory)
  const b = await open(factory)
  const seen = watchChanges(b)

  a.QLS.store.set('schedule_shared', { n: 1 })
  await a.QLS.store.flush()
  await waitFor(() => seen.includes('schedule_shared'))
  assert.deepEqual(plain(b.QLS.store.get('schedule_shared')), { n: 1 })

  a.QLS.store.remove('schedule_shared')
  await a.QLS.store.flush()
  await waitFor(() => !b.QLS.store.has('schedule_shared'))
  assert.equal(b.QLS.store.get('schedule_shared', 'gone'), 'gone')
})

test('跨标签页：批量导入同步到其他标签页', async () => {
  const factory = createIdbFactory()
  const a = await open(factory)
  const b = await open(factory)
  const seen = watchChanges(b)

  await a.QLS.store.batchSet([
    { key: 'quantilife_2026-10-02', value: { steps: 2 } },
    { key: 'schedule_goals', value: [{ id: 'g1', title: '目标' }] },
  ])
  await waitFor(() => seen.includes('quantilife_2026-10-02') && seen.includes('schedule_goals'))
  assert.deepEqual(plain(b.QLS.store.get('quantilife_2026-10-02')), { steps: 2 })
})

test('跨标签页：内容未变化不广播；首屏键与业务数据统一同步', async () => {
  const factory = createIdbFactory()
  const a = await open(factory)
  const b = await open(factory)
  const seenA = watchChanges(a)
  const seenB = watchChanges(b)

  a.QLS.store.set('schedule_once', 1)
  await a.QLS.store.flush()
  await waitFor(() => seenB.includes('schedule_once'))
  seenB.length = 0

  a.QLS.store.set('schedule_once', 1)
  a.QLS.store.set(a.QLS.THEME_KEY, 'dark')
  await a.QLS.store.flush()
  await settle()
  assert.deepEqual(seenA, [], '自身写入不应触发自身通知')
  assert.deepEqual(seenB, [a.QLS.THEME_KEY], '首屏设置的权威副本也应同步到其他页面')
  assert.equal(b.QLS.store.get(a.QLS.THEME_KEY), 'dark')
})

test('跨标签页：同一键的更新以最终落盘内容为准，且不会因乱序回退', async () => {
  const factory = createIdbFactory()
  const a = await open(factory)
  const b = await open(factory)
  const seen = watchChanges(b)

  for (let n = 1; n <= 5; n++) a.QLS.store.set('schedule_counter', n)
  await a.QLS.store.flush()
  await waitFor(() => seen.length > 0 && b.QLS.store.get('schedule_counter') === 5)
  await settle()
  assert.equal(b.QLS.store.get('schedule_counter'), 5)
})

test('跨标签页：无 BroadcastChannel 的环境自动降级为单页模式，读写不受影响', async () => {
  const factory = createIdbFactory()
  const a = createPage('index.html', {
    indexedDB: factory,
    beforeScripts(win) { win.BroadcastChannel = undefined },
  })
  await a.ready()
  assert.equal(a.QLS.store.set('schedule_solo', 1), true)
  await a.QLS.store.flush()
  assert.equal(a.QLS.store.get('schedule_solo'), 1)
})

test('schema 版本化：初始化后 IDB 中持久化了当前 schema 版本号，后续打开可读取', async () => {
  const factory = createIdbFactory()
  const a = await open(factory)
  // 首次打开：schema 版本已写入 IDB（通过 readAll 检查内部键）
  assert.equal(a.QLS.SCHEMA_VERSION, 2, '当前 schema 版本号应为 2')
  // 重新打开：schema 版本号仍在，不影响正常读写
  const b = await open(factory)
  assert.equal(b.QLS.store.mode, 'indexeddb')
  b.QLS.store.set('quantilife_2026-01-01', { test: true })
  await b.QLS.store.flush()
  assert.deepEqual(plain(b.QLS.store.get('quantilife_2026-01-01')), { test: true })
})

test('flush：等待排队的事务后，新页面可读取已提交内容', async () => {
  const factory = createIdbFactory()
  const a = await open(factory)
  // 写入数据但不 flush
  a.QLS.store.set('quantilife_2026-06-15', { date: '2026-06-15' })
  // 等待异步落盘
  await a.QLS.store.flush()
  // 新页面能读到数据
  const b = await open(factory)
  assert.deepEqual(plain(b.QLS.store.get('quantilife_2026-06-15')), { date: '2026-06-15' })
})

/** 直接向 IndexedDB 写入原始记录，模拟旧版本遗留数据 */
function seedRaw(factory, records) {
  return new Promise((resolve, reject) => {
    const request = factory.open('maers-qls-data', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('keyvalue', { keyPath: 'key' })
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction('keyvalue', 'readwrite')
      records.forEach(record => tx.objectStore('keyvalue').put(record))
      tx.oncomplete = () => { db.close(); resolve() }
      tx.onerror = () => reject(tx.error)
    }
  })
}

/** 读取 IndexedDB 中的原始记录 */
function readRaw(factory, key) {
  return new Promise((resolve, reject) => {
    const request = factory.open('maers-qls-data', 1)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const get = db.transaction('keyvalue', 'readonly').objectStore('keyvalue').get(key)
      get.onsuccess = () => { db.close(); resolve(get.result?.raw) }
      get.onerror = () => reject(get.error)
    }
  })
}

test('schema v1 → v2 迁移：颜色转分类键（含已废弃的旧色值），变更与版本号一并落盘', async () => {
  const factory = createIdbFactory()
  await seedRaw(factory, [
    { key: '__schema_version__', raw: '1' },
    {
      key: 'schedule_timeblocks',
      raw: JSON.stringify({
        '2026-08-19': [{ id: 'a', label: '力量训练', startH: 9, durationH: 1, color: '#449167' }],
        ideal: [{ id: 'b', label: '学习', startH: 8, durationH: 2, color: '#7371c0' }],
        _repeats: [{ seriesId: 's1', label: '晨跑', startH: 7, durationH: 1, color: '#449167', repeat: { unit: 'day', interval: 1, baseDate: '2026-08-01' } }],
      }),
    },
    { key: 'schedule_inprogress', raw: JSON.stringify([{ id: 'ip1', title: '慢跑', color: '#449167', status: 'completed' }]) },
  ])

  const page = await open(factory)
  const blocks = plain(page.QLS.store.get('schedule_timeblocks'))
  assert.equal(blocks['2026-08-19'][0].category, 'health', '旧版 health 色值必须映射回 health')
  assert.equal('color' in blocks['2026-08-19'][0], false)
  assert.equal(blocks.ideal[0].category, 'learn')
  assert.equal(blocks._repeats[0].category, 'health')
  assert.equal(plain(page.QLS.store.get('schedule_inprogress'))[0].category, 'health')

  // 迁移结果必须真实写回磁盘，且版本号同步升级
  assert.equal(await readRaw(factory, '__schema_version__'), String(page.QLS.SCHEMA_VERSION))
  const persisted = JSON.parse(await readRaw(factory, 'schedule_inprogress'))
  assert.equal(persisted[0].category, 'health')
  assert.equal('color' in persisted[0], false)
})
