import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// A computer_use_access approval turns into a keystroke that grants an app to the main session,
// so it is decided by the owner's Telegram BUTTON only: the line the patched plugin wrote from the
// real update (approval-callbacks.jsonl). Every other way an approval can be decided must refuse
// it -- the /approvals text command, the HTTP decision route (its from_id is whatever the caller
// sends), the dashboard PATCH -- and no GET may serve its nonce. Both directions: an ordinary
// category still goes through those paths unchanged.
vi.mock('../web/telegram.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/telegram.js')>()
  return { ...real, sendTelegramMessage: vi.fn(async () => 4242), editTelegramMessageText: vi.fn(async () => true), answerTelegramCallbackQuery: vi.fn(async () => true) }
})
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, TELEGRAM_BOT_TOKEN: 'test-token', ALLOWED_CHAT_ID: '777001' }
})
import { initDatabase, createApproval, getApproval } from '../db.js'
import { buildCallbackData, COMPUTER_USE_ACCESS_CATEGORY } from '../web/telegram-approval.js'
import { tryHandleApprovals, applyOwnerDecision } from '../web/routes/approvals.js'
import { pollApprovalCallbacks } from '../web/approval-callbacks.js'
import type { RouteContext } from '../web/routes/types.js'

function fakeReq(method: string, path: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(status: number) { out.status = status; return res }, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) } }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = body === undefined ? '' : JSON.stringify(body)
  const req: any = { on(event: string, cb: (chunk?: Buffer) => void) { if (event === 'data' && bodyStr) cb(Buffer.from(bodyStr)); if (event === 'end') cb() } }
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}
const OWNER = 777001
const NONCE = 'n0nceAAA'
const mk = (id: string, category = COMPUTER_USE_ACCESS_CATEGORY) => {
  createApproval({ id, agent_id: 'Brunella', category, action_description: 'Computer Use: Finder', owner_nonce: NONCE, timeout_at: Math.floor(Date.now() / 1000) + 600 })
}

describe('computer_use_access: decided by the owner\'s button only', () => {
  beforeEach(() => { initDatabase(':memory:'); vi.clearAllMocks() })

  it('the HTTP decision route refuses it, even with the owner\'s id and the right nonce', async () => {
    mk('c1c1c1c1')
    const { ctx, out } = fakeReq('POST', '/api/approvals/c1c1c1c1/telegram-decision', { callback_data: buildCallbackData('c1c1c1c1', NONCE, 'approved'), from_id: OWNER })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(403)
    expect(out.body.error).toBe('button_only')
    expect(getApproval('c1c1c1c1')!.status).toBe('pending')
  })

  it('the /approvals command path refuses it', () => {
    mk('c2c2c2c2')
    expect(applyOwnerDecision('c2c2c2c2', NONCE, 'approved', undefined, 'command')).toMatchObject({ ok: false, reason: 'button_only' })
    expect(getApproval('c2c2c2c2')!.status).toBe('pending')
  })

  it('the dashboard PATCH refuses it', async () => {
    mk('c3c3c3c3')
    const { ctx, out } = fakeReq('PATCH', '/api/approvals/c3c3c3c3', { status: 'approved', resolved_by: 'marveen' })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(403)
    expect(getApproval('c3c3c3c3')!.status).toBe('pending')
  })

  it('an agent cannot raise one over the API', async () => {
    const { ctx, out } = fakeReq('POST', '/api/approvals', { agent_id: 'marveen', category: COMPUTER_USE_ACCESS_CATEGORY, action_description: 'x' })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(403)
  })

  it('no GET serves its nonce; an ordinary category keeps it', async () => {
    mk('c4c4c4c4')
    mk('e4e4e4e4', 'email_send')
    const one = fakeReq('GET', '/api/approvals/c4c4c4c4')
    await tryHandleApprovals(one.ctx)
    expect(one.out.body.owner_nonce).toBeNull()
    const list = fakeReq('GET', '/api/approvals')
    await tryHandleApprovals(list.ctx)
    const byId = Object.fromEntries(list.out.body.map((a: any) => [a.id, a.owner_nonce]))
    expect(byId['c4c4c4c4']).toBeNull()
    expect(byId['e4e4e4e4']).toBe(NONCE)
  })

  it('the owner\'s button press, as the plugin recorded it, DOES decide it; a foreign press does not', async () => {
    mk('c5c5c5c5')
    mk('c6c6c6c6')
    const dir = mkdtempSync(join(tmpdir(), 'cu-btn-'))
    const file = join(dir, 'approval-callbacks.jsonl')
    writeFileSync(file, [
      JSON.stringify({ callback_query_id: 'q1', data: buildCallbackData('c6c6c6c6', NONCE, 'approved'), from_id: 123456 }),
      JSON.stringify({ callback_query_id: 'q2', data: buildCallbackData('c5c5c5c5', NONCE, 'approved'), from_id: OWNER }),
    ].join('\n') + '\n')
    const out = await pollApprovalCallbacks(file, String(OWNER), join(dir, 'offset.json'))
    expect(out.map((o) => o.outcome)).toEqual(['refused', 'approved'])
    expect(getApproval('c5c5c5c5')).toMatchObject({ status: 'approved', resolved_by: 'telegram-owner' })
    expect(getApproval('c6c6c6c6')!.status).toBe('pending')
  })

  it('an ordinary category is unchanged: the command and the HTTP route still decide it', async () => {
    mk('e1e1e1e1', 'email_send')
    expect(applyOwnerDecision('e1e1e1e1', NONCE, 'rejected', undefined, 'command')).toMatchObject({ ok: true })
    mk('e2e2e2e2', 'email_send')
    const { ctx, out } = fakeReq('POST', '/api/approvals/e2e2e2e2/telegram-decision', { callback_data: buildCallbackData('e2e2e2e2', NONCE, 'approved'), from_id: OWNER })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(200)
  })
})
