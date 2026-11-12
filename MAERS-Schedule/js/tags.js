import { tagRepository as svcTagRepository } from '../../common/js/tag-store.js'

const svcScheduleTags = {}
export const scheduleTags = svcScheduleTags

/** MAERS Schedule — 通过桥接层读取与注册分类标签。 */
// ── 标签与分类服务（通过 MAERS_BRIDGE 联动）────────────
svcScheduleTags.getCategoryTags = (catKey) => {
  const allTags = svcTagRepository.tagStore.load()
  return Object.keys(allTags).filter(t => allTags[t] === catKey)
}

svcScheduleTags.registerNewTag = (tag, catKey) => {
  if (!tag || !catKey) return false
  const tags = svcTagRepository.tagStore.load()
  if (tags[tag]) return false
  tags[tag] = catKey
  return svcTagRepository.tagStore.save(tags)
}
