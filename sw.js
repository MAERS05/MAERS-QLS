/**
 * MAERS QLS — PWA Service Worker (sw.js)
 * 职责：
 * 1. 预缓存清单与缓存版本号由 scripts/build-precache.js 生成（precache-manifest.js），
 *    版本号为全部资源内容哈希：新版本完整缓存成功后才接管并清理旧缓存；
 * 2. 全部同源 GET 请求采用 Network-First（带超时）并回退缓存；
 *    新版本的完整离线资源就绪后才接管，更新失败不提前移除旧缓存。
 */

'use strict'

importScripts('./precache-manifest.js')

const { version, shell, rest } = self.PRECACHE_MANIFEST
const CACHE_PREFIX = 'maers-qls-'
const CACHE_NAME = `${CACHE_PREFIX}${version}`
/** 首屏资源：根路径 + 门户页与公共底座，优先缓存 */
const SHELL_ASSETS = ['./', ...shell]
const REQUIRED_ASSETS = [...new Set([...SHELL_ASSETS, ...rest])]
/** 弱网下等待网络的最长时间，超时即使用缓存（网络请求仍在后台继续并更新缓存） */
const NETWORK_TIMEOUT_MS = 4000
/** 安装子系统资源时的并发批大小 */
const WARM_UP_BATCH_SIZE = 6

/** 绕过 HTTP 缓存读取资源，保证预缓存的是当前发布版本 */
const freshRequest = (url) => new Request(url, { cache: 'reload' })

async function ensureCompleteCache() {
  const cache = await caches.open(CACHE_NAME)
  const failures = []
  for (let i = 0; i < REQUIRED_ASSETS.length; i += WARM_UP_BATCH_SIZE) {
    const results = await Promise.allSettled(
      REQUIRED_ASSETS.slice(i, i + WARM_UP_BATCH_SIZE).map(async (assetUrl) => {
        if (!(await cache.match(assetUrl, { ignoreSearch: true }))) await cache.add(freshRequest(assetUrl))
      })
    )
    failures.push(...results.filter(result => result.status === 'rejected').map(result => result.reason))
  }
  if (failures.length) throw new AggregateError(failures, '新版本离线资源尚未完整缓存')
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_ASSETS.map(freshRequest)))
      .then(() => ensureCompleteCache())
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    // 所有下载都属于 waitUntil；确认子系统资源齐全后才清理旧版本。
    ensureCompleteCache()
      .then(() => caches.keys())
      .then((keys) => Promise.all(
        keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  )
})

/** 目录形式的导航请求（如 /MAERS-Schedule/）在缓存中以 index.html 保存 */
function cacheFallbackKeys(request) {
  const url = new URL(request.url)
  const keys = [request]
  if (url.pathname.endsWith('/')) keys.push(new URL('index.html', url).href)
  return keys
}

async function matchCache(cache, request) {
  for (const key of cacheFallbackKeys(request)) {
    const hit = await cache.match(key, { ignoreSearch: true })
    if (hit) return hit
  }
  return undefined
}

async function networkFirst(event) {
  const { request } = event
  const cache = await caches.open(CACHE_NAME)

  const network = fetch(request)
  // 网络结果落缓存；与响应流程分离，超时后仍可在后台完成更新
  event.waitUntil(
    network
      .then((response) => { if (response.ok) return cache.put(request, response.clone()) })
      .catch(() => {})
  )

  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS))
  const response = await Promise.race([network, timeout]).catch(() => null)
  if (response) return response

  // 离线或超时：优先缓存；缓存也没有时继续等待网络
  const cached = await matchCache(cache, request)
  if (cached) return cached
  try { return await network } catch { return Response.error() }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  if (new URL(request.url).origin !== self.location.origin) return
  event.respondWith(networkFirst(event))
})
