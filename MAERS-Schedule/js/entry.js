import { QLS } from '../../common/js/runtime.js'
import { composeCapabilities } from '../../common/js/facade.js'
import { bridge } from '../../common/js/bridge.js'
import { bridgeUI } from '../../common/js/bridge-ui.js'
import { timerProjection } from '../../common/js/timer-events.js'
import { MS } from './api.js'
import { scheduleApp } from './app.js'
import { timeline } from './timeline.js'
import { timeblockView } from './timeblock.js'
import { timerView } from './in-progress.js'
import { widgets } from './widgets.js'
import '../../common/js/pwa.js'

Object.assign(window, { QLS, MS: composeCapabilities(MS, scheduleApp, timeline, timeblockView, timerView, widgets),
  MAERS_BRIDGE: composeCapabilities(bridge, timerProjection.timerEvents), MAERS_BRIDGE_UI: bridgeUI })
