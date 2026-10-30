/**
 * 静态契约测试 (tests/static/contracts.test.js)
 * 无需运行页面即可发现的跨文件约束：资源引用、DOM id 对应、CSS 规范、弹窗基座、路径穿越与语法。
 */

'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { ROOT } = require('../helpers/dom')
const { parseModule, moduleFiles } = require('../helpers/modules')

const PAGES = ['index.html', 'MAERS-Schedule/index.html', 'MAERS-QuantiLife/index.html', 'MAERS-QuantiLife/report.html']

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const unique = (arr) => [...new Set(arr)]

/** 递归列出目录下指定扩展名的文件（相对根目录、统一正斜杠） */
function listFiles(dirRel, ext) {
  const out = []
  const walk = (rel) => {
    for (const entry of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const next = `${rel}/${entry.name}`
      if (entry.isDirectory()) walk(next)
      else if (entry.name.endsWith(ext)) out.push(next)
    }
  }
  walk(dirRel)
  return out
}

/** 解析页面声明的本地资源（相对根目录） */
function pageAssets(pageRel) {
  const dir = path.posix.dirname(pageRel)
  const html = read(pageRel)
  const refs = [...html.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)="([^"#?]+)"/g)].map(m => m[1])
  const assets = unique(refs)
    .filter(ref => !/^(?:[a-z]+:)?\/\//i.test(ref) && !ref.startsWith('data:'))
    .map(ref => ({ ref, rel: path.posix.normalize(path.posix.join(dir, ref)) }))
  const scripts = moduleFiles(ROOT, assets.filter(a => a.rel.endsWith('.js')).map(a => a.rel))
  return [...assets, ...scripts.filter(rel => !assets.some(a => a.rel === rel)).map(rel => ({ ref: rel, rel }))]
}

const CSS_FILES = listFiles('common/css', '.css')
  .concat(listFiles('MAERS-Schedule/css', '.css'), listFiles('MAERS-QuantiLife/css', '.css'))
const JS_FILES = listFiles('common/js', '.js')
  .concat(listFiles('MAERS-Schedule/js', '.js'), listFiles('MAERS-QuantiLife/js', '.js'))

test('页面引用的脚本、样式与图片资源全部存在', () => {
  for (const page of PAGES) {
    for (const { ref, rel } of pageAssets(page)) {
      assert.ok(fs.existsSync(path.join(ROOT, rel)), `${page} 引用了不存在的资源：${ref}`)
    }
  }
})

test('JS 静态引用的元素 id 必须在对应页面（HTML 或脚本模板）中定义', () => {
  // 可选元素：缺失时代码已做判空
  const optional = new Set(['header-tools', 'toast'])
  for (const page of PAGES.slice(1)) {
    const scripts = pageAssets(page).map(a => a.rel).filter(rel => rel.endsWith('.js'))
    const sources = [read(page), ...scripts.map(read)].join('\n')
    const defined = new Set([...sources.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]))

    for (const rel of scripts) {
      const code = read(rel)
      const refs = [...code.matchAll(/getElementById\('([\w-]+)'\)|\$\('#([\w-]+)'\)/g)].map(m => m[1] || m[2])
      for (const id of unique(refs)) {
        if (optional.has(id)) continue
        assert.ok(defined.has(id), `${rel} 引用了 ${page} 中未定义的 #${id}`)
      }
    }
  }
})

test('CSS 规范：除 base.css 的 [hidden] 规则外禁止使用 !important', () => {
  for (const rel of CSS_FILES) {
    const css = stripCssComments(read(rel))
    const offenders = css.split('\n').filter(line => line.includes('!important'))
    if (rel === 'common/css/base.css') {
      assert.ok(offenders.every(line => /display\s*:\s*none/.test(line)), `${rel} 仅允许 [hidden] 规则使用 !important`)
    } else {
      assert.deepEqual(offenders, [], `${rel} 存在 !important`)
    }
  }
})

test('CSS 规范：不得残留已废弃的 overlay 类', () => {
  const legacy = /\.(?:td-overlay|exp-overlay|modal-overlay|tb-modal-overlay)\b(?!-)/
  for (const rel of CSS_FILES) {
    const css = stripCssComments(read(rel))
    // time-detail-overlay / exp-overlay 仍作为 dialog 的 id 存在，仅禁止作为 class 选择器
    assert.equal(legacy.test(css), false, `${rel} 含已废弃的 overlay 选择器`)
  }
})

test('弹窗契约：每个静态 <dialog> 的 class 在公共基座中有定义', () => {
  const components = stripCssComments(read('common/css/components.css'))
  for (const page of PAGES) {
    for (const match of read(page).matchAll(/<dialog\b[^>]*\bclass="([\w-]+)"/g)) {
      assert.ok(components.includes(`.${match[1]}::backdrop`), `${page} 的 dialog.${match[1]} 缺少基座样式`)
    }
  }
})

test('开发服务器：路径穿越与同前缀兄弟目录均被拒绝，合法文件可解析', () => {
  const { isPathInsideRoot, resolveSafeFilePath } = require('../../scripts/dev-server.js')

  const root = path.resolve('/srv/app')
  assert.equal(isPathInsideRoot(root, path.resolve(root, 'a/b.js')), true)
  assert.equal(isPathInsideRoot(root, root), true)
  assert.equal(isPathInsideRoot(root, path.resolve(root, '../app-secret/x')), false, '同前缀兄弟目录不得放行')
  assert.equal(isPathInsideRoot(root, path.resolve(root, '../../etc/passwd')), false)

  assert.equal(resolveSafeFilePath('/../package.json'), false)
  assert.equal(resolveSafeFilePath('/..%2f..%2fwindows/win.ini'.replace(/%2f/gi, '/')), false)
  assert.equal(resolveSafeFilePath('/.git/config'), false, '点目录（如 .git）不得对外暴露')
  assert.equal(resolveSafeFilePath('/node_modules/package.json'), false, '非运行时开发目录不得对外暴露')
  assert.equal(resolveSafeFilePath('/no-such-file.txt'), null)
  assert.ok(String(resolveSafeFilePath('/')).endsWith('index.html'), '根路径应回退到 index.html')
  assert.ok(String(resolveSafeFilePath('/common/js/core.js')).endsWith('core.js'))
})

test('README 引用的关键路径真实存在，且不引用已移除的目录或测试数据文件', () => {
  const readme = read('README.md')
  // 构建产物（MAERS-QLS.exe 被 .gitignore 忽略，干净检出环境中不存在）只校验 README 提及，不要求文件存在
  const buildArtifacts = new Set(['MAERS-QLS.exe'])
  for (const rel of [
    'MAERS-QLS.exe',
    'scripts/dev-server.js',
    'common/ui/icon.ico',
    'scripts/build-desktop-app.js',
    'package.json',
    'common/js/core.js',
    'tests/helpers/dom.js',
  ]) {
    assert.ok(readme.includes(path.posix.basename(rel)), `README 缺少 ${rel} 的说明`)
    if (!buildArtifacts.has(rel)) assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} 不存在`)
  }
  assert.equal(readme.includes('test-data/'), false)
  assert.equal(readme.includes('test-data-qls.json'), false)
  assert.equal(readme.includes('generate-test-data.js'), false)
  assert.equal(readme.includes('tests/qls.test.js'), false)
})

test('全部项目脚本通过语法检查', () => {
  const scripts = JS_FILES.concat(
    'scripts/dev-server.js', 'scripts/build-desktop-app.js', 'scripts/build-precache.js', 'scripts/build-static.js', 'sw.js', 'precache-manifest.js',
  )
  for (const rel of scripts) {
    assert.doesNotThrow(() => JS_FILES.includes(rel) ? parseModule(read(rel)) : new vm.Script(read(rel), { filename: rel }), `${rel} 存在语法错误`)
  }
})

test('Service Worker 预缓存清单：与磁盘资源一致、资源真实存在且覆盖全部页面引用', () => {
  const { buildManifest, renderManifest } = require('../../scripts/build-precache.js')
  const normalize = (text) => text.replace(/\r\n/g, '\n')

  // 清单由脚本生成：任一运行时资源变化后必须重新执行 npm run build:precache
  assert.equal(
    normalize(read('precache-manifest.js')),
    renderManifest(buildManifest()),
    'precache-manifest.js 已过期，请执行 npm run build:precache',
  )

  const manifest = buildManifest()
  const assets = [...manifest.shell, ...manifest.rest].map(url => url.replace(/^\.\//, ''))
  assert.equal(new Set(assets).size, assets.length, '预缓存清单不应有重复项')
  for (const rel of assets) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `预缓存了不存在的资源：${rel}`)
  }
  assert.ok(manifest.shell.includes('./index.html') && manifest.shell.includes('./common/js/core.js'), '首屏资源应包含门户页与公共底座')
  assert.ok(manifest.rest.every(url => !url.startsWith('./common/')), '公共底座资源必须在首屏组')
  const shellSet = new Set(manifest.shell.map(url => url.replace(/^\.\//, '')))
  for (const { rel } of pageAssets('index.html')) {
    assert.ok(shellSet.has(rel), `门户页引用的 ${rel} 必须在首屏组（install 阶段缓存）`)
  }

  // 每个页面引用的本地资源都必须可离线使用
  const cached = new Set(assets)
  for (const page of PAGES) {
    for (const { rel } of pageAssets(page)) {
      assert.ok(cached.has(rel), `${page} 引用的 ${rel} 未纳入预缓存，离线时会缺失`)
    }
  }

  assert.equal(/PRECACHE_ASSETS/.test(read('sw.js')), false, 'sw.js 不应再手写资源清单')
  assert.match(manifest.version, /^[0-9a-f]{12}$/)
  assert.equal(buildManifest().version, manifest.version, '同一份资源必须得到确定的版本号')
})

test('页面使用单一 ES 模块入口，依赖完整且不存在循环', () => {
  for (const page of PAGES) {
    const html = read(page)
    const entries = [...html.matchAll(/<script type="module" src="([^"]+)"><\/script>/g)]
    assert.equal(entries.length, 1, page + ' 必须只声明一个模块入口')
    assert.equal(/<script defer/.test(html), false, page + ' 不得依赖手写脚本顺序')
    const graph = moduleFiles(ROOT, [path.posix.join(path.posix.dirname(page), entries[0][1])])
    assert.ok(graph.includes('common/js/idb-store.js'), page + ' 必须初始化持久化后端')
    assert.equal(new Set(graph).size, graph.length)
  }
  assert.doesNotThrow(() => moduleFiles(ROOT, JS_FILES))
})

test('内部模块不读取全局业务对象、不继承公共命名空间或导入兼容门面', () => {
  const entries = new Set(['common/js/portal-entry.js', 'MAERS-Schedule/js/entry.js', 'MAERS-QuantiLife/js/entry.js', 'MAERS-QuantiLife/js/report-entry.js'])
  for (const rel of JS_FILES) {
    const code = read(rel)
    if (entries.has(rel)) continue
    assert.equal(/window\.(?:QLS|MS|QL|MAERS_BRIDGE)\b|Object\.create\(/.test(code.replace(/\/\*[\s\S]*?\*\//g, '')), false, rel + ' 不得读取业务全局对象')
    if (rel.endsWith('/api.js') || rel === 'common/js/runtime.js' || rel === 'common/js/facade.js') continue
    assert.equal(/from ['"][^'"]*(?:api|runtime|facade)\.js['"]/.test(code), false, rel + ' 必须直接导入职责模块')
  }
  for (const rel of JS_FILES.filter(f => f.startsWith('common/js/storage/'))) {
    assert.equal(/from ['"][^'"]*bridge[^'"]*['"]|MAERS_BRIDGE/.test(read(rel)), false, rel + ' 不能依赖桥接层')
  }
})

test('解耦约束：桥接数据层不接触 DOM，领域层不再各自实现记录契约，重复规则由公共底座提供', () => {
  const bridge = read('common/js/bridge.js')
  assert.equal(/document\.|innerHTML|insertHTML|setHTML|querySelector/.test(bridge), false, 'bridge.js 应为纯数据层，界面转入 bridge-ui.js')
  const ql = read('MAERS-QuantiLife/js/records.js')
  assert.equal(/QL\.normalizeDayData\s*=\s*\(/.test(ql), false, 'QL 不应重复实现 normalizeDayData')
  const repeat = read('common/js/repeat-rules.js')
  assert.equal(/\.matchesRepeatRule\s*=/.test(repeat), true, '重复规则由公共 repeat-rules.js 统一定义')
  for (const file of ['tags', 'records', 'expectation-store', 'data-transfer', 'time-stats']) {
    assert.equal(/document\.|\.dataset|\bhtml`|setHTML\(/.test(read(`MAERS-QuantiLife/js/${file}.js`)), false,
      `${file}.js 的数据职责不能混入排行界面`)
  }
})

test('模板安全规范：ARIA 布尔状态属性插值必须显式 String() 转换，防止 false 被渲染为空串', () => {
  const bareBoolAria = /aria-(?:checked|selected|expanded|pressed)="\$\{(?!String\()/
  for (const rel of JS_FILES) {
    assert.equal(bareBoolAria.test(read(rel)), false, `${rel} 存在未用 String() 包装的 ARIA 布尔属性插值`)
  }
})

