import { scheduleModels as svcScheduleModels } from './models.js'
import { metadata as svcMetadata } from '../../common/js/core.js'
import { dates as svcDates } from '../../common/js/date-utils.js'
import { storage as svcStorage } from '../../common/js/store.js'

const svcTasks = {}
export const tasks = svcTasks

/** MAERS Schedule — 任务、长期愿景的存取、编辑与状态流转。 */
const store = svcStorage.store
const { normalizeTaskObject, normalizeGoalObject } = svcScheduleModels.models

function readArray(key) {
  const list = store.get(key, [])
  return Array.isArray(list) ? list : []
}

svcTasks.loadTasks = () => readArray(svcMetadata.TASKS_KEY).map(normalizeTaskObject).filter(Boolean)

svcTasks.saveTasks = (tasks, options) => {
  return store.set(svcMetadata.TASKS_KEY, (Array.isArray(tasks) ? tasks : []).map(normalizeTaskObject).filter(Boolean), options)
}

svcTasks.loadGoals = () => readArray(svcMetadata.GOALS_KEY).map(normalizeGoalObject).filter(Boolean)

svcTasks.saveGoals = (goals, options) => {
  return store.set(svcMetadata.GOALS_KEY, (Array.isArray(goals) ? goals : []).map(normalizeGoalObject).filter(Boolean), options)
}

/** 弹窗展示值与保存基线必须来自同一份已提交快照。 */
svcTasks.loadEditorSnapshot = (isGoal = false) => {
  const base = store.getCommitted(isGoal ? svcMetadata.GOALS_KEY : svcMetadata.TASKS_KEY, null)
  const normalize = isGoal ? normalizeGoalObject : normalizeTaskObject
  return { base, items: (Array.isArray(base) ? base : []).map(normalize).filter(Boolean) }
}

// ── 任务与愿景业务流转 ────────────────────────────────
svcTasks.getTaskOrGoal = (id) => {
  if (!id) return null
  const task = svcTasks.loadTasks().find(t => t.id === id)
  if (task) return { ...task, isGoal: false }
  const goal = svcTasks.loadGoals().find(g => g.id === id)
  return goal ? { ...goal, isGoal: true } : null
}

svcTasks.toggleTaskStatus = (taskId) => {
  const tasks = svcTasks.loadTasks()
  const task = tasks.find(t => t.id === taskId)
  if (!task) return null
  task.status = task.status === 'done' ? 'active' : 'done'
  svcTasks.saveTasks(tasks)
  return task
}

svcTasks.toggleSubtask = (taskId, subtaskIdx) => {
  const tasks = svcTasks.loadTasks()
  const task = tasks.find(t => t.id === taskId)
  if (!task || task.subtasks[subtaskIdx] === undefined) return null
  task.subtasks[subtaskIdx].done = !task.subtasks[subtaskIdx].done
  svcTasks.saveTasks(tasks)
  return task
}

svcTasks.saveTaskOrGoal = (data, options) => {
  const isGoal = !!(data.isGoal || data.tier === 'long')
  const hasBase = options && Object.hasOwn(options, 'base')
  const original = hasBase && Array.isArray(options.base) ? JSON.parse(JSON.stringify(options.base)) : []
  if (isGoal) {
    const goals = hasBase ? original.map(normalizeGoalObject).filter(Boolean) : svcTasks.loadGoals()
    const existing = data.id ? goals.find(g => g.id === data.id) : null
    if (existing) {
      existing.title = data.title
      existing.notes = data.notes || ''
      return svcTasks.saveGoals(goals, options) ? existing : null
    }
    const newGoal = { id: data.id || svcMetadata.uid('g_'), title: data.title, notes: data.notes || '' }
    goals.push(newGoal)
    return svcTasks.saveGoals(goals, options) ? newGoal : null
  }

  const tasks = hasBase ? original.map(normalizeTaskObject).filter(Boolean) : svcTasks.loadTasks()
  const idx = data.id ? tasks.findIndex(t => t.id === data.id) : -1
  if (idx !== -1) {
    const prev = tasks[idx]
    tasks[idx] = {
      ...prev,
      title: data.title,
      quadrant: data.quadrant || prev.quadrant || 'do',
      tier: data.tier === 'mid' ? 'mid' : 'short',
      startDate: data.startDate ?? prev.startDate ?? '',
      deadline: data.deadline ?? prev.deadline ?? '',
      notes: data.notes ?? prev.notes ?? '',
      subtasks: data.subtasks || prev.subtasks || [],
    }
    return svcTasks.saveTasks(tasks, options) ? tasks[idx] : null
  }

  const newTask = {
    id: data.id || svcMetadata.uid(),
    title: data.title,
    status: 'active',
    quadrant: data.quadrant || 'do',
    tier: data.tier === 'mid' ? 'mid' : 'short',
    startDate: data.startDate || '',
    deadline: data.deadline || '',
    notes: data.notes || '',
    subtasks: data.subtasks || [],
    created: svcDates.today(),
  }
  tasks.push(newTask)
  return svcTasks.saveTasks(tasks, options) ? newTask : null
}

svcTasks.deleteTaskOrGoal = (id) => {
  if (!id) return false
  const tasks = svcTasks.loadTasks()
  if (tasks.some(t => t.id === id)) {
    svcTasks.saveTasks(tasks.filter(t => t.id !== id))
    return true
  }
  const goals = svcTasks.loadGoals()
  if (goals.some(g => g.id === id)) {
    svcTasks.saveGoals(goals.filter(g => g.id !== id))
    return true
  }
  return false
}
