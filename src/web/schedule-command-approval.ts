// SCHEDCMDAPPROVAL1121 (Péter GO 17598): a scheduled shell command (a 'command' task) created through an approval.
// POST /api/schedules refuses type 'command' without the owner's session (OWNEREXEC1109) and keeps refusing it: the
// fleet shares one bearer token, and a daily shell command created from a hidden instruction would be silent
// persistence. This is the second, approval-gated path, built on the agent_create pattern (agent-create-approval.ts):
//   1. fileScheduleCommandRequest: the MAIN agent files a spec. Only a REQUEST: the server validates the spec
//      (schedule-command-spec.ts), stores it, and opens a schedule_command approval bound to its hash, with the owner's
//      text rendered from the stored spec (the command verbatim) and a Telegram nonce, so the owner can decide with
//      the buttons (the route sends the question). Nothing is created here. A request from any other requester is
//      refused: the name is self-declared on the shared token, so the owner's approval is the real protection, and a
//      sub-agent's own token never reaches the route (agent-token allowlist).
//   2. consumeScheduleCommand, the consumer (registerApprovalConsumer): it runs after the decision committed (the
//      dashboard's PATCH with the shown hash, or the owner's Telegram button with the hash head it carried, both
//      through the decision core). In ONE transaction it consumes the approval (approved -> consumed, the same hash,
//      once), stamps the spec row, and re-checks the stored spec. Only then it creates the task through
//      createScheduledTask, the same code as POST /api/schedules (write + registry). Every outcome is written on the
//      spec row; anything but "created" also goes to the main agent as an alert.
//   3. sweepScheduleCommandOnStart: an approval decided while the consumer could not run is consumed now; a crash
//      between the consume and the outcome is alerted, never re-run.
// On by default (SCHEDULE_COMMAND_VIA_APPROVAL defaults to "on": the owner asked for it); "off" closes the filing route.
import { randomUUID } from 'node:crypto'
import { getDb, createApproval, consumeApproval, registerApprovalConsumer, createAgentMessage, type Approval } from '../db.js'
import { MAIN_AGENT_ID } from '../config.js'
import { logger } from '../logger.js'
import { SCHEDULED_TASKS_DIR } from './scheduled-tasks-io.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  canonicalScheduleCommandSpec, canonicalJson, scheduleSpecHash, renderScheduleCommandSpec, recheckStoredScheduleSpec,
  type ScheduleCommandSpecV1, type RequesterSource,
} from './schedule-command-spec.js'
import { createScheduledTask } from './schedule-create.js'
import { newApprovalNonce } from './telegram-approval.js'

export const SCHEDULE_COMMAND_CATEGORY = 'schedule_command'
/** How long the owner has to decide. Longer than agent_create's hour: the owner decides on Telegram, not at a desk. */
export const SCHEDULE_COMMAND_TIMEOUT_S = 24 * 3600
/** An approved request is consumed within this window of its decision (the start-up sweep's reach included). */
export const SCHEDULE_COMMAND_CONSUME_WINDOW_S = 7 * 86400
/** Only the main agent files, so one cap covers both "per requester" and "in all". */
export const SCHEDULE_COMMAND_MAX_OPEN = 3

/** On when the setting says on. The registry default is "on" (the owner asked for this path), so an install that never
 *  touched it is on; anything but "on" (off, or an unreadable value) keeps the filing route closed. */
export function scheduleCommandViaApprovalOn(setting: (key: string) => string): boolean {
  return String(setting('SCHEDULE_COMMAND_VIA_APPROVAL') ?? '').trim().toLowerCase() === 'on'
}

export interface ScheduleFileResult { status: number; body: Record<string, unknown>; approval?: Approval }

export function fileScheduleCommandRequest(body: unknown, requestedBy: string, deps: { setting: (k: string) => string; lang: 'hu' | 'en'; requesterSource?: RequesterSource }): ScheduleFileResult {
  if (!scheduleCommandViaApprovalOn(deps.setting)) {
    return { status: 403, body: { error: 'Scheduled commands by approval are off (SCHEDULE_COMMAND_VIA_APPROVAL).' } }
  }
  if (requestedBy !== MAIN_AGENT_ID) {
    logger.warn({ requestedBy }, 'schedule_command request refused: only the main agent files one')
    return { status: 403, body: { error: `Only the main agent (${MAIN_AGENT_ID}) may ask for a scheduled command; send the request to it.` } }
  }
  const r = canonicalScheduleCommandSpec(body)
  if (!r.ok) return { status: r.status, body: { error: r.error } }
  if (existsSync(join(SCHEDULED_TASKS_DIR, r.spec.name))) return { status: 409, body: { error: 'Schedule already exists' } }
  const json = canonicalJson(r.spec)
  const hash = scheduleSpecHash(r.spec)
  const text = renderScheduleCommandSpec(r.spec, hash, deps.lang, { name: requestedBy, source: deps.requesterSource ?? 'self-declared' })
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  // The count and the insert in ONE synchronous transaction, nothing awaited in between (the agent_create lesson,
  // Dani 81221): better-sqlite3 runs it to the end, so in this process it is atomic.
  const filed = getDb().transaction((): 'ok' | 'cap' | 'same_name' => {
    const open = getDb().prepare(`
      SELECT s.task_name FROM approvals a JOIN schedule_command_specs s ON s.approval_id = a.id
      WHERE a.category = ? AND a.status = 'pending' AND (a.timeout_at IS NULL OR a.timeout_at > ?)
    `).all(SCHEDULE_COMMAND_CATEGORY, now) as Array<{ task_name: string }>
    if (open.some((o) => o.task_name === r.spec.name)) return 'same_name'
    if (open.length >= SCHEDULE_COMMAND_MAX_OPEN) return 'cap'
    createApproval({
      id, agent_id: requestedBy, category: SCHEDULE_COMMAND_CATEGORY, action_description: text, action_payload: null,
      timeout_at: now + SCHEDULE_COMMAND_TIMEOUT_S, content_hash: hash, owner_nonce: newApprovalNonce(),
    })
    getDb().prepare(`
      INSERT INTO schedule_command_specs (approval_id, spec_json, content_hash, task_name, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, json, hash, r.spec.name, requestedBy, now)
    return 'ok'
  })()
  if (filed === 'same_name') return { status: 409, body: { error: `An open schedule_command request already names ${r.spec.name}; wait for the owner's decision.` } }
  if (filed === 'cap') return { status: 429, body: { error: 'Too many open schedule_command requests; wait for the owner to decide the open ones.' } }
  logger.info({ approvalId: id, requestedBy, name: r.spec.name }, 'schedule_command request filed; waiting for the owner')
  const approval = getDb().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Approval
  return { status: 201, body: { ok: true, approvalId: id, contentHash: hash, text }, approval }
}

interface SpecRow { approval_id: string; spec_json: string; content_hash: string; consumed_at: number | null; outcome: string | null }

function setOutcome(approvalId: string, outcome: string, createdTask: string | null = null): void {
  getDb().prepare('UPDATE schedule_command_specs SET outcome = ?, outcome_at = ?, created_task = COALESCE(?, created_task) WHERE approval_id = ?')
    .run(outcome, Math.floor(Date.now() / 1000), createdTask, approvalId)
}

function alertMain(text: string): void {
  try { createAgentMessage('system', MAIN_AGENT_ID, text) } catch (err) { logger.error({ err }, 'schedule_command alert to the main agent failed') }
}

export type ScheduleConsumeStep = { go: true; spec: ScheduleCommandSpecV1 } | { go: false; reason: string }

/** The transaction: consume, stamp, re-check. Exported for the tests; the consumer and the sweep call it. */
export function consumeScheduleCommandStep(approvalId: string): ScheduleConsumeStep {
  const db = getDb()
  return db.transaction((): ScheduleConsumeStep => {
    const row = db.prepare('SELECT approval_id, spec_json, content_hash, consumed_at, outcome FROM schedule_command_specs WHERE approval_id = ?').get(approvalId) as SpecRow | undefined
    if (!row) return { go: false, reason: 'no_spec' }
    const c = consumeApproval({ id: approvalId, contentHash: row.content_hash, consumer: SCHEDULE_COMMAND_CATEGORY, messageId: approvalId, windowSeconds: SCHEDULE_COMMAND_CONSUME_WINDOW_S, category: SCHEDULE_COMMAND_CATEGORY })
    if (!c.ok) return { go: false, reason: `consume_refused:${c.reason}` }
    const stamped = db.prepare('UPDATE schedule_command_specs SET consumed_at = ? WHERE approval_id = ? AND consumed_at IS NULL').run(Math.floor(Date.now() / 1000), approvalId).changes
    if (stamped !== 1) throw new Error('schedule_command spec already consumed while its approval was not')
    const re = recheckStoredScheduleSpec(row.spec_json, row.content_hash)
    if (!re.ok) {
      setOutcome(approvalId, `refused:${re.reason}`)
      return { go: false, reason: re.reason }
    }
    return { go: true, spec: re.spec }
  })()
}

/** After the consume: the create itself, through POST /api/schedules' own code. Returns when the outcome is written. */
export function createFromConsumed(approvalId: string, spec: ScheduleCommandSpecV1): void {
  try {
    const r = createScheduledTask({
      name: spec.name, description: spec.description, prompt: '', schedule: spec.schedule, agent: spec.agent,
      type: 'command', command: spec.command, timeoutMs: spec.timeout_ms, failThreshold: spec.fail_threshold,
    }, 'approval:schedule_command')
    if (r.status !== 200 || r.body.ok !== true) {
      setOutcome(approvalId, `failed:${r.status}:${String(r.body.error ?? '')}`)
      alertMain(`Az ütemezett parancs jóváhagyott kérése (${approvalId}, ${spec.name}) NEM hozta létre a feladatot: ${r.status} ${String(r.body.error ?? '')}.`)
      return
    }
    setOutcome(approvalId, 'created', spec.name)
    logger.info({ approvalId, name: spec.name }, 'command task created from an approved schedule_command spec')
  } catch (err) {
    setOutcome(approvalId, `failed:exception:${err instanceof Error ? err.message : String(err)}`)
    alertMain(`Az ütemezett parancs jóváhagyott kérése (${approvalId}, ${spec.name}) hibával megállt: ${err instanceof Error ? err.message : String(err)}. Nézd meg, mi jött létre.`)
  }
}

/** The schedule_command consumer: called by the decision core after an approval of this category committed. */
export function consumeScheduleCommand(approval: Approval): void {
  const step = consumeScheduleCommandStep(approval.id)
  if (!step.go) {
    if (!step.reason.startsWith('consume_refused:already_consumed')) {
      // Ellenőr #59 J3: the refusal is written on the spec row, so the start-up sweep does not pick the same request up
      // (and alert) again on every start (an approval past its consume window stays approved and unconsumed).
      if (step.reason.startsWith('consume_refused:')) setOutcome(approval.id, step.reason)
      alertMain(`Az ütemezett parancs jóváhagyott kérése (${approval.id}) nem futott le: ${step.reason}. Semmi nem jött létre.`)
    }
    return
  }
  createFromConsumed(approval.id, step.spec)
}

let registered = false
/** Registers the consumer once (server start). */
export function registerScheduleCommandConsumer(): void {
  if (registered) return
  registerApprovalConsumer(SCHEDULE_COMMAND_CATEGORY, (a) => { consumeScheduleCommand(a) })
  registered = true
}

/**
 * At server start: an approved, unconsumed request (decided while the consumer could not run) is consumed now; one
 * consumed without an outcome (a crash between the consume and the create) is alerted, never re-run.
 */
export function sweepScheduleCommandOnStart(): { consumed: number; interrupted: number } {
  const db = getDb()
  const pending = db.prepare(`
    SELECT a.* FROM approvals a JOIN schedule_command_specs s ON s.approval_id = a.id
    WHERE a.category = ? AND a.status = 'approved' AND a.consumed_at IS NULL AND s.consumed_at IS NULL AND s.outcome IS NULL
  `).all(SCHEDULE_COMMAND_CATEGORY) as Approval[]
  const interrupted = db.prepare(`
    SELECT approval_id FROM schedule_command_specs WHERE consumed_at IS NOT NULL AND outcome IS NULL
  `).all() as Array<{ approval_id: string }>
  for (const r of interrupted) {
    setOutcome(r.approval_id, 'interrupted')
    alertMain(`Az ütemezett parancs jóváhagyott kérése (${r.approval_id}) a fogyasztás után megszakadt (újraindulás). Nem futtatom újra: nézd meg, létrejött-e a feladat, és ha kell, kérd újra.`)
  }
  for (const a of pending) consumeScheduleCommand(a)
  return { consumed: pending.length, interrupted: interrupted.length }
}
