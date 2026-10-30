import { composeCapabilities } from '../../common/js/facade.js'
import { QLS } from '../../common/js/runtime.js'
import { quantiTags } from './tags.js'
import { records } from './records.js'
import { expectations } from './expectation-store.js'
import { quantiTransfer } from './data-transfer.js'
import { timeStats } from './time-stats.js'
import { rankView } from './rank-view.js'

export const QL = composeCapabilities(QLS, quantiTags, records, expectations, quantiTransfer, timeStats, rankView)
