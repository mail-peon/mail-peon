import { registerAccountHandlers } from './handlers/accounts'
import { registerMailTypeHandlers } from './handlers/mail-types'
import { registerMailHandlers } from './handlers/mails'
import { registerMetadataHandlers } from './handlers/metadata'
import { registerRuleHandlers } from './handlers/rules'
import { registerSettingsHandlers } from './handlers/settings'
import { registerTrashHandlers } from './handlers/trash'
import { registerBackgroundLifecycle } from './lifecycle'
import { ensureAlarm } from './runtime/maintenance'
import { restartWatchChannels } from './runtime/watch'

/** Register every MV3 listener synchronously before starting asynchronous recovery. */
registerMailHandlers()
registerTrashHandlers()
registerAccountHandlers()
registerRuleHandlers()
registerMailTypeHandlers()
registerSettingsHandlers()
registerMetadataHandlers()
registerBackgroundLifecycle()

// A suspended service worker resumes without onStartup or onInstalled.
void restartWatchChannels()
void ensureAlarm()

if (import.meta.hot) {
  // @ts-expect-error for background HMR
  import('/@vite/client')
  import('./contentScriptHMR')
}
