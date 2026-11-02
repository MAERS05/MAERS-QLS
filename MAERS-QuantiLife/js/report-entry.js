import { QLS } from '../../common/js/runtime.js'
import { composeCapabilities } from '../../common/js/facade.js'
import { QL } from './api.js'
import { report } from './report.js'
import { chart } from './chart.js'
import { reportAggregator } from './report-aggregator.js'
import '../../common/js/pwa.js'

Object.assign(window, { QLS, QL: composeCapabilities(QL, report, chart, reportAggregator) })
