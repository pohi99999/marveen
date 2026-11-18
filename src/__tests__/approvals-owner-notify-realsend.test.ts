// APPROVALNOTIFYRETRY1118, second review of PR #56: the retry with the REAL sendTelegramMessage and the REAL logger;
// only the network (global fetch) is replaced. approvals-owner-notify-retry.test.ts replaces the sender and hands the
// retry a hand-written Error, so it could not see that a real timeout, a DOMException, made the logger throw and fell
// out of the retry: a timeout was written off as OWNER_UNREACHED after one send.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initDatabase, listAgentMessages, getApproval } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../notify.js', () => ({
  sendOwnerSlackDm: async () => ({ attempted: false, sent: false }),
  sendOwnerMessage: async () => ({ sent: true }),
  notifyChannel: async () => {},
  notifyTelegram: async () => {},
  notifySecurityEvent: async () => {},
}))
vi.mock('../owner-chat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../owner-chat.js')>()
  return { ...real, resolveOwnerChatId: () => '111' }
})
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'fo-agens', CHANNEL_PROVIDER: 'telegram', TELEGRAM_BOT_TOKEN: 'tg-token' }
})

const { tryHandleApprovals, ownerNotifyRetry } = await import('../web/routes/approvals.js')

type Step = 'reset' | 'timeout' | { status: number; body: string } | { id: number }
let script: Step[] = []
const sends: string[] = []
const slept: number[] = []
const REAL_DELAYS = [...ownerNotifyRetry.delaysMs]

/** The error AbortSignal.timeout() gives a fetch: the signal's own reason, a DOMException named TimeoutError. */
async function timeoutReason(): Promise<unknown> {
  const signal = AbortSignal.timeout(1)
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
  return signal.reason
}

function call(method: string, path: string, body: unknown = {}): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(status: number) { out.status = status; return res }, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) } }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body)
  const req: any = { on(event: string, cb: (chunk?: Buffer) => void) { if (event === 'data') cb(Buffer.from(bodyStr)); if (event === 'end') cb() } }
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}

const unreached = () => listAgentMessages(100).map((m) => m.content).filter((c) => c.includes('[OWNER_UNREACHED'))

/** Until the send chain is quiet: no new send and no new wait for 150 ms. */
const settle = async () => {
  for (let last = -1; ;) {
    const now = sends.length * 1000 + slept.length
    if (now === last) return
    last = now
    await new Promise((r) => setTimeout(r, 150))
  }
}

async function file(): Promise<string> {
  const { ctx, out } = call('POST', '/api/approvals', { agent_id: 'fo-agens', category: 'email_send', action_description: 'proba', timeout_seconds: 600 })
  await tryHandleApprovals(ctx)
  await settle()
  expect(out.status).toBe(201)
  return out.body.id as string
}

beforeEach(() => {
  initDatabase(':memory:')
  script = []
  sends.length = 0
  slept.length = 0
  ownerNotifyRetry.delaysMs = REAL_DELAYS
  ownerNotifyRetry.sleep = async (ms) => { slept.push(ms) }
  vi.stubGlobal('fetch', async (url: string) => {
    if (!String(url).startsWith('https://api.telegram.org/')) throw new Error(`a network call the test did not expect: ${String(url).slice(0, 40)}`)
    sends.push(String(url).split('/').pop() ?? '')
    const step = script.shift() ?? { id: 99 }
    if (step === 'reset') {
      // what Node's fetch throws on a reset connection: a TypeError "fetch failed" with the cause attached
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) })
    }
    if (step === 'timeout') throw await timeoutReason()
    if ('status' in step) return new Response(step.body, { status: step.status })
    return new Response(JSON.stringify({ ok: true, result: { message_id: step.id } }), { status: 200 })
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the real sender and the real logger in front of the retry', () => {
  it('a timeout once, then success: sent again, the message stamped, the owner not written off', async () => {
    script = ['timeout', { id: 556 }]
    const id = await file()
    expect(sends).toEqual(['sendMessage', 'sendMessage'])
    expect(slept).toEqual([1_000])
    expect(getApproval(id)?.telegram_message_id).toBe(556)
    expect(unreached()).toEqual([])
  })

  it('four timeouts in a row: four sends, then OWNER_UNREACHED once', async () => {
    script = ['timeout', 'timeout', 'timeout', 'timeout']
    const id = await file()
    expect(sends).toHaveLength(4)
    expect(slept).toEqual([1_000, 3_000, 9_000])
    const rows = unreached()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toContain('[OWNER_UNREACHED send-failed]')
    expect(rows[0]).toContain(`id=${id}`)
  })

  it('the measured case with the real error shape: a reset connection once, then success', async () => {
    script = ['reset', { id: 555 }]
    const id = await file()
    expect(sends).toHaveLength(2)
    expect(getApproval(id)?.telegram_message_id).toBe(555)
    expect(unreached()).toEqual([])
  })

  it('the sender\'s own error texts decide: 502 and 429 are sent again, 400 and 403 are not', async () => {
    for (const [status, again] of [[502, true], [429, true], [400, false], [403, false]] as const) {
      // a fresh store each time: a new request for the same thing closes the one before it, and that edits the
      // earlier Telegram message, which is a network call of its own
      initDatabase(':memory:')
      sends.length = 0
      slept.length = 0
      script = [{ status, body: `{"ok":false,"error_code":${status},"description":"x"}` }, { id: 7 }]
      await file()
      expect(sends, `HTTP ${status}`).toEqual(again ? ['sendMessage', 'sendMessage'] : ['sendMessage'])
    }
  })

  it('HTTP 429 with the wait the server names: that long, up to the cap', async () => {
    script = [{ status: 429, body: '{"ok":false,"error_code":429,"description":"Too Many Requests: retry after 7","parameters":{"retry_after":7}}' }, { id: 8 }]
    await file()
    expect(slept).toEqual([7_000])
  })
})
