import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// An approval is decided by the owner: a recorded button press, or the owner's own command with the message it came in.
// Both directions on every path, so a change that lets a request body decide fails here.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../web/telegram.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/telegram.js')>()
  return { ...real, sendTelegramMessage: vi.fn(async () => 4242), editTelegramMessageText: vi.fn(async () => true), answerTelegramCallbackQuery: vi.fn(async () => true) }
})
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, TELEGRAM_BOT_TOKEN: 'test-token', ALLOWED_CHAT_ID: '777001' }
})
import { initDatabase, createApproval, getApproval } from '../db.js'
import { applyOwnerDecision, tryHandleApprovals } from '../web/routes/approvals.js'
import { buildCallbackData, namesOwnerResolver, OWNER_RESOLVER } from '../web/telegram-approval.js'
import { pollApprovalCallbacks } from '../web/approval-callbacks.js'
import { recordApprovalPress } from '../channel-coordinator/approval-press.js'
import { dispatchForChat } from '../web/routes/commands.js'
import { clearCommandsForTest } from '../web/commands.js'
import { registerBuiltinCommands } from '../web/builtin-commands.js'
import type { RouteContext } from '../web/routes/types.js'

const OWNER = 777001
const NONCE = 'n0nceAAA'
const ID = 'abcdefab-1111-4abc-8abc-abcdefabcd01'

type Auth = RouteContext['auth']
function call(method: string, path: string, body?: unknown, auth: Auth = { kind: 'token' } as Auth): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(status: number) { out.status = status; return res }, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) } }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = body === undefined ? '' : JSON.stringify(body)
  const req: any = { headers: {}, on(event: string, cb: (chunk?: Buffer) => void) { if (event === 'data' && bodyStr) cb(Buffer.from(bodyStr)); if (event === 'end') cb() } }
  return { ctx: { req, res, path: url.pathname, method, url, auth } as RouteContext, out }
}
const mk = (id = ID, category = 'service_restart') => createApproval({
  id, agent_id: 'kenshin', category, action_description: 'probe', owner_nonce: NONCE, timeout_at: Math.floor(Date.now() / 1000) + 3600,
})

let dir: string
beforeEach(() => {
  initDatabase(':memory:')
  vi.clearAllMocks()
  dir = mkdtempSync(join(tmpdir(), 'approval-decision-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('no API answer carries the nonce', () => {
  it('GET one and GET list, for an ordinary and a button-only category', async () => {
    mk()
    mk('abcdefab-2222-4abc-8abc-abcdefabcd02', 'computer_use_access')
    const one = call('GET', `/api/approvals/${ID}`)
    await tryHandleApprovals(one.ctx)
    expect(one.out.status).toBe(200)
    expect(one.out.body.owner_nonce).toBeNull()
    const list = call('GET', '/api/approvals')
    await tryHandleApprovals(list.ctx)
    expect(list.out.body).toHaveLength(2)
    expect(list.out.body.map((a: any) => a.owner_nonce)).toEqual([null, null])
    // The row itself keeps it: the buttons and the command need it.
    expect(getApproval(ID)!.owner_nonce).toBe(NONCE)
  })

  it('the create answer', async () => {
    const c = call('POST', '/api/approvals', { agent_id: 'kenshin', category: 'service_restart', action_description: 'x', timeout_seconds: 600 })
    await tryHandleApprovals(c.ctx)
    expect(c.out.status).toBe(201)
    expect(c.out.body.owner_nonce).toBeNull()
    expect(getApproval(c.out.body.id)!.owner_nonce).toMatch(/^[A-Za-z0-9]{8}$/)
  })

  it('the PATCH answer', async () => {
    mk()
    const p = call('PATCH', `/api/approvals/${ID}`, { status: 'rejected', resolved_by: 'marveen' })
    await tryHandleApprovals(p.ctx)
    expect(p.out.status).toBe(200)
    expect(p.out.body.status).toBe('rejected')
    expect(p.out.body.owner_nonce).toBeNull()
  })

  it('the consume answers, by category and by email_send', async () => {
    mk()
    applyOwnerDecision(ID, NONCE, 'approved', undefined, 'button')
    const byCat = call('POST', `/api/approvals/${ID}/consume`, { category: 'service_restart', consumer: 'marveen' })
    await tryHandleApprovals(byCat.ctx)
    expect(byCat.out.status).toBe(200)
    expect(byCat.out.body.approval.owner_nonce).toBeNull()

    const hash = 'ab'.repeat(32)
    const mail = 'abcdefab-3333-4abc-8abc-abcdefabcd03'
    createApproval({ id: mail, agent_id: 'marveen', category: 'email_send', action_description: 'x', content_hash: hash, owner_nonce: NONCE, timeout_at: Math.floor(Date.now() / 1000) + 3600 })
    applyOwnerDecision(mail, NONCE, 'approved', undefined, 'button')
    const byMail = call('POST', `/api/approvals/${mail}/consume`, { content_hash: hash, consumer: 'marveen' })
    await tryHandleApprovals(byMail.ctx)
    expect(byMail.out.status).toBe(200)
    expect(byMail.out.body.approval.owner_nonce).toBeNull()
  })
})

describe('the decision route decides nothing', () => {
  const body = { callback_data: buildCallbackData(ID, NONCE, 'approved'), from_id: OWNER, nonce: NONCE, decision: 'approved' }
  it.each([
    ['the shared token', { kind: 'token' }],
    ['an agent token', { kind: 'token', agent: 'kenshin', tokenAgent: 'kenshin' }],
    ['a device key', { kind: 'device', device: 'd', deviceId: 'i', scope: 'full' }],
    ['a session', { kind: 'session', user: 'owner' }],
  ])('%s, with the right nonce and the owner id: 403, the row stays pending', async (_name, auth) => {
    mk()
    const c = call('POST', `/api/approvals/${ID}/telegram-decision`, body, auth as Auth)
    await tryHandleApprovals(c.ctx)
    expect(c.out.status).toBe(403)
    expect(getApproval(ID)).toMatchObject({ status: 'pending', resolved_by: null })
  })

  it('a rejection through the route does not land either', async () => {
    mk()
    const c = call('POST', `/api/approvals/${ID}/telegram-decision`, { ...body, callback_data: buildCallbackData(ID, NONCE, 'rejected'), decision: 'rejected' })
    await tryHandleApprovals(c.ctx)
    expect(c.out.status).toBe(403)
    expect(getApproval(ID)!.status).toBe('pending')
  })
})

describe('the owner resolver name is the server\'s', () => {
  it('PATCH may not write it, for an approval or a rejection', async () => {
    mk()
    for (const status of ['approved', 'rejected']) {
      const p = call('PATCH', `/api/approvals/${ID}`, { status, resolved_by: ` ${OWNER_RESOLVER} ` })
      await tryHandleApprovals(p.ctx)
      expect(p.out.status).toBe(403)
    }
    expect(getApproval(ID)).toMatchObject({ status: 'pending', resolved_by: null })
  })

  it.each([
    ['upper case', 'Telegram-Owner'],
    ['outer spaces', '  telegram-owner  '],
    ['a zero-width space', 'telegram\u200B-owner'],
    ['a no-break space', 'telegram-owner\u00A0'],
    ['a byte order mark', '\uFEFFtelegram-owner'],
    ['a soft hyphen', 'tele\u00ADgram-owner'],
    ['a non-breaking hyphen', 'telegram\u2011owner'],
    ['full-width letters', '\uFF54elegram-owner'],
  ])('PATCH may not write it with %s either', async (_name, name) => {
    mk()
    const p = call('PATCH', `/api/approvals/${ID}`, { status: 'approved', resolved_by: name })
    await tryHandleApprovals(p.ctx)
    expect(p.out.status).toBe(403)
    expect(getApproval(ID)).toMatchObject({ status: 'pending', resolved_by: null })
  })

  it('a name that only resembles it is an ordinary name', () => {
    expect(namesOwnerResolver('telegram_owner')).toBe(false)
    expect(namesOwnerResolver('telegram-owner-2')).toBe(false)
    expect(namesOwnerResolver('marveen')).toBe(false)
  })

  it('the rejection path a sub-agent uses to cancel keeps working under its own name', async () => {
    mk()
    const p = call('PATCH', `/api/approvals/${ID}`, { status: 'rejected', resolved_by: 'marveen' })
    await tryHandleApprovals(p.ctx)
    expect(p.out.status).toBe(200)
    expect(getApproval(ID)).toMatchObject({ status: 'rejected', resolved_by: 'marveen' })
  })
})

describe('the owner\'s button press decides', () => {
  const poll = async (file: string) => pollApprovalCallbacks(file, String(OWNER), join(dir, 'offset.json'))

  it('a press the coordinator recorded from a real update approves, as telegram-owner', async () => {
    mk()
    recordApprovalPress(dir, { data: buildCallbackData(ID, NONCE, 'approved'), from_id: OWNER, callback_query_id: 'cq1', chat_id: OWNER })
    const outcomes = await poll(join(dir, 'approval-callbacks.jsonl'))
    expect(outcomes).toMatchObject([{ outcome: 'approved' }])
    expect(getApproval(ID)).toMatchObject({ status: 'approved', resolved_by: OWNER_RESOLVER })
  })

  it('the same shape as the plugin writes: the fields the watcher reads', () => {
    recordApprovalPress(dir, { data: 'apr:x', from_id: OWNER, callback_query_id: 'cq1', chat_id: OWNER }, () => 1234)
    expect(JSON.parse(readFileSync(join(dir, 'approval-callbacks.jsonl'), 'utf-8'))).toEqual({ callback_query_id: 'cq1', data: 'apr:x', from_id: OWNER, chat_id: OWNER, at: 1234 })
  })

  it('a press from another Telegram user does not', async () => {
    mk()
    recordApprovalPress(dir, { data: buildCallbackData(ID, NONCE, 'approved'), from_id: 123456, callback_query_id: 'cq2' })
    expect(await poll(join(dir, 'approval-callbacks.jsonl'))).toMatchObject([{ outcome: 'refused', reason: 'not-owner' }])
    expect(getApproval(ID)!.status).toBe('pending')
  })

  it('a press with another nonce does not', async () => {
    mk()
    recordApprovalPress(dir, { data: buildCallbackData(ID, 'wrongNON', 'approved'), from_id: OWNER, callback_query_id: 'cq3' })
    expect(await poll(join(dir, 'approval-callbacks.jsonl'))).toMatchObject([{ outcome: 'refused', reason: 'wrong_nonce' }])
    expect(getApproval(ID)!.status).toBe('pending')
  })
})

describe('the /approvals command', () => {
  const chat = String(OWNER)
  const noWrite = () => ({ ok: false as const, reason: 'not-found' as const })
  const evidence = () => ({ ok: true as const })
  const run = (text: string, ev: typeof evidence | typeof noWrite) => dispatchForChat(text, chat, chat, Date.now(), true, false, false, '7', ev as never)

  beforeEach(() => {
    clearCommandsForTest()
    registerBuiltinCommands()
  })

  it('from the owner\'s chat, with the message on record and the right nonce: decides', async () => {
    mk()
    const r = await run(`/approvals 1 approve ${NONCE}`, evidence)
    expect(r.outcome).toBe('ran')
    expect(getApproval(ID)).toMatchObject({ status: 'approved', resolved_by: OWNER_RESOLVER })
  })

  it('without the message on record: refused, even with the right nonce', async () => {
    mk()
    const r = await run(`/approvals 1 approve ${NONCE}`, noWrite)
    expect(r.outcome).toBe('write-evidence-refused')
    expect(getApproval(ID)!.status).toBe('pending')
  })

  it('with a wrong nonce: refused', async () => {
    mk()
    await run('/approvals 1 approve wrongNON', evidence)
    expect(getApproval(ID)!.status).toBe('pending')
  })

  it('from another chat: not handled', async () => {
    mk()
    const r = await dispatchForChat(`/approvals 1 approve ${NONCE}`, '123456', chat, Date.now(), true, false, false, '7', evidence as never)
    expect(r.handled).toBe(false)
    expect(getApproval(ID)!.status).toBe('pending')
  })

  it('a button-only category stays out of its reach', async () => {
    mk('abcdefab-2222-4abc-8abc-abcdefabcd02', 'computer_use_access')
    await run(`/approvals 1 approve ${NONCE}`, evidence)
    expect(getApproval('abcdefab-2222-4abc-8abc-abcdefabcd02')!.status).toBe('pending')
  })
})
