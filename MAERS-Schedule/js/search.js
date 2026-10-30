const svcSearch = {}
export const search = svcSearch

/** MAERS Schedule — 拼音首字母检索工具。 */
// ── 拼音首字母检索工具 ────────────────────────────────
const PY_INITIALS = 'abcdefghjklmnopqrstwxyz'.split('')
const PY_BOUNDS   = '啊芭擦搭蛾发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝'.split('')
svcSearch.getPinyinInitials = (str) => {
  let result = ''
  for (const char of String(str || '')) {
    if (/[a-zA-Z0-9]/.test(char)) {
      result += char.toLowerCase()
      continue
    }
    let found = false
    for (let j = PY_BOUNDS.length - 1; j >= 0; j--) {
      if (char.localeCompare(PY_BOUNDS[j], 'zh-CN') >= 0) {
        result += PY_INITIALS[j]
        found = true
        break
      }
    }
    if (!found) result += char
  }
  return result
}
