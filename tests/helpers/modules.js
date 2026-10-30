/** Synchronous ES-module graph for jsdom; E2E exercises the native browser loader. */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { pathToFileURL } = require('node:url')
const { parse } = require('espree')

const parseModule = source => parse(source, { ecmaVersion: 'latest', sourceType: 'module', range: true })
const moduleImports = source => parseModule(source).body.filter(n => n.type === 'ImportDeclaration').map(n => n.source.value)

function resolveImport(root, importer, specifier) {
  if (!specifier.startsWith('.')) throw new Error(`Only local module imports are supported: ${specifier}`)
  const file = path.resolve(path.dirname(importer), specifier)
  const relative = path.relative(root, file)
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Module import escapes the workspace')
  return file
}

function moduleFiles(root, entries) {
  const result = [], active = new Set(), done = new Set()
  function visit(file) {
    if (active.has(file)) throw new Error(`Circular module dependency: ${path.relative(root, file)}`)
    if (done.has(file)) return
    active.add(file)
    for (const specifier of moduleImports(fs.readFileSync(file, 'utf8'))) visit(resolveImport(root, file, specifier))
    active.delete(file)
    done.add(file)
    result.push(path.relative(root, file).replace(/\\/g, '/'))
  }
  entries.forEach(file => visit(path.resolve(root, file)))
  return result
}

function createModuleLoader(root, context) {
  const cache = new Map(), active = new Set()
  function load(file) {
    const abs = path.resolve(root, file)
    if (active.has(abs)) throw new Error(`Circular module dependency: ${file}`)
    if (cache.has(abs)) return cache.get(abs)
    active.add(abs)
    let source = fs.readFileSync(abs, 'utf8')
    const ast = parseModule(source), imports = [], replacements = [], exported = []
    for (const node of ast.body) {
      if (node.type === 'ImportDeclaration') {
        const index = imports.push(load(resolveImport(root, abs, node.source.value))) - 1
        const bindings = node.specifiers.map(spec => {
          if (spec.type !== 'ImportSpecifier') throw new Error('The jsdom loader expects named imports')
          if (!Object.hasOwn(imports[index], spec.imported.name)) throw new SyntaxError(`Missing export ${spec.imported.name} in ${node.source.value}`)
          return `${spec.imported.name}: ${spec.local.name}`
        }).join(', ')
        replacements.push({ range: node.range, text: bindings ? `const { ${bindings} } = __imports[${index}]` : '' })
      } else if (node.type === 'ExportNamedDeclaration') {
        if (!node.declaration) throw new Error('The jsdom loader expects exported declarations')
        const declaration = node.declaration
        replacements.push({ range: [node.range[0], declaration.range[0]], text: '' })
        if (declaration.type === 'VariableDeclaration') exported.push(...declaration.declarations.map(d => d.id.name))
        else exported.push(declaration.id.name)
      }
    }
    function meta(node) {
      if (!node || typeof node !== 'object') return
      if (node.type === 'MetaProperty') replacements.push({ range: node.range, text: '__meta' })
      for (const [key, value] of Object.entries(node)) {
        if (key === 'range') continue
        if (Array.isArray(value)) value.forEach(meta)
        else if (value && typeof value === 'object') meta(value)
      }
    }
    meta(ast)
    for (const change of replacements.sort((a,b) => b.range[0] - a.range[0])) source = source.slice(0, change.range[0]) + change.text + source.slice(change.range[1])
    const exports = {}
    const expose = exported.map(name => `Object.defineProperty(__exports, '${name}', { enumerable: true, get: () => ${name} })`).join('\n')
    const evaluate = new vm.Script(`(function (__imports, __exports, __meta) {\n'use strict'\n${source}\n${expose}\n})`, { filename: pathToFileURL(abs).href }).runInContext(context)
    evaluate(imports, exports, { url: pathToFileURL(abs).href })
    active.delete(abs)
    cache.set(abs, exports)
    return exports
  }
  return { load }
}

module.exports = { parseModule, moduleImports, moduleFiles, createModuleLoader }
