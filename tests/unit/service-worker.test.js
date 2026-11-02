/**
 * Service Worker 行为测试 (tests/unit/service-worker.test.js)
 * 在 vm 沙箱中以内存版 CacheStorage / fetch 运行真实的 sw.js，验证：
 * 预缓存与换代清理、Network-First 回退缓存、弱网超时降级、目录导航回退与请求过滤。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const { ROOT } = require('../helpers/dom')

const ORIGIN = 'http://localhost'
const SW_PATH = path.join(ROOT, 'sw.js')
const MANIFEST = { version: 'v1', shell: ['./index.html', './common/js/core.js'], rest: ['./MAERS-Schedule/index.html', './MAERS-Schedule/js/app.js'] }

/** 以绝对 URL 为键并忽略查询串，等价于 cache.match(..., { ignoreSearch: true }) */
const keyOf = (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url, `${ORIGIN}/`)
  url.search = ''
  return url.href
}

class FakeCache {
  constructor() { this.entries = new Map() }
  async add(request) {
    const response = await this.fetchImpl(request)
    if (!response.ok) throw new Error(`预缓存失败：${keyOf(request)}`)
    this.entries.set(keyOf(request), response)
  }
  async addAll(requests) { for (const request of requests) await this.add(request) }
  async put(request, response) { this.entries.set(keyOf(request), response) }
  async match(request) {
    const hit = this.entries.get(keyOf(request))
    return hit ? hit.clone() : undefined
  }
}

class FakeCacheStorage {
  constructor(fetchImpl) { this.fetchImpl = fetchImpl; this.stores = new Map() }
  async open(name) {
    if (!this.stores.has(name)) {
      const cache = new FakeCache()
      cache.fetchImpl = this.fetchImpl
      this.stores.set(name, cache)
    }
    return this.stores.get(name)
  }
  async keys() { return [...this.stores.keys()] }
  async delete(name) { return this.stores.delete(name) }
}

/** 载入 sw.js 并返回事件派发器 */
function loadServiceWorker({ fetchImpl, seedCaches = [] } = {}) {
  const handlers = {}
  const state = { skipWaiting: false, claimed: false }
  const fetcher = (request) => fetchImpl(request)
  const caches = new FakeCacheStorage(fetcher)
  seedCaches.forEach(name => caches.stores.set(name, new FakeCache()))

  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, handler) => { handlers[type] = handler },
    skipWaiting: () => { state.skipWaiting = true },
    clients: { claim: async () => { state.claimed = true } },
  }
  // 真实 SW 中相对地址以 sw.js 所在位置为基准；Node 的 Request 要求绝对地址
  class TestRequest extends Request {
    constructor(input, init) { super(typeof input === 'string' ? new URL(input, `${ORIGIN}/`).href : input, init) }
  }
  const context = vm.createContext({
    self, caches, fetch: fetcher, Request: TestRequest, Response, URL, Promise, console,
    // 经包装以便 mock.timers 接管
    setTimeout: (...args) => setTimeout(...args),
    importScripts: () => { self.PRECACHE_MANIFEST = MANIFEST },
  })
  vm.runInContext(fs.readFileSync(SW_PATH, 'utf8'), context, { filename: pathToFileURL(SW_PATH).href })

  /** 派发 install / activate 事件并等待 waitUntil 完成 */
  async function lifecycle(type) {
    const pending = []
    handlers[type]({ waitUntil: (promise) => pending.push(promise) })
    await Promise.all(pending)
  }

  /** 派发 fetch 事件；返回 { handled, response, done }，done 在后台缓存更新完成后兑现 */
  async function dispatchFetch(request) {
    const pending = []
    let responded = null
    handlers.fetch({
      request,
      waitUntil: (promise) => pending.push(promise),
      respondWith: (promise) => { responded = promise },
    })
    const response = responded ? await responded : null
    return { handled: responded !== null, response, done: Promise.all(pending) }
  }

  return { state, caches, lifecycle, dispatchFetch, cacheName: `maers-qls-${MANIFEST.version}` }
}

const ok = (body, url) => Object.defineProperty(new Response(body, { status: 200 }), 'url', { value: url })
const get = (pathname) => new Request(`${ORIGIN}${pathname}`)

test('install：完整缓存后才接管；activate：确认资源齐全后只清理本应用旧缓存', async () => {
  const requested = []
  const sw = loadServiceWorker({
    seedCaches: ['maers-qls-v2', 'maers-qls-oldhash', 'other-app-cache'],
    fetchImpl: async (request) => { requested.push(request.url); return ok('asset', request.url) },
  })

  await sw.lifecycle('install')
  assert.equal(sw.state.skipWaiting, true)
  const cache = await sw.caches.open(sw.cacheName)
  for (const url of ['/', '/index.html', '/common/js/core.js']) {
    assert.ok(await cache.match(`${ORIGIN}${url}`), `首屏资源 ${url} 应已预缓存`)
  }
  assert.ok(await cache.match(`${ORIGIN}/MAERS-Schedule/index.html`), '子系统资源必须在 install 成功前缓存')

  await sw.lifecycle('activate')
  assert.equal(sw.state.claimed, true)
  assert.deepEqual((await sw.caches.keys()).sort(), [sw.cacheName, 'other-app-cache'].sort(), '旧版本缓存被清理，其他应用的缓存不受影响')

  assert.ok(await cache.match(`${ORIGIN}/MAERS-Schedule/js/app.js`), '激活完成即保证子系统资源可用')
})

test('预热失败：其他资源继续缓存，但不清理旧缓存或接管页面', async () => {
  const requested = []
  const sw = loadServiceWorker({
    seedCaches: ['maers-qls-oldhash'],
    fetchImpl: async (request) => {
      requested.push(keyOf(request))
      if (keyOf(request).endsWith('/MAERS-Schedule/index.html')) throw new Error('网络错误')
      return ok('asset', request.url)
    },
  })
  const cache = await sw.caches.open(sw.cacheName)
  await cache.put(`${ORIGIN}/MAERS-Schedule/js/app.js`, ok('cached', `${ORIGIN}/MAERS-Schedule/js/app.js`))

  await assert.rejects(sw.lifecycle('activate'), /新版本离线资源尚未完整缓存/)
  assert.equal(sw.state.claimed, false)
  assert.ok((await sw.caches.keys()).includes('maers-qls-oldhash'))
  assert.equal(requested.filter(url => url.endsWith('/MAERS-Schedule/js/app.js')).length, 0, '已缓存资源不应再次请求')
  assert.equal(requested.filter(url => url.endsWith('/MAERS-Schedule/index.html')).length, 1)
})

test('安装中断：子系统资源失败时不跳过等待，旧版本仍保留', async () => {
  const sw = loadServiceWorker({
    seedCaches: ['maers-qls-oldhash'],
    fetchImpl: async request => {
      if (request.url.endsWith('/MAERS-Schedule/index.html')) throw new Error('offline during update')
      return ok('asset', request.url)
    },
  })
  await assert.rejects(sw.lifecycle('install'), /新版本离线资源尚未完整缓存/)
  assert.equal(sw.state.skipWaiting, false)
  assert.equal(sw.state.claimed, false)
  assert.ok((await sw.caches.keys()).includes('maers-qls-oldhash'))
  const cache = await sw.caches.open(sw.cacheName)
  assert.ok(await cache.match(`${ORIGIN}/MAERS-Schedule/js/app.js`), '同批其余资源仍完成下载')
})

test('激活等待：预热未完成时 waitUntil 不结束，也不提前删除旧缓存', async () => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const sw = loadServiceWorker({
    seedCaches: ['maers-qls-oldhash'],
    fetchImpl: async request => { await gate; return ok('asset', request.url) },
  })
  let finished = false
  const activation = sw.lifecycle('activate').then(() => { finished = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(finished, false)
  assert.equal(sw.state.claimed, false)
  assert.ok((await sw.caches.keys()).includes('maers-qls-oldhash'))
  release()
  await activation
  assert.equal(sw.state.claimed, true)
  assert.equal((await sw.caches.keys()).includes('maers-qls-oldhash'), false)
})

test('激活完整性：首屏资源丢失且下载失败时也必须保留旧缓存', async () => {
  const sw = loadServiceWorker({
    seedCaches: ['maers-qls-oldhash'],
    fetchImpl: async request => {
      if (request.url.endsWith('/index.html') && !request.url.includes('MAERS-Schedule')) throw new Error('shell unavailable')
      return ok('asset', request.url)
    },
  })
  const cache = await sw.caches.open(sw.cacheName)
  for (const asset of MANIFEST.rest) await cache.put(`${ORIGIN}/${asset.slice(2)}`, ok('asset', asset))
  await assert.rejects(sw.lifecycle('activate'), /新版本离线资源尚未完整缓存/)
  assert.equal(sw.state.claimed, false)
  assert.ok((await sw.caches.keys()).includes('maers-qls-oldhash'))
})

test('在线：始终返回最新网络响应并更新缓存', async () => {
  let version = 1
  const sw = loadServiceWorker({ fetchImpl: async (request) => ok(`v${version}`, request.url) })

  const first = await sw.dispatchFetch(get('/common/js/core.js'))
  assert.equal(await first.response.text(), 'v1')
  await first.done
  version = 2
  const second = await sw.dispatchFetch(get('/common/js/core.js'))
  assert.equal(await second.response.text(), 'v2', '在线时不得返回旧缓存')
  await second.done

  const cache = await sw.caches.open(sw.cacheName)
  assert.equal(await (await cache.match(`${ORIGIN}/common/js/core.js`)).text(), 'v2')
})

test('在线但服务端返回错误：不覆盖缓存', async () => {
  const sw = loadServiceWorker({ fetchImpl: async () => new Response('boom', { status: 500 }) })
  const cache = await sw.caches.open(sw.cacheName)
  await cache.put(`${ORIGIN}/a.js`, ok('good', `${ORIGIN}/a.js`))

  const { response, done } = await sw.dispatchFetch(get('/a.js'))
  await done
  assert.equal(response.status, 500, '错误响应原样交给页面')
  assert.equal(await (await cache.match(`${ORIGIN}/a.js`)).text(), 'good')
})

test('离线：回退到缓存；缓存也没有时返回网络错误；目录导航回退到 index.html', async () => {
  const sw = loadServiceWorker({ fetchImpl: async () => { throw new TypeError('offline') } })
  const cache = await sw.caches.open(sw.cacheName)
  await cache.put(`${ORIGIN}/common/js/core.js`, ok('cached-core', `${ORIGIN}/common/js/core.js`))
  await cache.put(`${ORIGIN}/MAERS-Schedule/index.html`, ok('cached-schedule', `${ORIGIN}/MAERS-Schedule/index.html`))

  const hit = await sw.dispatchFetch(get('/common/js/core.js?v=3'))
  assert.equal(await hit.response.text(), 'cached-core', '忽略查询串匹配缓存')

  const dir = await sw.dispatchFetch(get('/MAERS-Schedule/'))
  assert.equal(await dir.response.text(), 'cached-schedule', '目录请求回退到该目录的 index.html')

  const miss = await sw.dispatchFetch(get('/never-cached.js'))
  assert.equal(miss.response.type, 'error')
})

test('弱网超时：超过等待上限直接使用缓存，网络请求仍在后台完成并刷新缓存', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release
  const slow = new Promise(resolve => { release = resolve })
  const sw = loadServiceWorker({ fetchImpl: async (request) => { await slow; return ok('fresh', request.url) } })
  const cache = await sw.caches.open(sw.cacheName)
  await cache.put(`${ORIGIN}/slow.js`, ok('stale', `${ORIGIN}/slow.js`))

  const pending = sw.dispatchFetch(get('/slow.js'))
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(4000)
  const { response, done } = await pending
  assert.equal(await response.text(), 'stale', '超时后立即使用缓存')

  release()
  await done
  assert.equal(await (await cache.match(`${ORIGIN}/slow.js`)).text(), 'fresh', '网络结果到达后应后台刷新缓存')
})

test('超时且无缓存：继续等待网络结果', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let release
  const slow = new Promise(resolve => { release = resolve })
  const sw = loadServiceWorker({ fetchImpl: async (request) => { await slow; return ok('late', request.url) } })

  const pending = sw.dispatchFetch(get('/uncached.js'))
  await new Promise(resolve => setImmediate(resolve))
  t.mock.timers.tick(4000)
  await new Promise(resolve => setImmediate(resolve))
  release()
  const { response } = await pending
  assert.equal(await response.text(), 'late')
})

test('请求过滤：非 GET 与跨域请求不拦截', async () => {
  const sw = loadServiceWorker({ fetchImpl: async (request) => ok('x', request.url) })
  const post = await sw.dispatchFetch(new Request(`${ORIGIN}/api`, { method: 'POST', body: '{}' }))
  assert.equal(post.handled, false)
  const cross = await sw.dispatchFetch(new Request('https://cdn.example.com/lib.js'))
  assert.equal(cross.handled, false)
})
