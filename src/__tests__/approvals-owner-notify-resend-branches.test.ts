// APPROVALNOTIFYRETRY1118, second review of PR #56: what the notification answers on the branches the retry did not
// touch, the owner's Slack DM and a channel provider other than Telegram. The re-send route answers 200 or 502 from that
// answer, and a failed RE-SEND writes no in-band row while a failed first notification still does. The review turned
// each answer round (a Slack failure as "sent", a provider success as "not sent") and the other tests stayed green.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { initDatabase, listAgentMessages } from '../db.js'
import type { RouteContext } from '../web/routes/types.js'

const { cfg } = vi.hoisted(() => ({
  cfg: {
    provider: 'discord' as string,
    slack: { attempted: false, sent: false } as { attempted: boolean; sent: boolean; error?: string },
    owner: { sent: true } as { sent: boolean; reason?: string },
  },
}))
const telegramSends: unknown[] = []
vi.mock('../notify.js', () => ({
  sendOwnerSlackDm: async () => cfg.slack,
  sendOwnerMessage: async () => cfg.owner,
  notifyChannel: async () => {},
  notifyTelegram: async () => {},
  notifySecurityEvent: async () => {},
}))
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: async (...args: unknown[]) => { telegramSends.push(args); return 1 },
  editTelegramMessageText: async () => true,
}))
vi.mock('../owner-chat.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../owner-chat.js')>()
  return { ...real, resolveOwnerChatId: () => '111' }
})
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'fo-agens', TELEGRAM_BOT_TOKEN: '', get CHANNEL_PROVIDER() { return cfg.provider } }
})

const { tryHandleApprovals } = await import('../web/routes/approvals.js')

function call(method: string, path: string, body: unknown = {}): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(status: number) { out.status = status; return res }, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) } }
  const url = new URL(`http://localhost:3420${path}`)
  const bodyStr = JSON.stringify(body)
  const req: any = { on(event: string, cb: (chunk?: Buffer) => void) { if (event === 'data') cb(Buffer.from(bodyStr)); if (event === 'end') cb() } }
  return { ctx: { req, res, path: url.pathname, method, url } as RouteContext, out }
}
const unreached = () => listAgentMessages(100).map((m) => m.content).filter((c) => c.includes('[OWNER_UNREACHED'))
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)) }
async function file(): Promise<string> {
  const { ctx, out } = call('POST', '/api/approvals', { agent_id: 'fo-agens', category: 'email_send', action_description: 'proba', timeout_seconds: 600 })
  await tryHandleApprovals(ctx)
  await settle()
  expect(out.status).toBe(201)
  return out.body.id as string
}
async function resend(id: string) {
  const { ctx, out } = call('POST', `/api/approvals/${id}/notify`)
  await tryHandleApprovals(ctx)
  return out
}

beforeEach(() => {
  initDatabase(':memory:')
  telegramSends.length = 0
  cfg.provider = 'discord'
  cfg.slack = { attempted: false, sent: false }
  cfg.owner = { sent: true }
})

describe('the owner\'s Slack DM', () => {
  it('sent: the re-send answers 200, nothing in band', async () => {
    cfg.slack = { attempted: true, sent: true }
    const id = await file()
    expect(unreached()).toEqual([])
    const out = await resend(id)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, sent: true })
    expect(unreached()).toEqual([])
    expect(telegramSends).toHaveLength(0)
  })

  it('failed: the first notification writes OWNER_UNREACHED once, the re-send answers 502 and writes none', async () => {
    cfg.slack = { attempted: true, sent: false, error: 'ratelimited' }
    const id = await file()
    expect(unreached()).toHaveLength(1)
    expect(unreached()[0]).toContain('[OWNER_UNREACHED send-failed]')
    const out = await resend(id)
    expect(out.status).toBe(502)
    expect(out.body).toEqual({ ok: false, sent: false })
    expect(unreached()).toHaveLength(1)
  })

  it('no token and no target are a failure too: 502, and the first notification names the reason', async () => {
    for (const [error, reason] of [['no_slack_token', 'no-token'], ['unresolved_target: x', 'no-owner-chat']] as const) {
      initDatabase(':memory:')
      cfg.slack = { attempted: true, sent: false, error }
      const id = await file()
      expect(unreached(), error).toHaveLength(1)
      expect(unreached()[0], error).toContain(`[OWNER_UNREACHED ${reason}]`)
      expect((await resend(id)).status, error).toBe(502)
      expect(unreached(), error).toHaveLength(1)
    }
  })
})

describe('a channel provider other than Telegram', () => {
  it('sent: the re-send answers 200, nothing in band, and Telegram is not called', async () => {
    cfg.owner = { sent: true }
    const id = await file()
    const out = await resend(id)
    expect(out.status).toBe(200)
    expect(out.body).toEqual({ ok: true, sent: true })
    expect(unreached()).toEqual([])
    expect(telegramSends).toHaveLength(0)
  })

  it('failed, whatever the reason: the first notification writes OWNER_UNREACHED once, the re-send answers 502 and writes none', async () => {
    for (const [reason, marker] of [['send-failed', 'send-failed'], ['no-token', 'no-token'], ['no-owner-chat', 'no-owner-chat'], ['partial', 'send-failed']] as const) {
      initDatabase(':memory:')
      cfg.owner = { sent: false, reason }
      const id = await file()
      expect(unreached(), reason).toHaveLength(1)
      expect(unreached()[0], reason).toContain(`[OWNER_UNREACHED ${marker}]`)
      const out = await resend(id)
      expect(out.status, reason).toBe(502)
      expect(out.body, reason).toEqual({ ok: false, sent: false })
      expect(unreached(), reason).toHaveLength(1)
    }
  })
})
