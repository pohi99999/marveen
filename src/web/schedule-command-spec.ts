// SCHEDCMDAPPROVAL1121: the spec behind a schedule_command approval. The main agent files a REQUEST for a scheduled
// shell command (a 'command' task: the dashboard starts it with `bash -lc` as its own detached child process, outside every
// tool hook, on every tick of its cron); nothing is created until the owner approves it and the server's consumer
// runs. The owner approves what the server stored, so the stored spec is canonical, versioned and hashed, the same
// way as agent-create-spec.ts:
//   - the request is validated before anything is stored: an unknown field, a wrong type, a name that is not already
//     a task name, a cron the scheduler refuses, a command or description with a line break, a control or an
//     invisible (format) character, or a value out of range is answered with 400, and no approval is asked for;
//   - the canonical object is the ONE source of both the owner's text and the hash: every hashed field is a line of
//     the text, and the command is shown verbatim, on its own line. A line break or an invisible character could make
//     the shown command differ from the one that runs (a bidi override, a zero-width space, a second line dressed as
//     another field), so the spec refuses them instead of escaping them;
//   - the fields are exactly the ones a command task's task-config.json carries for its run (scheduled-tasks-io.ts,
//     command-task.ts): schedule, command, timeoutMs, failThreshold and description, plus the task name. The defaults
//     the runner would apply (10 s, 2 failures) are written into the spec, so the owner sees the values that run.
//     The agent is the main agent (a command task's agent only labels its runs), and nothing else is settable.
import { createHash } from 'node:crypto'
import { MAIN_AGENT_ID } from '../config.js'
import { isValidCronShape } from './cron.js'
import { sanitizeScheduleName } from './sanitize.js'

export const SCHEDULE_COMMAND_SPEC_VERSION = 1
/** The runner's own defaults (command-task.ts runCommandTask), made explicit in the spec. */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000
export const DEFAULT_COMMAND_FAIL_THRESHOLD = 2
export const MAX_COMMAND_TIMEOUT_MS = 3_600_000
export const MIN_COMMAND_TIMEOUT_MS = 1_000
export const MAX_COMMAND_FAIL_THRESHOLD = 100
export const MAX_COMMAND_LEN = 2_000
export const MAX_DESCRIPTION_LEN = 500
export const MAX_TASK_NAME_LEN = 64

export interface ScheduleCommandSpecV1 {
  spec_version: 1
  name: string
  description: string
  schedule: string
  command: string
  timeout_ms: number
  fail_threshold: number
  agent: string
}

export type ScheduleSpecResult = { ok: true; spec: ScheduleCommandSpecV1 } | { ok: false; status: number; error: string }

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')
const TOP_KEYS = new Set(['spec_version', 'name', 'description', 'schedule', 'command', 'timeoutMs', 'failThreshold'])
const bad = (error: string, status = 400): ScheduleSpecResult => ({ ok: false, status, error })
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
// C0 and C1 controls (line breaks and tabs included), DEL, and every Unicode format character (bidi controls,
// zero-width characters, the BOM, soft hyphen): none of them may be in a text the owner reads as the thing that runs.
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f\p{Cf}\u2028\u2029]/u

/** Why a text cannot be shown verbatim on one line, or null when it can. */
export function unshowableText(s: string): string | null {
  const m = UNSHOWABLE.exec(s)
  if (!m) return null
  return `U+${m[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
}

function wholeIn(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
}

/** The request body -> the canonical spec, or the refusal. Pure: whether the name is taken is the caller's check. */
export function canonicalScheduleCommandSpec(body: unknown): ScheduleSpecResult {
  if (!isObj(body)) return bad('the spec must be a JSON object')
  const extra = Object.keys(body).find((k) => !TOP_KEYS.has(k))
  if (extra !== undefined) return bad(`unknown field: ${extra}`)
  if (body.spec_version !== SCHEDULE_COMMAND_SPEC_VERSION) return bad(`spec_version must be ${SCHEDULE_COMMAND_SPEC_VERSION}`)
  for (const k of ['name', 'schedule', 'command'] as const) if (typeof body[k] !== 'string') return bad(`${k} must be a string`)
  if (body.description !== undefined && typeof body.description !== 'string') return bad('description must be a string')

  const name = body.name as string
  if (!name || name.length > MAX_TASK_NAME_LEN || sanitizeScheduleName(name) !== name) {
    return bad(`name must be a task name: 1-${MAX_TASK_NAME_LEN} lower-case letters, digits and single dashes, as it will be created`)
  }
  const schedule = body.schedule as string
  if (schedule !== schedule.trim() || !schedule || unshowableText(schedule) !== null || !isValidCronShape(schedule)) {
    return bad('schedule must be a valid five- or six-field cron expression (six: with seconds first), without leading or trailing spaces')
  }
  // Marveen 8586 (Ellenőr: "15<NBSP>7 * * *" was accepted): the cron is printable ASCII too, the same rule as the
  // command, so the schedule the owner reads is the one the runner parses.
  const sa = /[^\x20-\x7e]/u.exec(schedule)
  if (sa) return bad(`schedule must be printable ASCII only (U+${sa[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} is not)`)
  const command = body.command as string
  if (!command.trim()) return bad('command must not be empty')
  if (command !== command.trim()) return bad('command must not start or end with whitespace (it is shown verbatim)')
  if (command.length > MAX_COMMAND_LEN) return bad(`command too long (max ${MAX_COMMAND_LEN} characters)`)
  const cu = unshowableText(command)
  if (cu !== null) return bad(`command contains a character that cannot be shown verbatim on one line (${cu}); write it on one line, with ; or && between the steps`)
  // Ellenőr #59 J2: a look-alike letter (Cyrillic a, Greek o), a no-break or ideographic space, a Hangul filler or a
  // variation selector is not a format character, yet it makes the command the owner reads differ from the one bash
  // runs (a host name that only looks the same, an NBSP bash does not split on). The command is printable ASCII only.
  const na = /[^\x20-\x7e]/u.exec(command)
  if (na) return bad(`command must be printable ASCII only (U+${na[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')} is not): a look-alike character would make the command shown differ from the command run`)
  const description = typeof body.description === 'string' ? body.description : ''
  if (description.length > MAX_DESCRIPTION_LEN) return bad(`description too long (max ${MAX_DESCRIPTION_LEN} characters)`)
  const du = unshowableText(description)
  if (du !== null) return bad(`description contains a character that cannot be shown on one line (${du})`)

  const timeoutMs = body.timeoutMs === undefined ? DEFAULT_COMMAND_TIMEOUT_MS : body.timeoutMs
  if (!wholeIn(timeoutMs, MIN_COMMAND_TIMEOUT_MS, MAX_COMMAND_TIMEOUT_MS)) {
    return bad(`timeoutMs must be a whole number of milliseconds between ${MIN_COMMAND_TIMEOUT_MS} and ${MAX_COMMAND_TIMEOUT_MS}`)
  }
  const failThreshold = body.failThreshold === undefined ? DEFAULT_COMMAND_FAIL_THRESHOLD : body.failThreshold
  if (!wholeIn(failThreshold, 1, MAX_COMMAND_FAIL_THRESHOLD)) {
    return bad(`failThreshold must be a whole number between 1 and ${MAX_COMMAND_FAIL_THRESHOLD}`)
  }
  return {
    ok: true,
    spec: { spec_version: 1, name, description, schedule, command, timeout_ms: timeoutMs, fail_threshold: failThreshold, agent: MAIN_AGENT_ID },
  }
}

/** Sorted keys at every level, no whitespace: one byte string per spec (the same rule as agent-create-spec.ts). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export function scheduleSpecHash(spec: ScheduleCommandSpecV1): string {
  return sha256(canonicalJson(spec))
}

/** How many hex characters of the hash the owner's text shows; the Telegram buttons carry the same head. */
export const CHECK_CODE_LEN = 10

/**
 * The owner's text, rendered from the canonical spec and nothing else. Every hashed field is a line; the command is
 * its own line, verbatim (the spec guarantees it is one line of showable characters).
 */
/** Who asked, as the server knows it: an agent's own token names it, the shared token only claims it (Ellenőr #59 J1). */
export type RequesterSource = 'agent-token' | 'self-declared'

export function renderScheduleCommandSpec(spec: ScheduleCommandSpecV1, hash: string, lang: 'hu' | 'en', requester?: { name: string; source: RequesterSource }): string {
  const hu = lang === 'hu'
  return [
    hu ? 'Ütemezett shell-parancs létrehozása, jóváhagyásra:' : 'Create a scheduled shell command, for approval:',
    hu
      ? 'A parancsot a dashboard indítja, külön folyamatként (bash -lc), minden eszköz-kapun kívül, az ütemezés minden alkalmával, amíg ki nem kapcsolod vagy nem törlöd.'
      : 'The dashboard starts the command as its own process (bash -lc), outside every tool gate, on every occurrence of the schedule, until it is switched off or deleted.',
    `- ${hu ? 'feladat neve' : 'task name'}: ${spec.name}`,
    `- ${hu ? 'ütemezés (cron)' : 'schedule (cron)'}: ${spec.schedule}`,
    `- ${hu ? 'parancs, szó szerint (a következő sor)' : 'command, verbatim (the next line)'}:`,
    spec.command,
    `- ${hu ? 'időkorlát' : 'timeout'}: ${spec.timeout_ms} ms`,
    `- ${hu ? 'riasztás ennyi egymás utáni hiba után' : 'alert after this many failures in a row'}: ${spec.fail_threshold}`,
    `- ${hu ? 'leírás' : 'description'}: ${spec.description || (hu ? '(nincs)' : '(none)')}`,
    `- ${hu ? 'ügynök (a futások címkéje)' : 'agent (labels the runs)'}: ${spec.agent}`,
    ...(requester
      ? [`- ${hu ? 'kérő' : 'requested by'}: ${requester.name} (${requester.source === 'agent-token'
        ? (hu ? 'saját tokennel azonosítva' : 'identified by its own token')
        : (hu ? 'a közös tokennel, ÖNBEVALLOTT név: bármelyik ügynök írhatta, csak a jóváhagyásod véd' : 'on the shared token, a SELF-DECLARED name: any agent could have written it, only your approval protects')})`]
      : []),
    `- ${hu ? 'spec-verzió' : 'spec version'}: ${spec.spec_version}`,
    `- ${hu ? 'ellenőrző kód' : 'check code'}: ${hash.slice(0, CHECK_CODE_LEN)}`,
  ].join('\n')
}

/** The consumer's re-check: the stored JSON is canonical, hashes to the approved hash, and is still a valid spec. */
export function recheckStoredScheduleSpec(specJson: string, approvedHash: string): { ok: true; spec: ScheduleCommandSpecV1 } | { ok: false; reason: string } {
  let spec: ScheduleCommandSpecV1
  try { spec = JSON.parse(specJson) as ScheduleCommandSpecV1 } catch { return { ok: false, reason: 'spec_unreadable' } }
  if (!isObj(spec) || canonicalJson(spec) !== specJson) return { ok: false, reason: 'spec_not_canonical' }
  if (sha256(specJson) !== approvedHash) return { ok: false, reason: 'hash_mismatch' }
  if (spec.spec_version !== SCHEDULE_COMMAND_SPEC_VERSION) return { ok: false, reason: 'spec_version' }
  // The stored object must still be exactly what the request validation produces from its own fields.
  const again = canonicalScheduleCommandSpec({
    spec_version: spec.spec_version, name: spec.name, description: spec.description, schedule: spec.schedule,
    command: spec.command, timeoutMs: spec.timeout_ms, failThreshold: spec.fail_threshold,
  })
  if (!again.ok || canonicalJson(again.spec) !== specJson) return { ok: false, reason: 'spec_invalid' }
  return { ok: true, spec }
}
