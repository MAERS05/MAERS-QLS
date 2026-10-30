import { metadata as svcMetadata } from '../../common/js/core.js'

const svcScheduleMetadata = {}
export const scheduleMetadata = svcScheduleMetadata

/** MAERS Schedule — 领域命名空间与分类、象限、层级元数据。服务由后续脚本挂载。 */
// ── 分类元数据 ────────────────────────────────────────
/** 按分类键取得 { key, color, label }；非法键回退到第一个分类 */
svcScheduleMetadata.categoryMeta = (key) => svcMetadata.CATEGORY_COLORS.find(c => c.key === key) || svcMetadata.CATEGORY_COLORS[0]

// ── 重要紧急程度与时间轴元数据 ────────────────────────
svcScheduleMetadata.QUADRANTS = {
  do:        { label: '重要紧急' },
  delegate:  { label: '不重要紧急' },
  plan:      { label: '重要不紧急' },
  eliminate: { label: '不重要不紧急' },
}
svcScheduleMetadata.QUADRANT_KEYS = Object.keys(svcScheduleMetadata.QUADRANTS)

svcScheduleMetadata.TIERS = {
  short: { label: '短期' },
  mid:   { label: '中期' },
  long:  { label: '长期' },
}
