// A new approval closes the older open one on the same subject (Peter 13595; the 2026-11-05 double button).
import { describe, it, expect, beforeEach, vi } from 'vitest'

const editSpy = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => true))
const sendSpy = vi.hoisted(() => vi.fn(async (_t: string, _c: string, _x: string): Promise<number | null> => 555))

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'agent-a', TELEGRAM_BOT_TOKEN: 'test-token', CHANNEL_PROVIDER: 'telegram' }
})
vi.mock('../owner-chat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../owner-chat.js')>()
  return { ...real, resolveOwnerChatId: () => '777' }
})
vi.mock('../web/telegram.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/telegram.js')>()
  return { ...real, sendTelegramMessage: sendSpy, editTelegramMessageText: editSpy }
})

import { initDatabase, getApproval } from '../db.js'
import { tryHandleApprovals } from '../web/routes/approvals.js'
import { approvalSubjectKey, supersededApprovals, supersededResolver, SUPERSEDED_NOTE } from '../web/approval-supersede.js'
import type { Approval } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

async function post(body: unknown) {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(status: number) { out.status = status; return res }, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) } }
  const req: any = { on(event: string, cb: (chunk?: Buffer) => void) { if (event === 'data') cb(Buffer.from(JSON.stringify(body))); if (event === 'end') cb() } }
  const url = new URL('http://localhost:3420/api/approvals')
  const ctx = { req, res, path: url.pathname, method: 'POST', url, auth: { kind: 'session', user: 'owner' } } as unknown as RouteContext
  expect(await tryHandleApprovals(ctx)).toBe(true)
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setTimeout(r, 20))
  return out
}
const mail = (to: string, subject: string, body = 'x') => JSON.stringify({ to: [to], subject, body })
const row = (o: Partial<Approval>): Approval => ({ id: 'n', agent_id: 'a', category: 'c', action_description: 'd', status: 'pending', ...o }) as Approval

describe('the subject of a request', () => {
  it('a mail is its recipients and subject, so a changed body is the same subject', () => {
    const a = row({ category: 'email_send', action_payload: mail('X@example.com', 'Ajánlat', 'első') })
    const b = row({ category: 'email_send', action_payload: mail('x@example.com ', ' ajánlat', 'második') })
    expect(approvalSubjectKey(a)).toBe(approvalSubjectKey(b))
    expect(approvalSubjectKey(row({ category: 'email_send', action_payload: mail('y@example.com', 'Ajánlat') }))).not.toBe(approvalSubjectKey(a))
    expect(approvalSubjectKey(row({ category: 'email_send', action_payload: mail('x@example.com', 'Más') }))).not.toBe(approvalSubjectKey(a))
  })
  it('anything else is its description, whitespace and case aside; a broken payload falls back to it', () => {
    expect(approvalSubjectKey(row({ action_description: ' Repo  push ' }))).toBe(approvalSubjectKey(row({ action_description: 'repo push' })))
    expect(approvalSubjectKey(row({ category: 'email_send', action_description: 'd', action_payload: '{' }))).toBe('text:d')
  })
  it('never another agent, another category, the new row itself or a closed row', () => {
    const next = row({ id: 'new' })
    const others = [row({ id: 'other-agent', agent_id: 'b' }), row({ id: 'other-cat', category: 'z' }), row({ id: 'new' }), row({ id: 'done', status: 'approved' }), row({ id: 'other-text', action_description: 'más' })]
    expect(supersededApprovals(next, others, null)).toEqual([])
    expect(supersededApprovals(next, [...others, row({ id: 'same' })], null).map((a) => a.id)).toEqual(['same'])
  })
  it('the explicit id reaches a different text, but not another agent', () => {
    const next = row({ id: 'new' })
    const pending = [row({ id: 'other-text', action_description: 'más', category: 'z' }), row({ id: 'other-agent', agent_id: 'b' })]
    expect(supersededApprovals(next, pending, 'other-text').map((a) => a.id)).toEqual(['other-text'])
    expect(supersededApprovals(next, pending, 'other-agent')).toEqual([])
  })
})

describe('POST /api/approvals closes the older request', () => {
  beforeEach(() => { initDatabase(':memory:'); editSpy.mockClear(); sendSpy.mockClear() })
  const req = (description: string, extra: object = {}) => ({ agent_id: 'agent-b', category: 'publish_content', action_description: description, ...extra })

  it('the same subject: the old row is rejected, names its successor, and its Telegram buttons go', async () => {
    const first = (await post(req('Első poszt kitétele'))).body
    expect(getApproval(first.id)?.status).toBe('pending')
    const second = (await post(req('első  poszt kitétele'))).body
    expect(getApproval(second.id)?.status).toBe('pending')
    const old = getApproval(first.id)!
    expect(old.status).toBe('rejected')
    expect(old.resolved_by).toBe(supersededResolver(second.id))
    expect(editSpy).toHaveBeenCalledTimes(1)
    expect(editSpy.mock.calls[0]?.[3]).toContain(SUPERSEDED_NOTE)
  })
  it('another subject stays open: the owner still owes that decision', async () => {
    const first = (await post(req('Második poszt kitétele'))).body
    const second = (await post(req('Harmadik poszt'))).body
    expect(getApproval(first.id)?.status).toBe('pending')
    expect(getApproval(second.id)?.status).toBe('pending')
    expect(editSpy).not.toHaveBeenCalled()
  })
  it('the explicit supersedes closes a request whose text changed', async () => {
    const first = (await post(req('Levél', { category: 'external_message', action_payload: mail('x@example.com', 'T', '1') }))).body
    const second = (await post(req('Levél javítva', { supersedes: first.id, category: 'external_message', action_payload: mail('x@example.com', 'T', '2') }))).body
    expect(getApproval(first.id)?.status).toBe('rejected')
    expect(getApproval(second.id)?.status).toBe('pending')
  })
  it('an approved request is not touched', async () => {
    const first = (await post(req('Jóváhagyott poszt'))).body
    const { resolveApproval } = await import('../db.js')
    resolveApproval(first.id, 'approved', 'owner')
    await post(req('Jóváhagyott poszt'))
    expect(getApproval(first.id)?.status).toBe('approved')
  })
})
