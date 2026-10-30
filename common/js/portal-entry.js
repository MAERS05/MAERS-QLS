import { QLS } from './runtime.js'
import { bridge } from './bridge.js'
import { timerProjection } from './timer-events.js'
import { composeCapabilities } from './facade.js'
import { MS } from '../../MAERS-Schedule/js/api.js'
import { QL } from '../../MAERS-QuantiLife/js/api.js'
import './pwa.js'
import './portal.js'
import './project-guide.js'

// Compatibility/debug entry points; application modules import their services directly.
Object.assign(window, { QLS, MS, QL, MAERS_BRIDGE: composeCapabilities(bridge, timerProjection.timerEvents) })
