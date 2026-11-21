// SCHEDCMDAPPROVAL1121 (Péter GO 17598): a scheduled shell command through a schedule_command approval, end to end at
// the server, with negative controls. Mirrors agent-create-approval.test.ts:
//   - the direct path stays refused (POST /api/schedules type command without the owner's session: 403, nothing written);
//   - a requester other than the main agent is refused, and no approval is opened;
//   - a filed request is an approval bound to the spec hash, the owner's text has the command verbatim, the Telegram
//     message carries buttons with the hash head, and NO task exists yet;
//   - the owner's approval (dashboard with the shown hash, or the Telegram button with the hash head it carries)
//     creates exactly the stored spec, through POST /api/schedules' own write + registry, once;
//   - a wrong or missing hash, a changed spec, a typed /approvals command: nothing created;
//   - the start-up sweep.
// SANDBOX: HOME is a temporary directory before the task store is imported (SCHEDULED_TASKS_DIR is fixed at import),
// PROJECT_ROOT and STORE_DIR are temporary, the DB is in memory, and every Telegram call is a recorder.
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const h = vi.hoisted(() => ({
  root: '',
  alerts: [] as string[],
  settings: { SCHEDULE_COMMAND_VIA_APPROVAL: 'on' } as Record<string, string>,
  telegramSends: [] as unknown[][],
}))
const tmpHome = mkdtempSync(join(tmpdir(), 'sched-cmd-appr-home-'))
h.root = mkdtempSync(join(tmpdir(), 'sched-cmd-appr-root-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome
afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
  rmSync(h.root, { recursive: true, force: true })
})

vi.mock('../config.js', async (orig) => {
  const real = await orig<typeof import('../config.js')>()
  return {
    ...real,
    MAIN_AGENT_ID: 'marveen',
    PROJECT_ROOT: h.root,
    STORE_DIR: `${h.root}/store-dir`,
    CHANNEL_PROVIDER: 'telegram',
    TELEGRAM_BOT_TOKEN: 'tg-test-token',
  }
})
vi.mock('../notify.js', async (orig) => ({
  ...(await orig<typeof import('../notify.js')>()),
  sendOwnerSlackDm: async () => ({ attempted: false, sent: false }),
  sendOwnerMessage: async () => ({ sent: false, reason: 'no-token' }),
}))
vi.mock('../web/telegram.js', async (orig) => ({
  ...(await orig<typeof import('../web/telegram.js')>()),
  sendTelegramMessage: async (...args: unknown[]) => { h.telegramSends.push(args); return 4242 },
  editTelegramMessageText: async () => true,
  answerTelegramCallbackQuery: async () => true,
}))
vi.mock('../owner-chat.js', async (orig) => ({
  ...(await orig<typeof import('../owner-chat.js')>()),
  resolveOwnerChatId: () => '777001',
  ownerAlertChatOverride: () => null,
}))
vi.mock('../settings-store.js', async (orig) => ({ ...(await orig<typeof import('../settings-store.js')>()), getEffectiveSettingValue: (k: string) => h.settings[k] ?? '' }))
vi.mock('../db.js', async (orig) => {
  const real = await orig<typeof import('../db.js')>()
  return { ...real, createAgentMessage: (_f: string, _t: string, text: string) => { h.alerts.push(text); return 0 as never } }
})

const db = await import('../db.js')
const io = await import('../web/scheduled-tasks-io.js')
const { verifyScheduledTask } = await import('../web/schedule-registry.js')
const { tryHandleApprovals, applyOwnerDecision } = await import('../web/routes/approvals.js')
const { tryHandleSchedules } = await import('../web/routes/schedules.js')
const { pollApprovalCallbacks } = await import('../web/approval-callbacks.js')
const { buildCallbackData, parseCallbackData } = await import('../web/telegram-approval.js')
const { canonicalJson } = await import('../web/schedule-command-spec.js')
const { registerScheduleCommandConsumer, sweepScheduleCommandOnStart, consumeScheduleCommand } = await import('../web/schedule-command-approval.js')
const { SETTINGS_REGISTRY } = await import('../config-registry.js')
registerScheduleCommandConsumer()

if (!io.SCHEDULED_TASKS_DIR.startsWith(tmpHome)) throw new Error('refusing to run: the task store is not under the temporary HOME')

const OWNER_TG = '777001'
const CMD = `cd '/tmp/x y' && curl -fsS "https://example.invalid/ping?a=1&b=2" | grep -q ok; echo $((1+1)) > /dev/null`
const SPEC = { spec_version: 1, name: 'napi-ping', description: 'Napi elérhetőség-próba', schedule: '15 7 * * *', command: CMD, timeoutMs: 30000, failThreshold: 3 }
const MAIN = { kind: 'token', agent: 'marveen' }
const SESSION = { kind: 'session', user: 'owner' }

async function call(handler: (ctx: any) => Promise<boolean>, method: string, path: string, body: unknown, auth: Record<string, unknown>) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = { 'content-type': 'application/json', 'x-agent-id': String((auth as { agent?: string }).agent ?? 'unknown') }
  const out = { status: 200, body: null as any }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) { try { out.body = JSON.parse(c) } catch { out.body = c } } } }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await handler({ req, res, path, method, url, auth, fedPeer: null })).toBe(true)
  return out
}
const fileSpec = (body: unknown = SPEC, auth: Record<string, unknown> = MAIN) => call(tryHandleApprovals, 'POST', '/api/schedule-command-specs', body, auth)
const patch = (id: string, data: Record<string, unknown>, auth: Record<string, unknown>) => call(tryHandleApprovals, 'PATCH', `/api/approvals/${id}`, data, auth)
const specRow = (id: string) => db.getDb().prepare('SELECT * FROM schedule_command_specs WHERE approval_id = ?').get(id) as Record<string, any> | undefined
const taskDir = (n: string) => join(io.SCHEDULED_TASKS_DIR, n)
const cfgText = (n: string) => readFileSync(join(taskDir(n), 'task-config.json'), 'utf-8')
const scheduleApprovals = () => db.listApprovals({ category: 'schedule_command' })
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  db.initDatabase(':memory:')
  rmSync(io.SCHEDULED_TASKS_DIR, { recursive: true, force: true })
  mkdirSync(io.SCHEDULED_TASKS_DIR, { recursive: true })
  h.alerts.length = 0
  h.telegramSends.length = 0
  h.settings = { SCHEDULE_COMMAND_VIA_APPROVAL: 'on' }
})

/** The task as the runner will read it, checked field by field against the spec. */
function expectCreatedExactly(name = SPEC.name) {
  const t = io.readScheduledTask(name)!
  expect(t).not.toBeNull()
  expect({ type: t.type, schedule: t.schedule, command: t.command, timeoutMs: t.timeoutMs, failThreshold: t.failThreshold, description: t.description, agent: t.agent, enabled: t.enabled })
    .toEqual({ type: 'command', schedule: SPEC.schedule, command: SPEC.command, timeoutMs: SPEC.timeoutMs, failThreshold: SPEC.failThreshold, description: SPEC.description, agent: 'marveen', enabled: true })
  expect(verifyScheduledTask(t)).toEqual({ ok: true })
}

describe('1. the direct path stays refused (OWNEREXEC1109)', () => {
  it.each([
    ['no command field', { name: 'kozvetlen', type: 'command', prompt: 'p', schedule: '0 8 * * *' }],
    ['with the command itself', { name: 'kozvetlen', type: 'command', command: 'echo pwned', schedule: '0 8 * * *' }],
  ])('POST /api/schedules type command with the shared token (%s): 403, nothing written', async (_l, body) => {
    const r = await call(tryHandleSchedules, 'POST', '/api/schedules', body, MAIN)
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('owner_session_required')
    expect(existsSync(taskDir('kozvetlen'))).toBe(false)
  })

  it('the owner session creates a command task through the same shared create, with the command written', async () => {
    const r = await call(tryHandleSchedules, 'POST', '/api/schedules', { name: 'gazda-cmd', type: 'command', command: 'true', timeoutMs: 5000, schedule: '0 8 * * *' }, SESSION)
    expect(r).toEqual({ status: 200, body: { ok: true, name: 'gazda-cmd' } })
    const t = io.readScheduledTask('gazda-cmd')!
    expect([t.type, t.command, t.timeoutMs]).toEqual(['command', 'true', 5000])
    expect(verifyScheduledTask(t)).toEqual({ ok: true })
  })

  it('a prompt task on the shared token still works, and an existing name is 409', async () => {
    const body = { name: 'sima', prompt: 'p', schedule: '0 8 * * *' }
    expect((await call(tryHandleSchedules, 'POST', '/api/schedules', body, MAIN)).status).toBe(200)
    expect((await call(tryHandleSchedules, 'POST', '/api/schedules', body, MAIN)).status).toBe(409)
  })
})

describe('2. only the main agent files a request', () => {
  it.each([
    ['the shared token claiming a sub-agent', { kind: 'token', agent: 'kenshin' }],
    ['a sub-agent\'s own token claiming the main agent', { kind: 'token', agent: 'marveen', tokenAgent: 'kenshin' }],
    ['the shared token with no claim', { kind: 'token' }],
  ])('%s: 403, no approval opened, no spec stored', async (_l, auth) => {
    const r = await fileSpec(SPEC, auth)
    expect(r.status).toBe(403)
    expect(scheduleApprovals()).toEqual([])
    expect(db.getDb().prepare('SELECT COUNT(*) AS n FROM schedule_command_specs').get()).toEqual({ n: 0 })
    expect(h.telegramSends).toEqual([])
  })

  it('the setting off: 403 even for the main agent; the registry default is on', async () => {
    h.settings.SCHEDULE_COMMAND_VIA_APPROVAL = 'off'
    expect((await fileSpec()).status).toBe(403)
    expect(scheduleApprovals()).toEqual([])
    expect(SETTINGS_REGISTRY.find((d) => d.key === 'SCHEDULE_COMMAND_VIA_APPROVAL')?.default).toBe('on')
  })

  it('POST /api/approvals cannot open a schedule_command row without a spec', async () => {
    const r = await call(tryHandleApprovals, 'POST', '/api/approvals', { agent_id: 'marveen', category: 'schedule_command', action_description: 'x', content_hash: 'a'.repeat(64) }, MAIN)
    expect(r.status).toBe(403)
    expect(scheduleApprovals()).toEqual([])
  })
})

describe('the spec is checked before anything is stored', () => {
  it.each([
    ['an unknown field', { ...SPEC, preCheck: 'x.sh' }, 'unknown field: preCheck'],
    ['a line break in the command', { ...SPEC, command: 'true\n- timeout: 1 ms' }, 'U+000A'],
    ['a bidi override in the command', { ...SPEC, command: 'echo safe\u202e;rm -rf ~' }, 'U+202E'],
    ['a zero-width space', { ...SPEC, command: 'ec\u200bho' }, 'U+200B'],
    ['a name that is not a task name', { ...SPEC, name: 'Napi Ping' }, 'name must be a task name'],
    ['a bad cron', { ...SPEC, schedule: '61 7 * * *' }, 'schedule must be'],
    ['a timeout out of range', { ...SPEC, timeoutMs: 999 }, 'timeoutMs'],
    ['a non-integer fail threshold', { ...SPEC, failThreshold: 1.5 }, 'failThreshold'],
    ['a description with a line break', { ...SPEC, description: 'a\nname: masik' }, 'U+000A'],
  ])('%s: 400, nothing stored', async (_l, body, msg) => {
    const r = await fileSpec(body)
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toContain(msg)
    expect(scheduleApprovals()).toEqual([])
  })

  it('an existing task name: 409; an open request for the same name: 409; more than three open: 429', async () => {
    mkdirSync(taskDir('mar-van'), { recursive: true })
    expect((await fileSpec({ ...SPEC, name: 'mar-van' })).status).toBe(409)
    expect((await fileSpec()).status).toBe(201)
    expect((await fileSpec()).status).toBe(409)
    expect((await fileSpec({ ...SPEC, name: 'masodik' })).status).toBe(201)
    expect((await fileSpec({ ...SPEC, name: 'harmadik' })).status).toBe(201)
    expect((await fileSpec({ ...SPEC, name: 'negyedik' })).status).toBe(429)
    expect(scheduleApprovals()).toHaveLength(3)
  })
})

describe('3. a filed request: an approval bound to the spec hash, the command verbatim, no task yet', () => {
  it('201; content_hash = sha256 of the stored canonical spec; the text has the command as its own line; Telegram buttons carry the hash head', async () => {
    const r = await fileSpec()
    expect(r.status).toBe(201)
    const a = db.getApproval(r.body.approvalId)!
    const row = specRow(a.id)!
    expect([a.category, a.status, a.agent_id]).toEqual(['schedule_command', 'pending', 'marveen'])
    expect(a.content_hash).toBe(r.body.contentHash)
    expect(row.content_hash).toBe(a.content_hash)
    expect(createHash('sha256').update(row.spec_json, 'utf8').digest('hex')).toBe(a.content_hash)
    expect(JSON.parse(row.spec_json)).toEqual({ spec_version: 1, name: SPEC.name, description: SPEC.description, schedule: SPEC.schedule, command: CMD, timeout_ms: 30000, fail_threshold: 3, agent: 'marveen' })
    expect(canonicalJson(JSON.parse(row.spec_json))).toBe(row.spec_json)
    expect(a.action_description).toBe(r.body.text)
    expect(a.action_description.split('\n')).toContain(CMD)
    expect(a.action_description).toContain(`ellenőrző kód: ${a.content_hash!.slice(0, 10)}`)
    expect(r.body).not.toHaveProperty('owner_nonce')
    await settle()
    // the owner's Telegram message: the server-rendered text and the two buttons with this request's hash head
    expect(h.telegramSends).toHaveLength(1)
    const [, chat, text, extra] = h.telegramSends[0] as [string, string, string, any]
    expect(chat).toBe('777001')
    expect(text).toContain(a.action_description)
    const datas = extra.reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data)
    expect(datas.map((d: string) => parseCallbackData(d))).toEqual([
      { approvalId: a.id, nonce: a.owner_nonce, decision: 'approved', hashHead: a.content_hash!.slice(0, 10) },
      { approvalId: a.id, nonce: a.owner_nonce, decision: 'rejected', hashHead: a.content_hash!.slice(0, 10) },
    ])
    for (const d of datas) expect(Buffer.byteLength(d)).toBeLessThanOrEqual(64)
    expect(existsSync(taskDir(SPEC.name))).toBe(false)
    expect(h.alerts).toEqual([])
  })

  it('defaults are written into the spec: the runner\'s 10 s and 2 failures, shown to the owner', async () => {
    const { timeoutMs: _t, failThreshold: _f, ...noDefaults } = SPEC
    const r = await fileSpec(noDefaults)
    expect(r.status).toBe(201)
    expect(JSON.parse(specRow(r.body.approvalId)!.spec_json)).toMatchObject({ timeout_ms: 10000, fail_threshold: 2 })
    expect(r.body.text).toContain('időkorlát: 10000 ms')
  })
})

describe('4. approved with the right hash: exactly the stored spec, created once', () => {
  it('the owner session on the dashboard: created through the shared create, registered, consumed once', async () => {
    const { body } = await fileSpec()
    const r = await patch(body.approvalId, { status: 'approved', resolved_by: 'dashboard', content_hash: body.contentHash }, SESSION)
    expect(r.status).toBe(200)
    expect([r.body.status, r.body.resolved_by, r.body.owner_nonce]).toEqual(['approved', 'dashboard_owner', null])
    await settle()
    expectCreatedExactly()
    expect(specRow(body.approvalId)).toMatchObject({ outcome: 'created', created_task: SPEC.name })
    const a = db.getApproval(body.approvalId)!
    expect([a.consumed_by, a.consumed_ref]).toEqual(['schedule_command', body.approvalId])
    expect(h.alerts).toEqual([])
    // a second consume: nothing new, nothing rewritten, no alert
    const before = cfgText(SPEC.name)
    consumeScheduleCommand(db.getApproval(body.approvalId)!)
    expect(cfgText(SPEC.name)).toBe(before)
    expect(specRow(body.approvalId)!.outcome).toBe('created')
    expect(h.alerts).toEqual([])
    expect(sweepScheduleCommandOnStart()).toEqual({ consumed: 0, interrupted: 0 })
  })

  it('the generic consume route cannot spend the approval (the server consumes it on its own path)', async () => {
    const { body } = await fileSpec()
    db.getDb().prepare("UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_by = 'x' WHERE id = ?").run(Math.floor(Date.now() / 1000), body.approvalId)
    const r = db.consumeCategoryApproval({ id: body.approvalId, category: 'schedule_command', contentHash: body.contentHash, consumer: 'tool', windowSeconds: 600 })
    expect([r.ok, r.reason]).toEqual([false, 'wrong_category'])
  })
})

describe('5. a changed payload or a wrong hash: nothing created', () => {
  it('the dashboard without the hash: 400; with another hash: 409 content_changed; nothing decided', async () => {
    const { body } = await fileSpec()
    expect((await patch(body.approvalId, { status: 'approved', resolved_by: 'dashboard' }, SESSION)).status).toBe(400)
    expect(await patch(body.approvalId, { status: 'approved', resolved_by: 'dashboard', content_hash: 'e'.repeat(64) }, SESSION))
      .toEqual({ status: 409, body: { error: 'Not approved: content_changed' } })
    await settle()
    expect(db.getApproval(body.approvalId)!.status).toBe('pending')
    expect(existsSync(taskDir(SPEC.name))).toBe(false)
  })

  it('the shared token cannot approve, not even with the right hash', async () => {
    const { body } = await fileSpec()
    expect((await patch(body.approvalId, { status: 'approved', resolved_by: 'x', content_hash: body.contentHash }, MAIN)).status).toBe(403)
    await settle()
    expect(db.getApproval(body.approvalId)!.status).toBe('pending')
    expect(existsSync(taskDir(SPEC.name))).toBe(false)
  })

  it('the stored spec swapped after filing (another command): approved, consumed, refused hash_mismatch, nothing created, alerted', async () => {
    const { body } = await fileSpec()
    db.getDb().prepare("UPDATE schedule_command_specs SET spec_json = replace(spec_json, 'grep -q ok', 'sh -c evil') WHERE approval_id = ?").run(body.approvalId)
    await patch(body.approvalId, { status: 'approved', resolved_by: 'dashboard', content_hash: body.contentHash }, SESSION)
    await settle()
    expect(existsSync(taskDir(SPEC.name))).toBe(false)
    expect(specRow(body.approvalId)!.outcome).toBe('refused:hash_mismatch')
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).toContain('hash_mismatch')
  })

  it('a rejection creates nothing', async () => {
    const { body } = await fileSpec()
    expect((await patch(body.approvalId, { status: 'rejected', resolved_by: 'dashboard' }, MAIN)).status).toBe(200)
    await settle()
    expect(existsSync(taskDir(SPEC.name))).toBe(false)
    expect(specRow(body.approvalId)!.consumed_at).toBeNull()
  })
})

describe('6. the owner\'s Telegram button: the same hash binding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sched-cmd-apr-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  let n = 0
  /** One press as the plugin records it, through the real watcher and its real default apply. */
  async function press(data: string, fromId: number | string = OWNER_TG) {
    n += 1
    const file = join(dir, `cb-${n}.jsonl`)
    writeFileSync(file, JSON.stringify({ data, from_id: fromId }) + '\n')
    const [o] = await pollApprovalCallbacks(file, OWNER_TG, join(dir, `off-${n}.json`))
    return o
  }

  it('the Jóváhagyom button of the message the server sent: approved through the core, the task created exactly', async () => {
    const { body } = await fileSpec()
    await settle()
    const [, , , extra] = h.telegramSends[0] as [string, string, string, any]
    const approveData = extra.reply_markup.inline_keyboard[0][0].callback_data as string
    expect(await press(approveData)).toMatchObject({ outcome: 'approved' })
    const a = db.getApproval(body.approvalId)!
    expect([a.status, a.resolved_by, a.consumed_by]).toEqual(['approved', 'telegram-owner', 'schedule_command'])
    expectCreatedExactly()
    expect(specRow(body.approvalId)!.outcome).toBe('created')
    // a second press: already resolved, nothing new
    const before = cfgText(SPEC.name)
    expect(await press(approveData)).toMatchObject({ outcome: 'refused', reason: 'already_resolved' })
    expect(cfgText(SPEC.name)).toBe(before)
  })

  it('a press without the hash head, or with another head: content_changed, nothing decided or created', async () => {
    const { body } = await fileSpec()
    const a = db.getApproval(body.approvalId)!
    expect(await press(buildCallbackData(a.id, a.owner_nonce!, 'approved'))).toMatchObject({ outcome: 'refused', reason: 'content_changed' })
    expect(await press(buildCallbackData(a.id, a.owner_nonce!, 'approved', 'f'.repeat(10)))).toMatchObject({ outcome: 'refused', reason: 'content_changed' })
    expect(await press(buildCallbackData(a.id, a.owner_nonce!, 'approved', a.content_hash!.slice(0, 6)))).toMatchObject({ outcome: 'refused', reason: 'content_changed' })
    expect(db.getApproval(a.id)!.status).toBe('pending')
    expect(existsSync(taskDir(SPEC.name))).toBe(false)
  })

  it('a wrong nonce, a foreign Telegram user: nothing decided', async () => {
    const { body } = await fileSpec()
    const a = db.getApproval(body.approvalId)!
    const head = a.content_hash!.slice(0, 10)
    expect(await press(buildCallbackData(a.id, 'wrongNON', 'approved', head))).toMatchObject({ outcome: 'refused', reason: 'wrong_nonce' })
    expect(await press(buildCallbackData(a.id, a.owner_nonce!, 'approved', head), 42)).toMatchObject({ outcome: 'refused', reason: 'not-owner' })
    expect(db.getApproval(a.id)!.status).toBe('pending')
    expect(existsSync(taskDir(SPEC.name))).toBe(false)
  })

  it('the typed /approvals command cannot decide it (button only), not even with the nonce', async () => {
    const { body } = await fileSpec()
    const a = db.getApproval(body.approvalId)!
    expect(applyOwnerDecision(a.id, a.owner_nonce!, 'approved', undefined, 'command')).toMatchObject({ ok: false, reason: 'button_only' })
    expect(db.getApproval(a.id)!.status).toBe('pending')
    expect(existsSync(taskDir(SPEC.name))).toBe(false)
  })

  it('the Elutasítom button rejects, nothing created', async () => {
    const { body } = await fileSpec()
    await settle()
    const [, , , extra] = h.telegramSends[0] as [string, string, string, any]
    expect(await press(extra.reply_markup.inline_keyboard[0][1].callback_data)).toMatchObject({ outcome: 'rejected' })
    expect(db.getApproval(body.approvalId)!.status).toBe('rejected')
    expect(existsSync(taskDir(SPEC.name))).toBe(false)
  })

  it('an expired request is not approved by its button', async () => {
    const { body } = await fileSpec()
    const a = db.getApproval(body.approvalId)!
    db.getDb().prepare('UPDATE approvals SET timeout_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000) - 1, a.id)
    expect(await press(buildCallbackData(a.id, a.owner_nonce!, 'approved', a.content_hash!.slice(0, 10)))).toMatchObject({ outcome: 'refused', reason: 'expired' })
    expect(existsSync(taskDir(SPEC.name))).toBe(false)
  })
})

describe('7. the start-up sweep', () => {
  it('an approved, unconsumed request (decided while the consumer could not run) is consumed and created now', async () => {
    const { body } = await fileSpec()
    db.getDb().prepare("UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_by = 'telegram-owner' WHERE id = ?").run(Math.floor(Date.now() / 1000), body.approvalId)
    expect(sweepScheduleCommandOnStart()).toEqual({ consumed: 1, interrupted: 0 })
    expectCreatedExactly()
    expect(specRow(body.approvalId)!.outcome).toBe('created')
    expect(sweepScheduleCommandOnStart()).toEqual({ consumed: 0, interrupted: 0 })
  })

  it('consumed but without an outcome (a crash in between): marked interrupted and alerted, never re-run', async () => {
    const { body } = await fileSpec()
    db.getDb().prepare("UPDATE approvals SET status = 'approved', resolved_at = ?, consumed_at = ? WHERE id = ?").run(Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000), body.approvalId)
    db.getDb().prepare('UPDATE schedule_command_specs SET consumed_at = ? WHERE approval_id = ?').run(Math.floor(Date.now() / 1000), body.approvalId)
    expect(sweepScheduleCommandOnStart()).toEqual({ consumed: 0, interrupted: 1 })
    expect(existsSync(taskDir(SPEC.name))).toBe(false)
    expect(specRow(body.approvalId)!.outcome).toBe('interrupted')
    expect(h.alerts).toHaveLength(1)
    expect(h.alerts[0]).toContain('megszakadt')
  })

  it('web.ts registers the consumer and runs the sweep after the agent_create ones', () => {
    const WEB = readFileSync(new URL('../web.ts', import.meta.url), 'utf-8')
    const ac = WEB.indexOf('  void sweepAgentCreateOnStart().catch(')
    const reg = WEB.indexOf('  registerScheduleCommandConsumer()\n')
    const sweep = WEB.indexOf('  try { sweepScheduleCommandOnStart() }')
    expect(ac).toBeGreaterThan(-1)
    expect(reg).toBeGreaterThan(ac)
    expect(sweep).toBeGreaterThan(reg)
  })
})
