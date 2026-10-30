import { composeCapabilities } from './facade.js'
import { metadata } from './core.js'
import { dom } from './dom.js'
import { localStorageModule } from './store-local.js'
import { storage } from './store.js'
import { dates } from './date-utils.js'
import { repeatRules } from './repeat-rules.js'
import { ui } from './ui.js'
import { jsonTransfer } from './json-transfer.js'
import { dayRecords } from './day-record.js'
import { calendarPicker } from './calendar-picker.js'
import { wheelPicker } from './wheel-picker.js'
import { timerProjection } from './timer-events.js'
import { tagRepository } from './tag-store.js'
import { storageState } from './idb-store.js'
import { theme } from './theme.js'

export const QLS = composeCapabilities(metadata, dom, localStorageModule, storage, dates, repeatRules, ui, jsonTransfer, dayRecords, calendarPicker, wheelPicker, timerProjection, tagRepository, storageState, theme)

storageState.onStorageReady(() => theme.applyTheme())
