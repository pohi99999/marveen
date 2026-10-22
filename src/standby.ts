// Cold standby (card 3301e6cf). A second machine can carry a full, installed copy
// of the fleet that waits switched OFF: only one machine may poll the Telegram bot
// (a second getUpdates poller steals the updates and both see 409) and only one
// may run the scheduler (every task would fire twice: mail, Telegram, kanban).
//
// The marker is a file, store/.standby, so every entry point can check it the
// same way: the dashboard (scheduler, pollers, monitors, agent auto-start), the
// channels session script, the channel-coordinator and scripts/start.sh. The
// switch-over script creates it on the machine that goes cold and removes it on
// the one that takes over. A machine without the file behaves exactly as before.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'

export const STANDBY_FILE_NAME = '.standby'

export const standbyFile = (storeDir: string = STORE_DIR): string => join(storeDir, STANDBY_FILE_NAME)

export const isStandby = (storeDir: string = STORE_DIR): boolean => existsSync(standbyFile(storeDir))

export const STANDBY_NOTICE =
  '[standby] store/.standby is present: this machine is the COLD STANDBY. The scheduler, the channel ' +
  'pollers and monitors and the agent auto-start are NOT started. Only the switch-over script removes the file.'

/**
 * Whether the dashboard keeps its background services (scheduler, pollers,
 * monitors, tmux manipulation) off: WEB_ONLY=true (staging previews) or the
 * cold-standby marker. `reason` says which, for the boot log line.
 */
export function backgroundServicesOff(
  env: NodeJS.ProcessEnv = process.env,
  storeDir: string = STORE_DIR,
): { off: boolean; reason: 'standby' | 'web-only' | null } {
  if (isStandby(storeDir)) return { off: true, reason: 'standby' }
  if (env['WEB_ONLY'] === 'true') return { off: true, reason: 'web-only' }
  return { off: false, reason: null }
}
