import { tagRepository as svcTagRepository } from '../../common/js/tag-store.js'

const svcQuantiTags = {}
export const quantiTags = svcQuantiTags

/** MAERS QuantiLife — 标签仓库的领域接口，无独立可变缓存。 */
svcQuantiTags.loadTags = () => svcTagRepository.tagStore.load()
svcQuantiTags.saveTag = (tag, category) => svcTagRepository.tagStore.register(tag, category)
svcQuantiTags.deleteTag = tag => svcTagRepository.tagStore.remove(tag)
svcQuantiTags.resolveTagCategory = tag => svcTagRepository.tagStore.resolve(tag)
svcQuantiTags.normalizeTags = tags => svcTagRepository.tagStore.normalize(tags)
Object.defineProperty(svcQuantiTags, 'TAG_META', { enumerable: true, get: () => svcTagRepository.tagStore.load() })
