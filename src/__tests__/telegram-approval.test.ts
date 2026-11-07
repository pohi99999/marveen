import { describe, it, expect, beforeEach, vi } from 'vitest'
// Card 3558: the owner decides on Telegram; the SERVER resolves, from identity Telegram asserts and
// the approval's own nonce. Both directions: the owner's press decides; a foreign from.id, a wrong
// nonce, an already resolved or an expired approval do not.
vi.mock('../web/telegram.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/telegram.js')>()
  return {
    ...real,
    sendTelegramMessage: vi.fn(async () => 4242),
    editTelegramMessageText: vi.fn(async () => true),
    answerTelegramCallbackQuery: vi.fn(async () => true),
  }
})
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, TELEGRAM_BOT_TOKEN: 'test-token', ALLOWED_CHAT_ID: '777001' }
})
import { initDatabase, createApproval, getApproval, resolveApprovalByOwner } from '../db.js'
import { newApprovalNonce, buildCallbackData, parseCallbackData, checkOwnerCallback, resolvableByOwner, ownerApprovalKeyboard, emailSummaryLines } from '../web/telegram-approval.js'
import { tryHandleApprovals, applyOwnerDecision, buildOwnerApprovalText } from '../web/routes/approvals.js'
import { handleCallbackLine } from '../web/approval-callbacks.js'
import type { RouteContext } from '../web/routes/types.js'
import * as tg from '../web/telegram.js'

function fakeReq(method: string, path: string, body?: unknown): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(status: number) { out.status = status; return res }, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) } }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = body === undefined ? '' : JSON.stringify(body)
  const req: any = { on(event: string, cb: (chunk?: Buffer) => void) { if (event === 'data' && bodyStr) cb(Buffer.from(bodyStr)); if (event === 'end') cb() } }
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}
const OWNER = 777001

describe('telegram approval: pure pieces', () => {
  it('nonce is 8 url-safe chars, callback_data round-trips and stays under 64 bytes', () => {
    const nonce = newApprovalNonce()
    expect(nonce).toMatch(/^[A-Za-z0-9]{8}$/)
    const id = '0f0e0d0c-0b0a-4908-8706-050403020100'
    const data = buildCallbackData(id, nonce, 'approved')
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    expect(parseCallbackData(data)).toEqual({ approvalId: id, nonce, decision: 'approved' })
    expect(parseCallbackData('apr:x')).toBeNull()
    expect(parseCallbackData('something else')).toBeNull()
    const kb = ownerApprovalKeyboard(id, nonce)
    expect(kb.inline_keyboard[0].map((b) => b.text)).toEqual(['Jóváhagyom', 'Elutasítom'])
  })
  it('identity first: only the owner id passes, then the nonce and the state decide', () => {
    const data = buildCallbackData('abcdefab-1234-4abc-8abc-abcdefabcdef', 'n0nceAAA', 'rejected')
    expect(checkOwnerCallback(data, OWNER, String(OWNER))).toMatchObject({ ok: true })
    expect(checkOwnerCallback(data, 123456, String(OWNER))).toEqual({ ok: false, reason: 'not-owner' })
    expect(checkOwnerCallback(data, OWNER, null)).toEqual({ ok: false, reason: 'no-owner-configured' })
    expect(checkOwnerCallback('garbage', OWNER, String(OWNER))).toEqual({ ok: false, reason: 'malformed' })
    const now = 1_800_000_000
    expect(resolvableByOwner({ status: 'pending', timeout_at: now + 60, owner_nonce: 'n0nceAAA' }, 'n0nceAAA', now)).toBeNull()
    expect(resolvableByOwner({ status: 'pending', timeout_at: now + 60, owner_nonce: 'n0nceAAA' }, 'other', now)).toBe('wrong_nonce')
    expect(resolvableByOwner({ status: 'approved', timeout_at: null, owner_nonce: 'n0nceAAA' }, 'n0nceAAA', now)).toBe('already_resolved')
    expect(resolvableByOwner({ status: 'pending', timeout_at: now - 1, owner_nonce: 'n0nceAAA' }, 'n0nceAAA', now)).toBe('expired')
    expect(resolvableByOwner({ status: 'pending', timeout_at: null, owner_nonce: null }, 'x', now)).toBe('no_nonce')
    expect(resolvableByOwner(undefined, 'x', now)).toBe('not_found')
  })
  it('the owner text names recipients, subject, attachments and the anchor head', () => {
    const a = { id: 'a-text', agent_id: 'marveen', category: 'email_send', action_description: 'Levél X-nek', content_hash: 'ab'.repeat(32), owner_nonce: 'n0nceAAA', status: 'pending', timeout_at: null, telegram_message_id: null, requested_at: 0, resolved_at: null, resolved_by: null,
      action_payload: JSON.stringify({ to: ['x@example.com'], cc: ['y@example.com'], subject: 'Ajánlat', attachments: [{ name: 'ajanlat.pdf' }] }) } as any
    const lines = emailSummaryLines(a)
    expect(lines).toEqual(['Címzett: x@example.com | cc: y@example.com', 'Tárgy: Ajánlat', 'Csatolmány: ajanlat.pdf', 'Horgony: abababababab...'])
    expect(buildOwnerApprovalText(a)).toContain('/approvals <n> approve|reject n0nceAAA')
  })
})

describe('telegram approval: server-side resolution', () => {
  beforeEach(() => { initDatabase(':memory:'); vi.clearAllMocks() })
  const mk = (id: string, opts: { timeout?: number | null; status?: 'approved' } = {}) => {
    createApproval({ id, agent_id: 'marveen', category: 'email_send', action_description: 'Levél', content_hash: 'cd'.repeat(32), owner_nonce: 'n0nceAAA', timeout_at: opts.timeout === undefined ? Math.floor(Date.now() / 1000) + 600 : opts.timeout })
    return getApproval(id)!
  }
  it("the owner's press approves once; a second press, a wrong nonce, a foreign id and an expired row do not", async () => {
    const press = (id: string, nonce: string, from: number, decision: 'approved' | 'rejected' = 'approved') => handleCallbackLine(
      { callback_query_id: 'cq1', data: buildCallbackData(id, nonce, decision), from_id: from },
      String(OWNER),
      { apply: (i, n, d) => applyOwnerDecision(i, n, d, undefined, 'button'), answer: (cb, text) => tg.answerTelegramCallbackQuery('test-token', cb, text) },
    )
    mk('a1a1a1a1')
    expect(await press('a1a1a1a1', 'n0nceAAA', OWNER)).toMatchObject({ outcome: 'approved' })
    expect(getApproval('a1a1a1a1')).toMatchObject({ status: 'approved', resolved_by: 'telegram-owner' })
    expect(tg.answerTelegramCallbackQuery).toHaveBeenCalledWith('test-token', 'cq1', 'Jóváhagyva.')
    // second press
    expect(await press('a1a1a1a1', 'n0nceAAA', OWNER, 'rejected')).toMatchObject({ outcome: 'refused', reason: 'already_resolved' })
    expect(getApproval('a1a1a1a1')!.status).toBe('approved')
    // foreign id
    mk('a2a2a2a2')
    expect(await press('a2a2a2a2', 'n0nceAAA', 123456)).toMatchObject({ outcome: 'refused', reason: 'not-owner' })
    expect(getApproval('a2a2a2a2')!.status).toBe('pending')
    // wrong nonce (right owner)
    expect(await press('a2a2a2a2', 'wrongNON', OWNER)).toMatchObject({ outcome: 'refused', reason: 'wrong_nonce' })
    expect(getApproval('a2a2a2a2')!.status).toBe('pending')
    // expired
    mk('a3a3a3a3', { timeout: Math.floor(Date.now() / 1000) - 5 })
    expect(await press('a3a3a3a3', 'n0nceAAA', OWNER)).toMatchObject({ outcome: 'refused', reason: 'expired' })
    expect(getApproval('a3a3a3a3')!.status).toBe('pending')
  })
  it('a POST /api/approvals row gets a nonce and the owner notification carries the buttons', async () => {
    const { ctx, out } = fakeReq('POST', '/api/approvals', { agent_id: 'marveen', category: 'email_send', action_description: 'Levél', timeout_seconds: 600, content_hash: 'ef'.repeat(32), action_payload: JSON.stringify({ to: ['x@example.com'], subject: 'T' }) })
    await tryHandleApprovals(ctx)
    expect(out.status).toBe(201)
    expect(out.body.owner_nonce).toBeNull()
    const nonce = getApproval(out.body.id)!.owner_nonce!
    expect(nonce).toMatch(/^[A-Za-z0-9]{8}$/)
    await new Promise((r) => setTimeout(r, 10))
    const call = (tg.sendTelegramMessage as any).mock.calls[0]
    expect(call[1]).toBe('777001')
    expect(call[2]).toContain('Címzett: x@example.com')
    expect(call[3].reply_markup.inline_keyboard[0][0].callback_data).toBe(buildCallbackData(out.body.id, nonce, 'approved'))
  })
  it('applyOwnerDecision rewrites the notification with the outcome, and the DB resolver is one conditional write', () => {
    const a = mk('a4a4a4a4'); (a as any).telegram_message_id = 7
    const r = applyOwnerDecision('a4a4a4a4', 'n0nceAAA', 'rejected')
    expect(r.ok).toBe(true)
    expect(resolveApprovalByOwner({ id: 'a4a4a4a4', nonce: 'n0nceAAA', decision: 'approved', resolvedBy: 'telegram-owner' })).toMatchObject({ ok: false, reason: 'already_resolved' })
  })
})
