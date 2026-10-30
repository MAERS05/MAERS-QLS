/** 生成仅含浏览器运行时资源的静态发布目录，避免部署整个仓库。 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { buildManifest, writeManifest } = require('./build-precache')

const ROOT = path.resolve(__dirname, '..')
const OUTPUT = path.join(ROOT, 'dist')

function publicFiles() {
  const manifest = buildManifest()
  return [...new Set([
    ...manifest.shell, ...manifest.rest, './sw.js', './precache-manifest.js',
  ])].map(url => url.replace(/^\.\//, ''))
}

function buildStatic() {
  writeManifest()
  const files = publicFiles()
  if (fs.existsSync(OUTPUT)) {
    // 递归清理前验证固定输出目录及真实路径，禁止跟随链接删除其他目录。
    const realRoot = fs.realpathSync(ROOT)
    const relative = path.relative(realRoot, fs.realpathSync(OUTPUT))
    if (fs.lstatSync(OUTPUT).isSymbolicLink() || relative.toLowerCase() !== 'dist') {
      throw new Error('发布目录必须是项目内的 dist 实体目录')
    }
    fs.rmSync(OUTPUT, { recursive: true, force: true })
  }
  for (const file of files) {
    const source = path.join(ROOT, file)
    if (path.relative(fs.realpathSync(ROOT), fs.realpathSync(source)).replace(/\\/g, '/') !== file) {
      throw new Error('发布资源不能通过链接指向其他文件')
    }
    const target = path.resolve(OUTPUT, file)
    const relative = path.relative(OUTPUT, target)
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('非法发布路径')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, target)
  }
  return files
}

if (require.main === module) console.log(`[build] 已发布 ${buildStatic().length} 个运行时文件至 dist/`)

module.exports = { buildStatic, publicFiles, OUTPUT }
