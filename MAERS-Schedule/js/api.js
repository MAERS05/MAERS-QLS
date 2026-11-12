import { composeCapabilities } from '../../common/js/facade.js'
import { QLS } from '../../common/js/runtime.js'
import { scheduleMetadata } from './shared.js'
import { scheduleModels } from './models.js'
import { search } from './search.js'
import { tasks } from './task-service.js'
import { timeblocks } from './timeblock-service.js'
import { timers } from './timer-service.js'
import { timelineSort } from './timeline-sort.js'
import { scheduleTransfer } from './data-transfer.js'
import { scheduleTags } from './tags.js'

export const MS = composeCapabilities(QLS, scheduleMetadata, scheduleModels, search, tasks, timeblocks, timers, timelineSort, scheduleTransfer, scheduleTags)
