// Read-only HTTP measurement for the fleet's own and client sites (Marveen 4437).
//
// The QA agent (ellenor) has to prove things like "this URL answers 404", "that one redirects to
// X" or "the live page carries this sentence". Its only way out was the quarantine-reader, whose
// content is a MODEL-RECONSTRUCTED description of the page (WEBFETCHFAB819): a status code or a
// text match read off it is weak evidence. A Bash curl is cut by the egress gate, and the vendor
// allowlist (store/egress-vendor-hosts.json) would let EVERY curl shape through, POST included.
//
// This is the narrow middle: the dashboard itself makes ONE request, deterministically, and
// returns what came back byte-exact. It cannot be bent into anything else:
//   - GET or HEAD only, no request body, no caller headers, no cookies, a fixed User-Agent;
//   - only hosts on an owner-kept allowlist (store/http-probe-hosts.json: exact "hosts" or
//     label-boundary "domains", the same shape rules as the vendor list); empty or missing = none;
//   - http/https on the default port, no userinfo, no IP literal, and every address the name
//     resolves to must be public (no loopback / private / link-local / CGNAT / multicast);
//   - redirects are NOT followed silently: each hop is reported, and a hop is only taken when
//     the caller asks (follow) and its host is allowlisted too;
//   - the body is read up to MAX_BODY_BYTES; the result carries its sha256, a <title>, and for
//     each `contains` needle whether it occurs in the RAW bytes, how often, where, and the bytes
//     around the first hit -- never the whole body.
// What it does not stop: a resolver answer that changes between the check and the connect (the
// fetch resolves again). The allowlist is the real fence; the address check is a second one.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { STORE_DIR } from '../config.js'

export const HTTP_PROBE_HOSTS_PATH = join(STORE_DIR, 'http-probe-hosts.json')
export const MAX_BODY_BYTES = 1024 * 1024
export const MAX_HOPS = 5
export const PROBE_TIMEOUT_MS = 15_000
export const USER_AGENT = 'marveen-http-probe/1 (read-only QA)'
const MAX_NEEDLES = 5
const MAX_NEEDLE_LEN = 200
const CONTEXT_BYTES = 60

const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export interface ProbeAllowlist { hosts: Set<string>; domains: Set<string> }

export function parseProbeAllowlist(raw: unknown): ProbeAllowlist {
  const pick = (k: string) => {
    const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[k] : undefined
    return new Set((Array.isArray(v) ? v : []).filter((h): h is string => typeof h === 'string' && DNS_NAME.test(h)))
  }
  return { hosts: pick('hosts'), domains: pick('domains') }
}

export function loadProbeAllowlist(path = HTTP_PROBE_HOSTS_PATH): ProbeAllowlist {
  try { return parseProbeAllowlist(JSON.parse(readFileSync(path, 'utf-8'))) } catch { return { hosts: new Set(), domains: new Set() } }
}

export function hostAllowed(host: string, allow: ProbeAllowlist): boolean {
  if (allow.hosts.has(host)) return true
  for (const d of allow.domains) if (host === d || host.endsWith(`.${d}`)) return true
  return false
}

/** Loopback, private, link-local, CGNAT, multicast, reserved, unspecified -- anything not public. */
export function isNonPublicAddress(addr: string): boolean {
  const v = isIP(addr)
  if (v === 4) {
    const [a, b] = addr.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19))
  }
  if (v === 6) {
    const x = addr.toLowerCase()
    if (x === '::' || x === '::1') return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x)
    if (mapped) return isNonPublicAddress(mapped[1])
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x)
  }
  return true
}

export type ProbeRefusal = 'bad-request' | 'bad-url' | 'host-not-allowed' | 'non-public-address' | 'dns-failed' | 'timeout' | 'network-error'

export interface NeedleResult { needle: string; found: boolean; count: number; firstOffset: number | null; context: string | null }
export interface ProbeHop {
  url: string
  status: number
  location: string | null
  contentType: string | null
  contentLength: string | null
  bodyBytes: number
  truncated: boolean
  bodySha256: string | null
  title: string | null
  contains: NeedleResult[]
}
export type ProbeResult =
  | { ok: true; method: 'GET' | 'HEAD'; hops: ProbeHop[]; final: ProbeHop; stoppedAt?: { url: string; reason: ProbeRefusal }; ms: number }
  | { ok: false; reason: ProbeRefusal; detail: string; hops?: ProbeHop[] }

export interface ProbeInput { url: string; method: 'GET' | 'HEAD'; follow: boolean; contains: string[] }

/** Validates the request body; a string is the reason for a 400. */
export function parseProbeInput(body: unknown): ProbeInput | string {
  if (!body || typeof body !== 'object') return 'body must be a JSON object'
  const b = body as Record<string, unknown>
  if (typeof b.url !== 'string' || b.url.length > 2048) return 'url (string, max 2048) is required'
  const method = b.method === undefined ? 'GET' : b.method
  if (method !== 'GET' && method !== 'HEAD') return 'method must be GET or HEAD'
  const contains = b.contains === undefined ? [] : b.contains
  if (!Array.isArray(contains) || contains.length > MAX_NEEDLES || contains.some((n) => typeof n !== 'string' || n.length === 0 || n.length > MAX_NEEDLE_LEN)) {
    return `contains must be up to ${MAX_NEEDLES} non-empty strings of at most ${MAX_NEEDLE_LEN} characters`
  }
  if (b.follow !== undefined && typeof b.follow !== 'boolean') return 'follow must be a boolean'
  return { url: b.url, method, follow: b.follow === true, contains: contains as string[] }
}

/** http/https, default port, no userinfo, a DNS name (not an IP literal). */
export function checkUrlShape(raw: string): URL | string {
  let u: URL
  try { u = new URL(raw) } catch { return 'not a URL' }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'only http and https'
  if (u.username || u.password) return 'no userinfo'
  if (u.port) return 'no explicit port'
  if (!DNS_NAME.test(u.hostname)) return 'the host must be a DNS name, not an IP or a single label'
  return u
}

export function findNeedles(body: Buffer, needles: string[]): NeedleResult[] {
  return needles.map((needle) => {
    const n = Buffer.from(needle, 'utf-8')
    let count = 0
    let first = -1
    for (let i = body.indexOf(n); i !== -1; i = body.indexOf(n, i + n.length)) {
      if (first === -1) first = i
      count++
    }
    const context = first === -1 ? null
      : body.subarray(Math.max(0, first - CONTEXT_BYTES), Math.min(body.length, first + n.length + CONTEXT_BYTES)).toString('utf-8')
    return { needle, found: first !== -1, count, firstOffset: first === -1 ? null : first, context }
  })
}

export function extractTitle(body: Buffer): string | null {
  const m = /<title[^>]*>([\s\S]{0,500}?)<\/title>/i.exec(body.toString('utf-8'))
  return m ? m[1].trim() : null
}

export interface ProbeDeps {
  fetch: typeof fetch
  lookup: (host: string) => Promise<string[]>
  allow: ProbeAllowlist
  now: () => number
}

export const liveProbeDeps = (): ProbeDeps => ({
  fetch,
  lookup: async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address),
  allow: loadProbeAllowlist(),
  now: () => Date.now(),
})

async function readCapped(res: Response): Promise<{ body: Buffer; truncated: boolean }> {
  if (!res.body) return { body: Buffer.alloc(0), truncated: false }
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const room = MAX_BODY_BYTES - total
    if (value.length > room) {
      chunks.push(Buffer.from(value.subarray(0, room)))
      total += room
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(Buffer.from(value))
    total += value.length
  }
  return { body: Buffer.concat(chunks), truncated }
}

/** Gate one URL: shape, allowlist, public addresses. A `url` result may be requested. */
async function gate(raw: string, deps: ProbeDeps): Promise<{ url: URL } | { reason: ProbeRefusal; detail: string }> {
  const u = checkUrlShape(raw)
  if (typeof u === 'string') return { reason: 'bad-url', detail: u }
  if (!hostAllowed(u.hostname, deps.allow)) return { reason: 'host-not-allowed', detail: `${u.hostname} is not in store/http-probe-hosts.json` }
  let addrs: string[]
  try { addrs = await deps.lookup(u.hostname) } catch (err) { return { reason: 'dns-failed', detail: (err as Error).message } }
  if (addrs.length === 0) return { reason: 'dns-failed', detail: 'no address' }
  const bad = addrs.find(isNonPublicAddress)
  if (bad) return { reason: 'non-public-address', detail: `${u.hostname} resolves to ${bad}` }
  return { url: u }
}

export async function probe(input: ProbeInput, deps: ProbeDeps): Promise<ProbeResult> {
  const started = deps.now()
  const hops: ProbeHop[] = []
  let next = input.url
  for (let i = 0; i <= MAX_HOPS; i++) {
    const g = await gate(next, deps)
    if ('reason' in g) {
      if (hops.length === 0) return { ok: false, reason: g.reason, detail: g.detail }
      return { ok: true, method: input.method, hops, final: hops[hops.length - 1], stoppedAt: { url: next, reason: g.reason }, ms: deps.now() - started }
    }
    let res: Response
    try {
      res = await deps.fetch(g.url.href, {
        method: input.method,
        redirect: 'manual',
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
    } catch (err) {
      const e = err as Error
      const reason: ProbeRefusal = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network-error'
      return { ok: false, reason, detail: e.message, hops }
    }
    const { body, truncated } = input.method === 'HEAD' ? { body: Buffer.alloc(0), truncated: false } : await readCapped(res)
    const location = res.headers.get('location')
    const hop: ProbeHop = {
      url: g.url.href,
      status: res.status,
      location,
      contentType: res.headers.get('content-type'),
      contentLength: res.headers.get('content-length'),
      bodyBytes: body.length,
      truncated,
      bodySha256: input.method === 'HEAD' ? null : createHash('sha256').update(body).digest('hex'),
      title: input.method === 'HEAD' ? null : extractTitle(body),
      contains: input.method === 'HEAD' ? [] : findNeedles(body, input.contains),
    }
    hops.push(hop)
    const redirect = res.status >= 300 && res.status < 400 && location
    if (!redirect || !input.follow) break
    try { next = new URL(location, g.url).href } catch { break }
  }
  return { ok: true, method: input.method, hops, final: hops[hops.length - 1], ms: deps.now() - started }
}
