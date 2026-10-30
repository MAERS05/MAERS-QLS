/**
 * Service Worker 预缓存清单生成脚本 (scripts/build-precache.js)
 * 职责：
 * 1. 扫描仓库内全部运行时静态资源（门户页、common/、两个子系统），按「首屏资源 / 其余资源」分组；
 * 2. 以全部资源内容的哈希作为缓存版本号：任一资源变化即生成新版本，旧缓存在新 SW 激活时自动清理；
 * 3. 输出 precache-manifest.js，由 sw.js 经 importScripts 载入，不再手写资源清单或版本号。
 * 用法：npm run build:precache（npm start 会自动执行；tests/static 会校验清单是否已更新）。
 */

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const ROOT = path.resolve(__dirname, '..')
const OUTPUT = path.join(ROOT, 'precache-manifest.js')

/** 根目录下需要预缓存的文件 */
const ROOT_FILES = ['index.html', 'manifest.webmanifest']
/** 需要递归预缓存的目录 */
const ASSET_DIRS = ['common', 'MAERS-Schedule', 'MAERS-QuantiLife']
/** 首屏资源：门户页、公共底座以及门户页引用的全部本地资源；其余子系统资源在 SW 激活后低并发后台预热 */
const SHELL_PREFIXES = ['common/']
const PORTAL_PAGE = 'index.html'
/** 仅桌面启动程序使用、浏览器不会请求的资源 */
const PUBLIC_EXTENSIONS = new Set(['.html', '.css', '.js', '.svg', '.webmanifest', '.png', '.jpg', '.jpeg', '.gif', '.woff', '.woff2'])
const PRIVATE_NAMES = /(?:^|[._-])(?:backup|private|secret|temp|tmp|test|tests)(?:$|[._-])/i
function isRuntimeFile(rel) {
  return rel.split('/').every(part => !part.startsWith('.') && !PRIVATE_NAMES.test(part)) && PUBLIC_EXTENSIONS.has(path.posix.extname(rel))
}
/** 参与哈希时统一换行符的文本类型（避免 Windows CRLF 与 Linux LF 检出得到不同版本号） */
const TEXT_EXTENSIONS = new Set(['.html', '.css', '.js', '.svg', '.webmanifest', '.json'])

/** 递归列出目录下全部文件（相对仓库根目录、统一正斜杠） */
function walk(dirRel) {
  const out = []
  for (const entry of fs.readdirSync(path.join(ROOT, dirRel), { withFileTypes: true })) {
    const rel = `${dirRel}/${entry.name}`
    if (entry.isDirectory()) out.push(...walk(rel))
    else out.push(rel)
  }
  return out
}

/** 门户页声明的本地资源（script / link / img），相对仓库根目录 */
function portalReferences() {
  const html = fs.readFileSync(path.join(ROOT, PORTAL_PAGE), 'utf8')
  const direct = [...html.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)="([^"#?]+)"/g)]
    .map(match => match[1])
    .filter(ref => !/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(ref) && !ref.startsWith('data:'))
    .map(ref => path.posix.normalize(ref))
  const references = new Set(direct)
  function visit(rel) {
    if (!rel.endsWith('.js')) return
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8')
    for (const [, specifier] of source.matchAll(/^\s*import\s+(?:[^'"\n]+?\s+from\s+)?['"](\.[^'"]+)['"]/gm)) {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(rel), specifier))
      if (dependency.startsWith('../') || path.posix.isAbsolute(dependency)) throw new Error('模块资源超出项目目录')
      if (references.has(dependency)) continue
      references.add(dependency)
      visit(dependency)
    }
  }
  direct.forEach(visit)
  return [...references]
}

/** 全部预缓存资源（排序后，保证输出稳定） */
function listAssets() {
  const files = [...ROOT_FILES, ...ASSET_DIRS.flatMap(walk)]
    .filter(isRuntimeFile)
  return [...new Set(files)].sort()
}

function hashAssets(assets) {
  const hash = crypto.createHash('sha256')
  for (const rel of assets) {
    let content = fs.readFileSync(path.join(ROOT, rel))
    if (TEXT_EXTENSIONS.has(path.posix.extname(rel))) {
      content = Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'), 'utf8')
    }
    hash.update(`${rel}\0`).update(content).update('\n')
  }
  return hash.digest('hex').slice(0, 12)
}

/** 生成清单对象：{ version, shell, rest }（资源路径均以 ./ 开头，相对 sw.js 所在目录） */
function buildManifest() {
  const assets = listAssets()
  const portal = new Set(portalReferences())
  const isShell = rel => ROOT_FILES.includes(rel) || portal.has(rel) || SHELL_PREFIXES.some(prefix => rel.startsWith(prefix))
  const toUrl = rel => `./${rel}`
  return {
    version: hashAssets(assets),
    shell: assets.filter(isShell).map(toUrl),
    rest: assets.filter(rel => !isShell(rel)).map(toUrl),
  }
}

/** 将清单渲染为 sw.js 可 importScripts 的脚本文本 */
function renderManifest(manifest) {
  return [
    '/**',
    ' * Service Worker 预缓存清单 —— 由 scripts/build-precache.js 自动生成，请勿手工修改。',
    ' * 修改任意运行时资源后执行 npm run build:precache 更新。',
    ' */',
    `self.PRECACHE_MANIFEST = ${JSON.stringify(manifest, null, 2)}`,
    '',
  ].join('\n')
}

/** 重新生成并写入清单文件（内容无变化时不触碰文件） */
function writeManifest() {
  const content = renderManifest(buildManifest())
  const current = fs.existsSync(OUTPUT) ? fs.readFileSync(OUTPUT, 'utf8') : null
  if (current !== content) {
    fs.writeFileSync(OUTPUT, content)
    console.log(`[precache] 已更新 ${path.basename(OUTPUT)}`)
  }
}

if (require.main === module) writeManifest()

module.exports = { buildManifest, renderManifest, writeManifest, OUTPUT }
