import { metadata as svcMetadata } from './core.js'
import { storage as svcStorage } from './store.js'

const svcTagRepository = {}
export const tagRepository = svcTagRepository

/** MAERS QLS — 两个子系统共用的标签仓库；缓存由存储版本控制。 */
let version, cached = {}
function normalize(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).flatMap(([name, category]) => {
    const tag = name.trim()
    return tag && svcMetadata.TIME_META[category] ? [[tag, category]] : []
  }))
}
function currentTags() {
  const next = svcStorage.store.version(svcMetadata.TAGS_KEY)
  if (next !== version) {
    cached = normalize(svcStorage.store.get(svcMetadata.TAGS_KEY, {}))
    version = next
  }
  return cached
}
const tagStore = {
  normalize,
  load() {
    return { ...currentTags() }
  },
  save(tags, options) {
    if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return false
    return svcStorage.store.set(svcMetadata.TAGS_KEY, normalize(tags), options)
  },
  register(tag, category) {
    const name = String(tag || '').trim()
    if (!name || !svcMetadata.TIME_META[category]) return false
    return this.save({ ...this.load(), [name]: category })
  },
  remove(tag) {
    const tags = this.load()
    delete tags[tag]
    return this.save(tags)
  },
  resolve(tag) { return svcMetadata.resolveTagCategory(tag, currentTags()) },
}
svcTagRepository.tagStore = tagStore
