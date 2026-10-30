import { metadata as svcMetadata } from '../../common/js/core.js'
import { storage as svcStorage } from '../../common/js/store.js'

const svcExpectations = {}
export const expectations = svcExpectations

/** MAERS QuantiLife — 期望值归一化与存取。 */
const store = svcStorage.store

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const nonNegative = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, n) : 0
}

// ── 期望值归一化与存取 ────────────────────────────────
svcExpectations.normalizeExpectations = (data) => {
  if (!isPlainObject(data)) return null
  const rawTime = isPlainObject(data.time) ? data.time : {}
  const time = Object.fromEntries(svcMetadata.TIME_KEYS.map(key => {
    const raw = rawTime[key]
    const category = isPlainObject(raw) ? raw : {}
    const items = Array.isArray(category.items)
      ? category.items.filter(isPlainObject).map(item => ({
          label: typeof item.label === 'string' ? item.label : '',
          hours: nonNegative(item.hours),
        }))
      : []
    return [key, { hours: nonNegative(category.hours), items }]
  }))

  return {
    ...data,
    steps: nonNegative(data.steps),
    sleep: nonNegative(data.sleep),
    water: nonNegative(data.water),
    cal: nonNegative(data.cal),
    mood: svcMetadata.MOOD_META[data.mood] ? data.mood : 'good',
    diet: Array.isArray(data.diet) ? data.diet.filter(isPlainObject).map(svcMetadata.normalizeDietItem) : [],
    time,
  }
}

svcExpectations.loadExpectations = () => svcExpectations.normalizeExpectations(store.get(svcMetadata.EXPECTATIONS_KEY, null)) || svcExpectations.normalizeExpectations({})

svcExpectations.saveExpectations = (exp, options) => {
  const normalized = svcExpectations.normalizeExpectations(exp)
  return normalized ? store.set(svcMetadata.EXPECTATIONS_KEY, normalized, options) : false
}
