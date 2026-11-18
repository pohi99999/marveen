import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, listAgentMessages, getApproval, resolveApproval } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'
import { sendWithRetry, retryAfterMs, isPassingSendError, MAX_WAIT_MS } from '../web/approval-notify-retry.js'
import { isAgentAllowed } from '../web/auth-gate.js'

// APPROVALNOTIFYRETRY1118. Measured 2026-11-18 15:00:17: an email_send request was filed, the one Telegram
// send answered "fetch failed: read ECONNRESET", and the request was written off as OWNER_UNREACHED at
// once; the owner got no message and no button. These tests pin, by BEHAVIOUR (which sends ran, whether
// the in-band [OWNER_UNREACHED] row appeared, what the row's message id is):
//   - a passing failure is sent again, with a growing wait, before the request is written off;
//   - a configuration failure (4xx) is not sent again;
//   - a request decided while the send is being repeated gets no late question;
//   - a pending request's question can be sent once more through POST /api/approvals/:id/notify.

/** What the real sender threw in the measured case (the dashboard log's `err.type` and `err.message`). */
const RESET = () => new TypeError('fetch failed: read ECONNRESET')

const { cfg } = vi.hoisted(() => ({
  cfg: {
    /** What each next Telegram send does: an Error is thrown, a number is the message id; past the end, 42. */
    script: [] as (Error | number)[],
    onSleep: null as null | ((ms: number) => void),
  },
}))

vi.mock('../notify.js', () => ({
  sendOwnerSlackDm: async () => ({ attempted: false, sent: false }),
  sendOwnerMessage: async () => ({ sent: true }),
  notifyChannel: async () => {},
  notifyTelegram: async () => {},
  notifySecurityEvent: async () => {},
}))

const telegramSends: unknown[][] = []
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: async (...args: unknown[]) => {
    telegramSends.push(args)
    const next = cfg.script.shift()
    if (next instanceof Error) throw next
    return next ?? 42
  },
  editTelegramMessageText: async () => true,
}))

vi.mock('../owner-chat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../owner-chat.js')>()
  return { ...real, resolveOwnerChatId: () => '111' }
})

vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'fo-agens', CHANNEL_PROVIDER: 'telegram', TELEGRAM_BOT_TOKEN: 'tg-token' }
})

const { tryHandleApprovals, ownerNotifyRetry, RESEND_MIN_GAP_MS, RESEND_MAX_SENT, resendRefusal } = await import('../web/routes/approvals.js')

function call(method: string, path: string, body: unknown = {}): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body)
  const req: any = {
    on(event: string, cb: (chunk?: Buffer) => void) {
      if (event === 'data') cb(Buffer.from(bodyStr))
      if (event === 'end') cb()
    },
  }
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

function ownerUnreached(): string[] {
  return listAgentMessages(100).map((m) => m.content).filter((c) => c.includes('[OWNER_UNREACHED'))
}

/** Lets the fire-and-forget notification run to its end: every wait in it is the replaced `sleep`. */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)) }

async function file(): Promise<string> {
  const { ctx, out } = call('POST', '/api/approvals', { agent_id: 'fo-agens', category: 'email_send', action_description: 'proba', timeout_seconds: 600 })
  await tryHandleApprovals(ctx)
  await settle()
  expect(out.status).toBe(201)
  return out.body.id as string
}

const resend = async (id: string) => {
  const { ctx, out } = call('POST', `/api/approvals/${id}/notify`)
  expect(await tryHandleApprovals(ctx)).toBe(true)
  return out
}

const slept: number[] = []
const REAL_DELAYS = [...ownerNotifyRetry.delaysMs]

beforeEach(() => {
  initDatabase(':memory:')
  telegramSends.length = 0
  slept.length = 0
  cfg.script = []
  cfg.onSleep = null
  ownerNotifyRetry.delaysMs = REAL_DELAYS
  ownerNotifyRetry.sleep = async (ms) => { slept.push(ms); cfg.onSleep?.(ms) }
})

describe('sendWithRetry: which failure is sent again, and how long it waits', () => {
  const deps = (delaysMs: number[], log: number[] = []) => ({ delaysMs, sleep: async (ms: number) => { log.push(ms) } })

  it('a reset connection, a timeout, 429 and 5xx pass; a 4xx is configuration', () => {
    for (const passing of [RESET(), new Error('The operation was aborted due to timeout'), new Error('Telegram API 429: Too Many Requests'), new Error('Telegram API 502: Bad Gateway')]) {
      expect(isPassingSendError(passing), passing.message).toBe(true)
    }
    for (const config of [new Error('Telegram API 400: chat not found'), new Error('Telegram API 401: Unauthorized'), new Error('Telegram API 403: bot was blocked by the user')]) {
      expect(isPassingSendError(config), config.message).toBe(false)
    }
  })

  it('sends again after passing failures and reports how many attempts it took', async () => {
    const waits: number[] = []
    const script: (Error | number)[] = [RESET(), new Error('Telegram API 503: x'), 7]
    const r = await sendWithRetry(async () => { const n = script.shift(); if (n instanceof Error) throw n; return n }, deps([1_000, 3_000, 9_000], waits))
    expect(r).toEqual({ ok: true, value: 7, attempts: 3 })
    expect(waits).toEqual([1_000, 3_000])
  })

  it('gives up after the last wait: one attempt more than there are waits', async () => {
    const waits: number[] = []
    let calls = 0
    const r = await sendWithRetry(async () => { calls += 1; throw RESET() }, deps([10, 20, 30], waits))
    expect(r.ok).toBe(false)
    expect(r).toMatchObject({ why: 'exhausted', attempts: 4 })
    expect(calls).toBe(4)
    expect(waits).toEqual([10, 20, 30])
  })

  it('does not send a configuration failure again', async () => {
    const waits: number[] = []
    let calls = 0
    const r = await sendWithRetry(async () => { calls += 1; throw new Error('Telegram API 400: chat not found') }, deps([10, 20], waits))
    expect(r).toMatchObject({ ok: false, why: 'permanent', attempts: 1 })
    expect(calls).toBe(1)
    expect(waits).toEqual([])
  })

  it('waits as long as the server asks, when that is longer, but never past the cap', async () => {
    expect(retryAfterMs(new Error('Telegram API 429: {"ok":false,"error_code":429,"description":"Too Many Requests: retry after 7","parameters":{"retry_after":7}}'))).toBe(7_000)
    expect(retryAfterMs(RESET())).toBeNull()
    for (const [asked, waited] of [[7, 7_000], [600, MAX_WAIT_MS]] as const) {
      const waits: number[] = []
      const script: (Error | number)[] = [new Error(`Telegram API 429: Too Many Requests: retry after ${asked}`), 1]
      await sendWithRetry(async () => { const n = script.shift(); if (n instanceof Error) throw n; return n }, deps([1_000], waits))
      expect(waits).toEqual([waited])
    }
  })

  it('stops when nobody waits for the send any more', async () => {
    let calls = 0
    const r = await sendWithRetry(async () => { calls += 1; throw RESET() }, deps([10, 20]), { stillWanted: () => false })
    expect(r).toMatchObject({ ok: false, why: 'unwanted', attempts: 1 })
    expect(calls).toBe(1)
  })

  it('tells about every failed attempt that is followed by another', async () => {
    const told: [number, number][] = []
    await sendWithRetry(async () => { throw RESET() }, deps([10, 20]), { onRetry: (_e, attempt, waitMs) => told.push([attempt, waitMs]) })
    expect(told).toEqual([[1, 10], [2, 20]])
  })
})

describe('a filed request on a Telegram install', () => {
  it('the measured case: one reset connection, and the owner still gets the question with its button', async () => {
    cfg.script = [RESET(), 77]
    const id = await file()
    expect(telegramSends).toHaveLength(2)
    expect(slept).toEqual([1_000])
    // the same message both times, with the keyboard
    expect(telegramSends[1]).toEqual(telegramSends[0])
    expect(JSON.stringify(telegramSends[1]![3])).toContain('inline_keyboard')
    expect(getApproval(id)?.telegram_message_id).toBe(77)
    expect(ownerUnreached()).toEqual([])
  })

  it('four passing failures in a row: four sends, then OWNER_UNREACHED once', async () => {
    cfg.script = [RESET(), RESET(), new Error('Telegram API 502: Bad Gateway'), RESET()]
    const id = await file()
    expect(telegramSends).toHaveLength(4)
    expect(slept).toEqual([1_000, 3_000, 9_000])
    expect(getApproval(id)?.telegram_message_id).toBeNull()
    const rows = ownerUnreached()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('[OWNER_UNREACHED send-failed]')
    expect(rows[0]).toContain(`id=${id}`)
  })

  it('a configuration failure is written off at once, as before', async () => {
    cfg.script = [new Error('Telegram API 400: Bad Request: chat not found')]
    await file()
    expect(telegramSends).toHaveLength(1)
    expect(slept).toEqual([])
    expect(ownerUnreached()).toHaveLength(1)
  })

  it('a request decided while the send is being repeated gets no late question and no OWNER_UNREACHED', async () => {
    cfg.script = [RESET(), 88]
    let filedId = ''
    cfg.onSleep = () => {
      // the owner decides on the dashboard during the first wait
      const pending = listPending()
      filedId = pending[0]!
      resolveApproval(filedId, 'approved', 'dashboard', null)
    }
    await file()
    expect(filedId).not.toBe('')
    expect(telegramSends).toHaveLength(1)
    expect(getApproval(filedId)?.telegram_message_id).toBeNull()
    expect(ownerUnreached()).toEqual([])
  })
})

/** The ids of the pending requests, read the way the dashboard lists them. */
function listPending(): string[] {
  const { ctx, out } = call('GET', '/api/approvals?status=pending')
  void tryHandleApprovals(ctx)
  return (out.body as { id: string }[]).map((a) => a.id)
}

describe('POST /api/approvals/:id/notify: the question of a pending request, once more', () => {
  it('sends the same question with the button again and stamps the new message', async () => {
    cfg.script = [RESET(), RESET(), RESET(), RESET()]
    const id = await file()
    expect(getApproval(id)?.telegram_message_id).toBeNull()
    telegramSends.length = 0
    cfg.script = [91]
    const out = await resend(id)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, sent: true })
    expect(telegramSends).toHaveLength(1)
    expect(String(telegramSends[0]![2])).toContain(id)
    expect(JSON.stringify(telegramSends[0]![3])).toContain('inline_keyboard')
    expect(getApproval(id)?.telegram_message_id).toBe(91)
    // the answer carries no nonce
    expect(JSON.stringify(out.body)).not.toContain('nonce')
  })

  it('a failed re-send is one attempt, answered 502, with no new OWNER_UNREACHED row', async () => {
    const id = await file()
    const before = ownerUnreached().length
    telegramSends.length = 0
    slept.length = 0
    cfg.script = [RESET(), 5]
    const out = await resend(id)
    expect(out.status).toBe(502)
    expect(out.body).toEqual({ ok: false, sent: false })
    expect(telegramSends).toHaveLength(1)
    expect(slept).toEqual([])
    expect(ownerUnreached()).toHaveLength(before)
  })

  it('refuses a second re-send inside the gap, and tells how long to wait', async () => {
    const id = await file()
    expect((await resend(id)).status).toBe(200)
    telegramSends.length = 0
    const again = await resend(id)
    expect(again.status).toBe(429)
    expect(again.body.error).toBe('too_soon')
    expect(again.body.retry_after_s).toBeGreaterThan(0)
    expect(again.body.retry_after_s).toBeLessThanOrEqual(RESEND_MIN_GAP_MS / 1000)
    expect(telegramSends).toHaveLength(0)
  })

  it('the brake by itself: a gap between attempts, and a cap on delivered re-sends', () => {
    const t0 = 1_800_000_000_000
    expect(resendRefusal('brake-gap', t0)).toBeNull()
    expect(resendRefusal('brake-gap', t0 + RESEND_MIN_GAP_MS - 1)).toEqual({ error: 'too_soon', retry_after_s: 1 })
    expect(resendRefusal('brake-gap', t0 + RESEND_MIN_GAP_MS)).toBeNull()
    expect(RESEND_MAX_SENT).toBeGreaterThan(0)
  })

  it('after the cap of delivered re-sends the route refuses, also once the gap has passed', async () => {
    const id = await file()
    const realNow = Date.now
    const t0 = realNow()
    try {
      for (let i = 0; i < RESEND_MAX_SENT; i++) {
        Date.now = () => t0 + i * RESEND_MIN_GAP_MS
        expect((await resend(id)).status, `re-send ${i + 1}`).toBe(200)
      }
      telegramSends.length = 0
      // well past the gap, and still inside the request's ten minutes
      Date.now = () => t0 + (RESEND_MAX_SENT + 3) * RESEND_MIN_GAP_MS
      const over = await resend(id)
      expect(over.status).toBe(429)
      expect(over.body).toEqual({ error: 'too_many', sent: RESEND_MAX_SENT })
      expect(telegramSends).toHaveLength(0)
    } finally {
      Date.now = realNow
    }
  })

  it('a re-send that failed does not count toward the cap', async () => {
    const id = await file()
    const realNow = Date.now
    const t0 = realNow()
    try {
      for (let i = 0; i < RESEND_MAX_SENT + 2; i++) {
        Date.now = () => t0 + i * RESEND_MIN_GAP_MS
        cfg.script = [RESET()]
        expect((await resend(id)).status, `failed re-send ${i + 1}`).toBe(502)
      }
      Date.now = () => t0 + (RESEND_MAX_SENT + 2) * RESEND_MIN_GAP_MS
      cfg.script = [64]
      expect((await resend(id)).status).toBe(200)
    } finally {
      Date.now = realNow
    }
  })

  it('a sub-agent token does not reach the route: it is not on the gate\'s allowlist, its neighbours are', () => {
    expect(isAgentAllowed('/api/approvals/ab12/notify', 'POST', 'dani')).toBe(false)
    expect(isAgentAllowed('/api/approvals/ab12/consume', 'POST', 'dani')).toBe(true)
    expect(isAgentAllowed('/api/approvals/ab12', 'GET', 'dani')).toBe(true)
  })

  it('refuses a request that is not pending, one that expired, and one that does not exist', async () => {
    const id = await file()
    resolveApproval(id, 'rejected', 'dashboard', null)
    telegramSends.length = 0
    const decided = await resend(id)
    expect(decided.status).toBe(409)
    expect(decided.body).toEqual({ error: 'not_pending', status: 'rejected' })

    const { ctx, out } = call('POST', '/api/approvals', { agent_id: 'fo-agens', category: 'email_send', action_description: 'proba', timeout_seconds: 1 })
    await tryHandleApprovals(ctx)
    await settle()
    telegramSends.length = 0
    const realNow = Date.now
    Date.now = () => realNow() + 5_000
    try {
      const expired = await resend(out.body.id)
      expect(expired.status).toBe(409)
      expect(expired.body).toEqual({ error: 'expired' })
    } finally {
      Date.now = realNow
    }

    expect((await resend('no-such-id')).status).toBe(404)
    expect(telegramSends).toHaveLength(0)
  })
})
