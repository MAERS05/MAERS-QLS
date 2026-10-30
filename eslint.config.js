'use strict'

const js = require('@eslint/js')
const globals = require('globals')

/** 静态检查配置：前端为浏览器脚本，scripts / tests / sw 为 Node 或 Worker 环境 */
module.exports = [
  { ignores: ['node_modules/**', 'coverage/**', 'dist/**', 'precache-manifest.js', 'tests/qls-test-data.json'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      // 脚本内允许以局部变量遮蔽内置全局（如 crypto / open）
      'no-redeclare': ['error', { builtinGlobals: false }],
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    files: ['scripts/**/*.js', 'tests/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.node } },
  },
  {
    files: ['sw.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.serviceworker } },
  },
]
