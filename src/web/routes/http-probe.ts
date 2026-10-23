// POST /api/http-probe -- one read-only, deterministic HTTP measurement (src/web/http-probe.ts).
//
// Body: { "url": "https://...", "method"?: "GET" | "HEAD", "follow"?: boolean, "contains"?: string[] }
// Answer: status, Location, content type, body sha256, <title>, and per `contains` needle the
// byte-exact hit count, offset and surrounding bytes. Refusals come back as 4xx with a reason.
// Token and session callers only: a federated peer or a device key gets 403, so the probe is
// never a relay for someone outside the fleet. Every probe is logged with the self-asserted
// X-Agent-Id, and a simple global rate limit keeps it a measuring tool, not a crawler.
import { readBody, json } from '../http-helpers.js'
import { logger } from '../../logger.js'
import { parseProbeInput, probe, liveProbeDeps, type ProbeDeps } from '../http-probe.js'
import type { RouteContext } from './types.js'

const PATH = '/api/http-probe'
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 30
let recent: number[] = []

export function rateLimited(now: number): boolean {
  recent = recent.filter((t) => now - t < RATE_WINDOW_MS)
  if (recent.length >= RATE_MAX) return true
  recent.push(now)
  return false
}
export function resetHttpProbeRateLimit(): void { recent = [] }

export async function tryHandleHttpProbe(ctx: RouteContext, deps: () => ProbeDeps = liveProbeDeps): Promise<boolean> {
  if (ctx.path !== PATH) return false
  if (ctx.method !== 'POST') { json(ctx.res, { error: 'POST only' }, 405); return true }
  const kind = ctx.auth?.kind
  if (ctx.fedPeer || (kind !== 'token' && kind !== 'session')) {
    json(ctx.res, { error: 'the probe is for the fleet\'s own callers (dashboard token or session)' }, 403)
    return true
  }
  let body: unknown
  try { body = JSON.parse((await readBody(ctx.req, { maxBytes: 8 * 1024 })).toString()) } catch {
    json(ctx.res, { ok: false, reason: 'bad-request', detail: 'invalid JSON' }, 400)
    return true
  }
  const input = parseProbeInput(body)
  if (typeof input === 'string') { json(ctx.res, { ok: false, reason: 'bad-request', detail: input }, 400); return true }
  if (rateLimited(Date.now())) { json(ctx.res, { ok: false, reason: 'rate-limited', detail: `max ${RATE_MAX} probes per minute` }, 429); return true }
  const r = await probe(input, deps())
  logger.info({
    agent: ctx.auth?.agent ?? null, url: input.url, method: input.method, follow: input.follow,
    ok: r.ok, reason: r.ok ? undefined : r.reason, status: r.ok ? r.final.status : undefined, hops: r.ok ? r.hops.length : undefined,
  }, 'http-probe')
  if (r.ok) { json(ctx.res, r); return true }
  const status = r.reason === 'bad-url' ? 400 : r.reason === 'host-not-allowed' || r.reason === 'non-public-address' ? 403 : 502
  json(ctx.res, r, status)
  return true
}
