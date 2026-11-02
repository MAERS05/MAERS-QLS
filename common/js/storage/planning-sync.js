import { metadata as svcMetadata } from '../core.js'
import { planningTemplates as svcPlanningTemplates } from '../planning-templates.js'
import { idbMerge as svcIdbMerge } from './merge.js'

const svcIdbPlanningSync = {}
export const idbPlanningSync = svcIdbPlanningSync

/** 自定义时间表和量化时间分配期望在同一事务中提交。 */
svcIdbPlanningSync.createPlanningSync = ({ transaction }) => {
  const { parse, mergeRaw } = svcIdbMerge.merge

  function writeExpectations(store, before, after, current, changes) {
    if (!svcPlanningTemplates.changed(before, after)) return
    const raw = JSON.stringify(svcPlanningTemplates.expectations(after, current))
    store.put({ key: svcMetadata.EXPECTATIONS_KEY, raw })
    changes.set(svcMetadata.EXPECTATIONS_KEY, raw)
  }

  async function commitPlanningMutation(base, raw) {
    const changes = new Map()
    let failure
    try {
      await transaction('readwrite', store => {
        const blocks = store.get(svcMetadata.TIMEBLOCK_KEY)
        const expectations = store.get(svcMetadata.EXPECTATIONS_KEY)
        expectations.onsuccess = () => {
          try {
            const latest = blocks.result?.raw
            const saved = mergeRaw(base, raw, latest)
            if (saved == null) store.delete(svcMetadata.TIMEBLOCK_KEY)
            else store.put({ key: svcMetadata.TIMEBLOCK_KEY, raw: saved })
            changes.set(svcMetadata.TIMEBLOCK_KEY, saved)
            writeExpectations(store, parse(latest, null), parse(saved, null), parse(expectations.result?.raw, {}), changes)
          } catch (err) { failure = err; store.transaction.abort() }
        }
      })
    } catch (err) { throw failure || err }
    return changes
  }

  return { commitPlanningMutation, writeExpectations }
}
