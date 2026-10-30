/**
 * MAERS QLS — 零依赖本地静态开发服务器 (scripts/dev-server.js)
 * 职责：
 * 1. 提供标准 HTTP 协议访问，彻底解决 file:// 协议下跨目录跳转、ES Module 与移动端局域网调试限制；
 * 2. 自动检测端口占用并顺延（默认从 8081 开始），启动后自动打开默认浏览器；
 * 3. 输出本机与局域网访问地址，支持手机在同一 Wi-Fi 下直接访问测试；
 * 4. 监听地址由 HOST 环境变量控制（默认 127.0.0.1，仅本机可访问），设为 0.0.0.0 可开放给局域网（手机调试）。
 */

'use strict'

const http = require('node:http')
const fs   = require('node:fs')
const path = require('node:path')
const os   = require('node:os')
const { exec } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const ROOT_REAL = fs.realpathSync(ROOT)
const DEFAULT_PORT = parseInt(process.env.PORT, 10) || 8081
const HOST = process.env.HOST || '127.0.0.1'
/** 监听地址是否对局域网可见（仅回环地址视为私有） */
const IS_LAN_EXPOSED = !['127.0.0.1', 'localhost', '::1'].includes(HOST)
const AUTO_OPEN = !process.argv.includes('--no-open')

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** 获取本机真实局域网 IPv4 地址（优先匹配私有局域网段，跳过代理虚拟网卡） */
function getLanIp() {
  const nets = os.networkInterfaces()
  const candidates = []
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('198.18.')) {
        candidates.push(net.address)
      }
    }
  }
  return (
    candidates.find(ip => ip.startsWith('192.168.')) ||
    candidates.find(ip => ip.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) ||
    candidates[0] ||
    null
  )
}

/** 调用系统默认浏览器打开指定 URL */
function openBrowser(url) {
  if (!AUTO_OPEN) return
  const platform = process.platform
  const cmd = platform === 'win32'
    ? `start "" "${url}"`
    : platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`
  exec(cmd, () => {})
}

/** 校验目标路径是否严格位于根目录内部（防止同前缀兄弟目录绕过 startsWith） */
function isPathInsideRoot(rootDir, targetPath) {
  const rel = path.relative(rootDir, targetPath)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

const FORBIDDEN_TOP_DIRS = new Set(['node_modules', 'coverage', 'tests', 'scripts', 'dist'])
const PUBLIC_TOP_DIRS = new Set(['common', 'maers-schedule', 'maers-quantilife'])
const PUBLIC_ROOT_FILES = new Set(['index.html', 'manifest.webmanifest', 'sw.js', 'precache-manifest.js'])

function isPublicPath(rootDir, candidate) {
  if (!isPathInsideRoot(rootDir, candidate)) return false
  const parts = path.relative(rootDir, candidate).replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.some(part => part.startsWith('.') || /[. ]$/.test(part))) return false
  const top = parts[0]?.toLowerCase()
  if (parts.length === 1) return PUBLIC_ROOT_FILES.has(top)
  return PUBLIC_TOP_DIRS.has(top) && Object.hasOwn(MIME_TYPES, path.extname(candidate).toLowerCase())
}

/**
 * 解析并校验静态文件。除路径穿越外，同时阻止仓库内符号链接指向根目录外的文件，
 * 并屏蔽点文件/目录（如 .git、.github）与非运行时开发目录（node_modules、tests 等）。
 * 返回 null 表示不存在，false 表示越权，字符串表示可安全读取的真实路径。
 */
function resolveSafeFilePath(rawUrl) {
  const relPath = rawUrl.replace(/^\/+/, '') || 'index.html'
  let candidate = path.resolve(ROOT, relPath)
  if (!isPathInsideRoot(ROOT, candidate)) return false
  const normalizedRel = path.relative(ROOT, candidate).replace(/\\/g, '/')
  const parts = normalizedRel.split('/').filter(Boolean)
  if (parts.some(p => p.startsWith('.')) || (parts.length > 0 && FORBIDDEN_TOP_DIRS.has(parts[0].toLowerCase()))) {
    return false
  }
  if (!fs.existsSync(candidate)) return null
  if (fs.statSync(candidate).isDirectory()) candidate = path.join(candidate, 'index.html')
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null

  const realPath = fs.realpathSync(candidate)
  // 同时检查请求路径与真实路径，阻止大小写、内部链接及非运行时文件绕过。
  return isPublicPath(ROOT, candidate) && isPublicPath(ROOT_REAL, realPath) ? realPath : false
}

/** 创建静态文件请求处理器 */
const server = http.createServer((req, res) => {
  let rawUrl
  try {
    rawUrl = decodeURIComponent((req.url || '/').split('?')[0])
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('400 Bad Request')
    return
  }

  try {
    const filePath = resolveSafeFilePath(rawUrl)
    if (filePath === false) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('403 Forbidden')
      return
    }

    if (!filePath) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(`404 Not Found: ${rawUrl}`)
      return
    }

    const ext = path.extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'X-MAERS-App': 'MAERS-QLS',
    })
    fs.createReadStream(filePath).pipe(res)
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('500 Internal Server Error')
  }
})

/**
 * 探测指定端口是否已在运行 MAERS-QLS 实例。
 * 若已运行则直接复用该端口打开浏览器，避免端口顺延导致浏览器 IndexedDB 按 Origin 隔离丢失数据。
 */
function checkExistingQlsInstance(port, callback) {
  const req = http.get(
    {
      hostname: '127.0.0.1',
      port,
      path: '/manifest.webmanifest',
      timeout: 400,
    },
    (res) => {
      const isQlsHeader = res.headers['x-maers-app'] === 'MAERS-QLS'
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        if (body.length < 1024) body += chunk
      })
      res.on('end', () => {
        callback(isQlsHeader || body.includes('MAERS QLS'))
      })
    }
  )
  req.on('error', () => callback(false))
  req.on('timeout', () => {
    req.destroy()
    callback(false)
  })
}

/** 启动监听，若端口已被本系统占用则直接唤醒浏览器，若被其他程序占用则自动顺延 */
function startListen(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      checkExistingQlsInstance(port, (isRunning) => {
        if (isRunning) {
          const localUrl = `http://localhost:${port}`
          console.log(`[MAERS-QLS] 检测到服务已在 ${localUrl} 运行中，正在直接打开浏览器...`)
          openBrowser(localUrl)
          setTimeout(() => process.exit(0), 200)
        } else {
          console.warn(`[MAERS-QLS] 警告：端口 ${port} 被其他程序占用，改用 ${port + 1}。浏览器数据按端口隔离，此端口下看不到原端口的数据。`)
          startListen(port + 1)
        }
      })
    } else {
      console.error('[MAERS-QLS] 服务器启动失败:', err)
      process.exit(1)
    }
  })

  server.listen(port, HOST, () => {
    const localUrl = `http://localhost:${port}`
    const lanIp = IS_LAN_EXPOSED ? getLanIp() : null
    console.log('====================================================')
    console.log('  MAERS QLS 本地服务器已启动')
    console.log('----------------------------------------------------')
    console.log(`  监听地址:   ${HOST}:${port}`)
    console.log(`  本机访问:   ${localUrl}`)
    if (lanIp) {
      console.log(`  局域网访问: http://${lanIp}:${port}  (同 Wi-Fi 手机可访问)`)
    }
    if (IS_LAN_EXPOSED) {
      console.log('----------------------------------------------------')
      console.log('  [警告] 服务已对局域网开放，同网络内任何设备均可访问项目文件。')
      console.log('         仅限本机访问请去掉 HOST 环境变量（默认 127.0.0.1）。')
    }
    console.log('----------------------------------------------------')
    console.log('  ⚠️ 请勿关闭此黑色窗口，否则后台服务将停止。')
    console.log('  👉 想要停止服务，请直接关闭本窗口或按 Ctrl + C。')
    console.log('====================================================')
    openBrowser(localUrl)
  })
}

if (require.main === module) {
  // 启动前刷新 SW 预缓存清单，保证缓存版本号与磁盘资源一致（失败不影响服务启动）
  try { require('./build-precache').writeManifest() } catch (err) { console.warn('[MAERS-QLS] 预缓存清单更新失败:', err.message) }
  startListen(DEFAULT_PORT)
}

module.exports = { isPathInsideRoot, resolveSafeFilePath, checkExistingQlsInstance }

