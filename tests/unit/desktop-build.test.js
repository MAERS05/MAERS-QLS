'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { generateLauncherCsSource, findCscCompiler } = require('../../scripts/build-desktop-app')

test('Windows 桌面启动器：生成的 C# 源码可实际编译', { skip: process.platform !== 'win32' }, () => {
  const compiler = findCscCompiler()
  assert.ok(compiler, 'Windows 环境应提供 .NET Framework C# 编译器')
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qls-desktop-test-'))
  const source = path.join(directory, 'Launcher.cs')
  const output = path.join(directory, 'Launcher.exe')
  try {
    fs.writeFileSync(source, '\uFEFF' + generateLauncherCsSource(path.resolve(__dirname, '../..')))
    const result = spawnSync(compiler, [
      '/nologo', '/target:winexe', `/out:${output}`,
      '/r:System.dll', '/r:System.Windows.Forms.dll', source,
    ], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    assert.ok(fs.statSync(output).size > 0)
  } finally {
    fs.rmSync(source, { force: true })
    fs.rmSync(output, { force: true })
    fs.rmdirSync(directory)
  }
})
