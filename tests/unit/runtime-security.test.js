'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { ROOT } = require('../helpers/dom')
const { resolveSafeFilePath } = require('../../scripts/dev-server')
const { buildStatic, publicFiles, OUTPUT } = require('../../scripts/build-static')

test('静态服务：开发目录的大小写变体及根目录非运行时文件均被拒绝', () => {
  for (const url of [
    '/Tests/qls-test-data.json', '/SCRIPTS/dev-server.js', '/NODE_MODULES/jsdom/package.json',
    '/Coverage/index.html', '/.GiT/config', '/package.json', '/README.md', '/vercel.json',
  ]) assert.equal(resolveSafeFilePath(url), false, url)
  assert.ok(resolveSafeFilePath('/MAERS-Schedule/index.html'))
  assert.ok(resolveSafeFilePath('/common/fonts/inter-latin.woff2'))
})

test('静态服务：公共目录中指向测试目录的内部链接不能绕过真实路径校验', t => {
  const parent = fs.mkdtempSync(path.join(ROOT, 'common', 'runtime-link-test-'))
  const link = path.join(parent, 'alias')
  try {
    try { fs.symlinkSync(path.join(ROOT, 'tests'), link, 'junction') } catch (err) {
      if (['EPERM', 'EACCES'].includes(err.code)) { t.skip('当前环境不允许创建目录链接'); return }
      throw err
    }
    assert.equal(resolveSafeFilePath('/' + path.relative(ROOT, path.join(link, 'qls-test-data.json')).replace(/\\/g, '/')), false)
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link)
    fs.rmdirSync(parent)
  }
})

test('静态发布：dist 只含运行时资源，重新构建会清除遗留文件', () => {
  fs.mkdirSync(OUTPUT, { recursive: true })
  const sentinel = path.join(OUTPUT, 'private-sentinel.json')
  fs.writeFileSync(sentinel, '{}')
  const files = buildStatic()
  assert.equal(fs.existsSync(sentinel), false)
  assert.deepEqual(files, publicFiles())
  for (const file of files) {
    assert.equal(fs.existsSync(path.join(OUTPUT, file)), true, file)
    assert.equal(/^(tests|scripts|node_modules|coverage|\.git)(\/|$)/i.test(file), false)
  }
  for (const file of ['package.json', 'vercel.json', 'README.md', 'tests/qls-test-data.json']) {
    assert.equal(fs.existsSync(path.join(OUTPUT, file)), false, file)
  }
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'))
  assert.equal(config.outputDirectory, 'dist')
  assert.equal(config.buildCommand, 'npm run build')
})
