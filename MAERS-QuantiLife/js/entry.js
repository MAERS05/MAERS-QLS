import { QLS } from '../../common/js/runtime.js'
import { composeCapabilities } from '../../common/js/facade.js'
import { QL } from './api.js'
import { quantiApp } from './app.js'
import { dietView } from './diet.js'
import { timeDetail } from './time-detail.js'
import { expectationView } from './expectations.js'
import '../../common/js/pwa.js'

Object.assign(window, { QLS, QL: composeCapabilities(QL, quantiApp, dietView, timeDetail, expectationView) })
