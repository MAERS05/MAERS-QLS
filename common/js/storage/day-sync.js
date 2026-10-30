import { metadata as svcMetadata } from '../core.js'
import { dates as svcDates } from '../date-utils.js'
import { dayRecords as svcDayRecords } from '../day-record.js'
import { idbMerge as svcIdbMerge } from './merge.js'
import { timerProjection as svcTimerProjection } from '../timer-events.js'

const svcIdbDaySync = {}
export const idbDaySync = svcIdbDaySync

/** MAERS QLS — 日记录与计时任务的事务内合并和同步；通过纯投影模块计算入账。 */
svcIdbDaySync.createDaySync = ({ transaction }) => {
  const { parse, same, mergeValue, mergeRaw } = svcIdbMerge.merge

  let indexedTasksRaw = null
  let indexedTasks = null
  let taskDayIndex = null

  async function commitMutation(key, base, raw, options) {
    let result, mergeError
    try {
      await transaction('readwrite', store => {
        const request = store.get(key)
        const isDay = key.startsWith(svcMetadata.QL_PREFIX) && svcDates.isDateKey(key.slice(svcMetadata.QL_PREFIX.length))
        const tags = isDay ? store.get(svcMetadata.TAGS_KEY) : null
        const tasks = isDay ? store.get(svcMetadata.INPROGRESS_KEY) : null
        const finish = () => {
          try {
            const taskRaw = isDay ? tasks.result?.raw : null
            if (isDay && options?.syncSchedule && taskRaw !== indexedTasksRaw) {
              const nextTasks = parse(taskRaw, null)
              const nextIndex = Array.isArray(nextTasks)
                ? svcTimerProjection.timerEvents.buildTaskDayIndex(nextTasks) : null
              indexedTasks = nextTasks
              taskDayIndex = nextIndex
              indexedTasksRaw = taskRaw
            }
            const list = options?.syncSchedule ? indexedTasks : null
            const rebuildSync = options?.syncSchedule && Array.isArray(list)
            const dayRecord = isDay && raw != null && Array.isArray(parse(raw, null)?.timeEvents)
            const editable = source => {
              let data = parse(source, undefined)
              if (dayRecord) data = svcDayRecords.normalizeDayData(data || svcDayRecords.createEmptyDay(key.slice(svcMetadata.QL_PREFIX.length)))
              if (isDay && Array.isArray(data?.timeEvents)) {
                delete data.time
                if (rebuildSync) data.timeEvents = data.timeEvents.filter(event => !event._isSync)
              }
              return data
            }
            // 桥接删除的含义是清理同步事件，不能删掉并发新增的手动记录或其他任务事件。
            const clearSync = isDay && options?.syncSchedule && raw == null
            let data = mergeValue(editable(base), editable(clearSync ? base : raw), editable(request.result?.raw))
            if (clearSync && data === undefined) data = svcDayRecords.createEmptyDay(key.slice(svcMetadata.QL_PREFIX.length))
            if (isDay && Array.isArray(data?.timeEvents)) {
              // 派生值不参与冲突判断，使用同一事务中的最新任务和标签重新计算。
              if (rebuildSync) data.timeEvents.push(...svcTimerProjection.timerEvents.sliceParallelTasksToEvents(list, data.date, taskDayIndex))
              data.time = svcDayRecords.computeTimeTotals(data.timeEvents, parse(tags.result?.raw, {}))
            }
            if (rebuildSync && svcDayRecords.isDayDataEmpty(data)) data = undefined
            result = data === undefined ? null : JSON.stringify(data)
            if (result == null) store.delete(key)
            else store.put({ key, raw: result })
          } catch (err) {
            mergeError = err
            store.transaction.abort()
          }
        }
        if (isDay) tasks.onsuccess = finish
        else request.onsuccess = finish
      })
    } catch (err) { throw mergeError || err }
    return result
  }

  /** 在调用者的事务中更新所有受影响日期，供普通写入、导入和清除共用。 */
  function writeScheduleDays(store, previous, list, tags, changes, replacements = new Map()) {
    const projection = svcTimerProjection.timerEvents
    const dates = new Set()
    const byId = value => new Map((Array.isArray(value) ? value : [])
      .filter(task => task && typeof task === 'object').map(task => [task.id, task]))
    const before = byId(previous), after = byId(list)
    new Set([...before.keys(), ...after.keys()]).forEach(id => {
      if (same(before.get(id), after.get(id))) return
      ;[before.get(id), after.get(id)].filter(Boolean).forEach(task => {
        projection.extractTaskDayIntervals(task).forEach(interval => dates.add(interval.dateStr))
      })
    })
    replacements.forEach((_, key) => {
      if (key.startsWith(svcMetadata.QL_PREFIX) && svcDates.isDateKey(key.slice(svcMetadata.QL_PREFIX.length))) dates.add(key.slice(svcMetadata.QL_PREFIX.length))
    })
    const sourceIds = new Set([...before.keys(), ...after.keys()])
    const index = dates.size ? projection.buildTaskDayIndex(list) : null
    dates.forEach(date => {
      const key = svcMetadata.QL_PREFIX + date
      const request = store.get(key)
      request.onsuccess = () => {
        try {
          let raw = replacements.has(key) ? replacements.get(key) : request.result?.raw
          if (raw !== null) {
            const day = svcDayRecords.normalizeDayData(parse(raw, null), date) || svcDayRecords.createEmptyDay(date)
            day.timeEvents = day.timeEvents.filter(event => !event._isSync ||
              !(sourceIds.has(event._syncId) || event._syncTaskIds?.some(id => sourceIds.has(id))))
            day.timeEvents.push(...projection.sliceParallelTasksToEvents(list, date, index))
            day.time = svcDayRecords.computeTimeTotals(day.timeEvents, tags)
            raw = svcDayRecords.isDayDataEmpty(day) ? null : JSON.stringify(day)
          }
          changes.set(key, raw)
          if (raw == null) store.delete(key)
          else store.put({ key, raw })
        } catch (err) {
          console.error('[QLS] 日记录事务失败:', err)
          store.transaction.abort()
        }
      }
    })
  }

  /** 任务与其派生日记录必须在同一事务内提交。 */
  async function commitScheduleMutation(base, raw) {
    const changes = new Map()
    let failure
    try {
      await transaction('readwrite', store => {
        const tasks = store.get(svcMetadata.INPROGRESS_KEY)
        const tags = store.get(svcMetadata.TAGS_KEY)
        tags.onsuccess = () => {
          try {
            const saved = mergeRaw(base, raw, tasks.result?.raw)
            changes.set(svcMetadata.INPROGRESS_KEY, saved)
            if (saved == null) store.delete(svcMetadata.INPROGRESS_KEY)
            else store.put({ key: svcMetadata.INPROGRESS_KEY, raw: saved })
            writeScheduleDays(store, parse(tasks.result?.raw, []), parse(saved, []), parse(tags.result?.raw, {}), changes)
          } catch (err) { failure = err; store.transaction.abort() }
        }
      })
    } catch (err) { throw failure || err }
    return changes
  }

  return { commitMutation, commitScheduleMutation, writeScheduleDays }
}
