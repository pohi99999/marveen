// The one way a NEW scheduled task is written and registered (SCHEDCMDAPPROVAL1121). POST /api/schedules and the
// schedule_command consumer (schedule-command-approval.ts) both create through it, like createAgentFromSpec serves the
// dashboard's create and agent_create: the same validation, the same refusal of an existing name, the same write
// (writeScheduledTask) and the same registration of exactly the bytes written (registerScheduledTask with
// noUnwrittenDirFiles). The route's owner gate (OWNEREXEC1109) runs between the two steps and stays in the route.
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import { isValidCronShape } from './cron.js'
import { sanitizeScheduleName } from './sanitize.js'
import { SCHEDULED_TASKS_DIR, MAX_SCHEDULED_TASK_PROMPT_LEN, writeScheduledTask } from './scheduled-tasks-io.js'
import { registerScheduledTask } from './schedule-registry.js'

/** What a create takes: the POST body's fields. command, timeoutMs and failThreshold are written only for a 'command'
 *  task (the route lets one through only for the owner, the consumer only from an approved spec). */
export interface ScheduleCreateData {
  name?: string
  description?: string
  prompt?: string
  schedule?: string
  agent?: string
  type?: string
  skipIfBusy?: boolean
  forceSend?: boolean
  targetSession?: string
  once?: boolean
  command?: string
  timeoutMs?: number
  failThreshold?: number
}

export interface ScheduleCreateResult { status: number; body: Record<string, unknown> }

export interface ValidScheduleCreate { name: string; data: ScheduleCreateData }

/** Step 1: the checks that need nothing but the body, in the order the route has always answered them. */
export function validateScheduleCreate(data: ScheduleCreateData): { ok: true; value: ValidScheduleCreate } | { ok: false; result: ScheduleCreateResult } {
  const bad = (status: number, error: string) => ({ ok: false as const, result: { status, body: { error } } })
  const name = sanitizeScheduleName(typeof data.name === 'string' ? data.name : '')
  if (!name) return bad(400, 'Name is required')
  // A command task runs its command, not a prompt: it needs no prompt when it has a command.
  const commandTask = data.type === 'command' && typeof data.command === 'string' && data.command.trim() !== ''
  const prompt = typeof data.prompt === 'string' ? data.prompt : ''
  if (!commandTask && !prompt.trim()) return bad(400, 'Prompt is required')
  if (prompt.length > MAX_SCHEDULED_TASK_PROMPT_LEN) {
    return bad(413, `Prompt too large (${prompt.length} chars, max ${MAX_SCHEDULED_TASK_PROMPT_LEN})`)
  }
  if (typeof data.schedule !== 'string' || !data.schedule.trim()) return bad(400, 'Schedule is required')
  if (!isValidCronShape(data.schedule)) return bad(400, 'Invalid cron expression')
  if (data.once !== undefined && typeof data.once !== 'boolean') return bad(400, 'once must be true or false')
  return { ok: true, value: { name, data } }
}

/** Step 2: refuse an existing name, write the task, register exactly the bytes written. */
export function writeNewScheduledTask(v: ValidScheduleCreate, source: string): ScheduleCreateResult {
  const { name, data } = v
  if (existsSync(join(SCHEDULED_TASKS_DIR, name))) return { status: 409, body: { error: 'Schedule already exists' } }
  const isCommand = data.type === 'command'
  const written = writeScheduledTask(name, {
    description: data.description || '',
    prompt: (data.prompt ?? '').trim(),
    schedule: data.schedule!.trim(),
    agent: data.agent || MAIN_AGENT_ID,
    enabled: true,
    type: data.type || 'task',
    skipIfBusy: data.skipIfBusy === true,
    forceSend: data.forceSend === true,
    targetSession: data.targetSession || undefined,
    once: data.once,
    ...(isCommand && typeof data.command === 'string' ? { command: data.command } : {}),
    ...(isCommand && typeof data.timeoutMs === 'number' ? { timeoutMs: data.timeoutMs } : {}),
    ...(isCommand && typeof data.failThreshold === 'number' ? { failThreshold: data.failThreshold } : {}),
  })
  // Record the just-written files as trusted: the bytes written, not whatever is on disk a moment later. A create
  // writes only SKILL.md and task-config.json into a dir that did not exist, so any other file there is refused.
  let registered = false
  try {
    registered = Boolean(registerScheduledTask(name, source, written, { noUnwrittenDirFiles: true }))
  } catch (err) {
    logger.error({ err, name }, 'schedule-registry: registration after API write failed')
  }
  if (!registered) {
    return { status: 500, body: { error: 'Schedule written but NOT registered; the runner will not fire it until it is re-saved or re-registered' } }
  }
  logger.info({ name, schedule: data.schedule, once: data.once === true, type: data.type || 'task', source }, 'Scheduled task created')
  return { status: 200, body: { ok: true, name } }
}

/** Both steps, for a caller with no gate in between (the schedule_command consumer). */
export function createScheduledTask(data: ScheduleCreateData, source: string): ScheduleCreateResult {
  const v = validateScheduleCreate(data)
  if (!v.ok) return v.result
  return writeNewScheduledTask(v.value, source)
}
