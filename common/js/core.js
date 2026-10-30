const svcMetadata = {}
export const metadata = svcMetadata

/** MAERS QLS — 命名空间、存储键、领域元数据与基础数值契约。公共能力由后续脚本挂载。 */
// ── 1. 存储键契约 ────────────────────────────────────
svcMetadata.THEME_KEY = 'qls_theme'
svcMetadata.QL_PREFIX = 'quantilife_'
svcMetadata.MS_PREFIX = 'schedule_'
svcMetadata.TAGS_KEY = 'quantilife_tags'
svcMetadata.EXPECTATIONS_KEY = 'quantilife_expectations'
svcMetadata.TIMEBLOCK_KEY = 'schedule_timeblocks'
svcMetadata.INPROGRESS_KEY = 'schedule_inprogress'
svcMetadata.TASKS_KEY = 'schedule_tasks'
svcMetadata.GOALS_KEY = 'schedule_goals'
svcMetadata.TIMELINE_SORT_KEY = 'schedule_timeline_sort'
svcMetadata.TB_STEP_KEY = 'schedule_tb_step'
svcMetadata.TB_STEPS = Object.freeze([1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30])
// 单项计时最多覆盖一年；防止异常备份触发无界日期展开。
svcMetadata.MAX_TIMER_HOURS = 24 * 366
svcMetadata.SCH_ENTRY_KEY = 'schedule_entry_view'
svcMetadata.QL_ENTRY_KEY = 'quantilife_entry_page'
svcMetadata.BRIDGE_VIEWED_PREFIX = 'ql_bridge_last_viewed_'
svcMetadata.REPORT_STATE_KEY = 'ql_report_state'
svcMetadata.LAST_EXPORT_KEY = 'qls_last_exported_at'
/** 桥接层同步或刷新某日 QuantiLife 摘要后发出的页面事件，detail 为 { dateStr } */
svcMetadata.BRIDGE_CHANGED_EVENT = 'maers:bridge-changed'

// 备份信封标识与版本：导出文件统一携带，导入时据此校验
svcMetadata.BACKUP_APP = 'MAERS-QLS'
svcMetadata.BACKUP_VERSION = 1
/**
 * 本地数据 schema 版本号：每次数据结构变更时递增。
 * idb-store.js 在初始化时读取 IDB 中已存储的 schema 版本，
 * 若低于当前值则依次执行增量迁移函数 SCHEMA_MIGRATIONS[v]。
 */
svcMetadata.SCHEMA_VERSION = 2
svcMetadata.MAX_IMPORT_BYTES = 10 * 1024 * 1024
// 保守地按主流浏览器约 5 MB 的 localStorage 配额预检；实际写入仍由浏览器最终裁定。
svcMetadata.LOCAL_STORAGE_BUDGET_BYTES = 5 * 1024 * 1024

// ── 2. 唯一时间分类元数据（Single Source of Truth）──────
svcMetadata.TIME_META = {
  basic: { label: '基本生活类', icon: 'ui/basic.svg', color: '#4979d3' }, // 静谧灰蓝
  health: { label: '身心维护类', icon: 'ui/health.svg', color: '#52a477' }, // 柔和草木绿（提亮一度）
  learn: { label: '学习内养类', icon: 'ui/learn.svg', color: '#7371c0' }, // 沿用娱乐消遣色
  career: { label: '事业发展类', icon: 'ui/career.svg', color: '#d58b34' }, // 芥末琥珀
  social: { label: '人际交往类', icon: 'ui/social.svg', color: '#c15374' }, // 干燥玫瑰
  entertainment: { label: '娱乐消遣类', icon: 'ui/entertainment.svg', color: '#78cdd1' }, // 清透青蓝
  waste: { label: '无效损耗类', icon: 'ui/waste.svg', color: '#817c6b' }, // 微暖中性灰
}
svcMetadata.TIME_KEYS = Object.keys(svcMetadata.TIME_META)

// 自动派生颜色与分类双向映射，杜绝多处手动同步
svcMetadata.CATEGORY_COLORS = svcMetadata.TIME_KEYS.map(key => ({
  key,
  color: svcMetadata.TIME_META[key].color,
  label: svcMetadata.TIME_META[key].label.replace('类', ''),
}))

/** 由分类键派生展示颜色（颜色是纯展示属性，任何持久化数据都只保存分类键） */
svcMetadata.categoryColor = (key) => (svcMetadata.TIME_META[key] || svcMetadata.TIME_META.basic).color

/**
 * schema v1 以颜色值标识分类。仅供 schema 迁移与旧备份导入使用：
 * 含当前调色板与已废弃的历史色值（health 曾为 #449167）。
 */
const LEGACY_COLOR_TO_CATEGORY = {
  ...Object.fromEntries(svcMetadata.TIME_KEYS.map(key => [svcMetadata.TIME_META[key].color, key])),
  '#449167': 'health',
}
svcMetadata.categoryFromLegacyColor = (color) => LEGACY_COLOR_TO_CATEGORY[String(color || '').trim().toLowerCase()] || null

/** 解析合法分类键：优先使用 category，其次兼容旧色值，均无效时回退 basic */
svcMetadata.normalizeCategoryKey = (category, legacyColor) =>
  (svcMetadata.TIME_META[category] ? category : svcMetadata.categoryFromLegacyColor(legacyColor) || svcMetadata.TIME_KEYS[0])

/** 返回去除旧 color 字段、补全 category 的浅拷贝（schema v1 → v2 的单条记录转换） */
svcMetadata.stripLegacyColor = (obj) => {
  const { color, ...rest } = obj
  return { ...rest, category: svcMetadata.normalizeCategoryKey(obj.category, color) }
}


/**
 * 统一解析标签或旧版分类键所属的 7 大分类 key
 * 匹配顺序：1. 用户标签库 tagMap；2. 分类 key 本身；3. 分类中文名称（含/不含「类」字）
 */
svcMetadata.resolveTagCategory = (tag, tagMap = {}) => {
  if (!tag) return null
  if (tagMap[tag] && svcMetadata.TIME_META[tagMap[tag]]) return tagMap[tag]
  if (svcMetadata.TIME_META[tag]) return tag
  for (const k of svcMetadata.TIME_KEYS) {
    const lbl = svcMetadata.TIME_META[k].label
    if (tag === lbl || tag === lbl.replace('类', '')) return k
  }
  return null
}

// ── 3. 心情与图表配色元数据 ─────────────────────────────
svcMetadata.MOOD_META = {
  great: { icon: '../MAERS-QuantiLife/ui/great.svg', label: '2', score: 2 },
  good: { icon: '../MAERS-QuantiLife/ui/good.svg', label: '1', score: 1 },
  okay: { icon: '../MAERS-QuantiLife/ui/okay.svg', label: '0', score: 0 },
  bad: { icon: '../MAERS-QuantiLife/ui/bad.svg', label: '-1', score: -1 },
  terrible: { icon: '../MAERS-QuantiLife/ui/terrible.svg', label: '-2', score: -2 },
}
svcMetadata.MOOD_KEYS = Object.keys(svcMetadata.MOOD_META)

svcMetadata.CHART_COLORS = {
  steps: '#d58b34', // 芥末琥珀（与事业发展类一致）
  sleep: '#4b8b8b', // 灰调青绿
  water: '#527cca', // 静谧灰蓝
  cal: '#d67252', // 明快暖棕橙
  carb: '#a09b8f', // 明亮暖碳灰（提亮一度）
  protein: '#6baee6', // 沉稳天蓝（压暗一度，白底更清晰）
  fat: '#db9337', // 明亮金琥珀
  mood: '#b85c78', // 干燥玫瑰
}

/**
 * 生成浏览器端实体 ID。优先使用加密随机源，避免同一毫秒内连续创建时发生碰撞。
 * 保留时间戳以便本地备份数据仍具可读性。
 */
svcMetadata.uid = (prefix = 't_') => {
  const random = window.crypto?.randomUUID
    ? window.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14)
  return `${prefix}${Date.now()}_${random}`
}

svcMetadata.num = (v, dp = 1) => (v == null ? '–' : Number(v).toFixed(dp))
svcMetadata.pct = (v, total) => (total > 0 ? ((v / total) * 100).toFixed(1) : '0')
svcMetadata.clamp = (v, min, max) => Math.max(min, Math.min(max, v))

// ── 10. 数据模型规范化契约 ─────────────────────────────
/** 规范化饮食条目 */
svcMetadata.normalizeDietItem = (item = {}) => ({
  name: String(item.name || ''),
  carb: Number(item.carb ?? 0) || 0,
  protein: Number(item.protein ?? 0) || 0,
  fat: Number(item.fat ?? 0) || 0,
  cal: Number(item.cal ?? 0) || 0,
})
