import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash } from 'node:crypto'
// The read-only HTTP probe (src/web/http-probe.ts) is the QA agent's deterministic measurement
// of a live site: status, Location, byte-exact text. Both directions are pinned: an allowlisted
// public host is measured; anything else (other hosts, private addresses, odd URL shapes, other
// methods, federated callers) never leaves the dashboard -- the fake fetch is not even called.
import {
  parseProbeAllowlist, hostAllowed, isNonPublicAddress, checkUrlShape, parseProbeInput, findNeedles,
  extractTitle, probe, MAX_BODY_BYTES, USER_AGENT, type ProbeDeps,
} from '../web/http-probe.js'
import { tryHandleHttpProbe, resetHttpProbeRateLimit } from '../web/routes/http-probe.js'
import type { RouteContext } from '../web/routes/types.js'

const ALLOW = parseProbeAllowlist({ hosts: ['www.example-client.hu'], domains: ['example-shop.com'] })

function deps(pages: Record<string, { status: number; body?: string | Buffer; headers?: Record<string, string> }>, addrs: Record<string, string[]> = {}): ProbeDeps & { calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = []
  return {
    calls,
    allow: ALLOW,
    now: () => 0,
    lookup: async (host) => addrs[host] ?? ['93.184.216.34'],
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      const p = pages[url]
      if (!p) throw new Error(`unexpected fetch ${url}`)
      const body = typeof p.body === 'string' || p.body === undefined ? (p.body ?? '') : new Uint8Array(p.body)
      return new Response(body, { status: p.status, headers: p.headers })
    }) as unknown as typeof fetch,
  }
}

describe('allowlist and URL shape', () => {
  it('exact hosts, and domains on a label boundary only', () => {
    expect(hostAllowed('www.example-client.hu', ALLOW)).toBe(true)
    expect(hostAllowed('example-client.hu', ALLOW)).toBe(false)
    expect(hostAllowed('shop.example-shop.com', ALLOW)).toBe(true)
    expect(hostAllowed('example-shop.com', ALLOW)).toBe(true)
    expect(hostAllowed('evilexample-shop.com', ALLOW)).toBe(false)
    expect(hostAllowed('example-shop.com.evil.net', ALLOW)).toBe(false)
  })
  it('malformed entries never widen the list; a missing file is an empty list', () => {
    const a = parseProbeAllowlist({ hosts: ['*.x.com', '10.0.0.1', 'localhost', 'ok.example.org'], domains: ['.bad.com', 'com'] })
    expect([...a.hosts]).toEqual(['ok.example.org'])
    expect([...a.domains]).toEqual([])
    expect(parseProbeAllowlist(null).hosts.size).toBe(0)
  })
  it('only http/https, default port, no userinfo, a DNS name', () => {
    expect(checkUrlShape('https://www.example-client.hu/a?b=1')).toBeInstanceOf(URL)
    expect(checkUrlShape('ftp://www.example-client.hu/')).toBe('only http and https')
    expect(checkUrlShape('https://u:p@www.example-client.hu/')).toBe('no userinfo')
    expect(checkUrlShape('https://www.example-client.hu:8443/')).toBe('no explicit port')
    expect(typeof checkUrlShape('https://93.184.216.34/')).toBe('string')
    expect(typeof checkUrlShape('http://localhost/')).toBe('string')
  })
  it('non-public addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.23', '169.254.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isNonPublicAddress(a), a).toBe(true)
    }
    for (const a of ['93.184.216.34', '76.76.21.21', '2606:4700::1111']) expect(isNonPublicAddress(a), a).toBe(false)
  })
  it('the request body: GET/HEAD only, bounded needles', () => {
    expect(parseProbeInput({ url: 'https://www.example-client.hu/' })).toEqual({ url: 'https://www.example-client.hu/', method: 'GET', follow: false, contains: [] })
    expect(typeof parseProbeInput({ url: 'https://www.example-client.hu/', method: 'POST' })).toBe('string')
    expect(typeof parseProbeInput({ url: 'https://www.example-client.hu/', contains: ['a', 'b', 'c', 'd', 'e', 'f'] })).toBe('string')
    expect(typeof parseProbeInput({ url: 'https://www.example-client.hu/', contains: [''] })).toBe('string')
  })
})

describe('probe', () => {
  it('a host that is not allowlisted is refused before any request', async () => {
    const d = deps({})
    const r = await probe({ url: 'https://www.other-site.hu/', method: 'GET', follow: false, contains: [] }, d)
    expect(r).toMatchObject({ ok: false, reason: 'host-not-allowed' })
    expect(d.calls).toEqual([])
  })
  it('an allowlisted name that resolves to a private address is refused before any request', async () => {
    const d = deps({}, { 'www.example-client.hu': ['93.184.216.34', '192.168.1.23'] })
    const r = await probe({ url: 'https://www.example-client.hu/', method: 'GET', follow: false, contains: [] }, d)
    expect(r).toMatchObject({ ok: false, reason: 'non-public-address' })
    expect(d.calls).toEqual([])
  })
  it('GET: status, sha256, title and byte-exact needles; a fixed request with no body', async () => {
    const html = '<html><head><title> Eladó Audi A4 </title></head><body>Ár: 4 990 000 Ft. Ár: újra</body></html>'
    const d = deps({ 'https://www.example-client.hu/kinalat/x': { status: 404, body: html, headers: { 'content-type': 'text/html; charset=utf-8' } } })
    const r = await probe({ url: 'https://www.example-client.hu/kinalat/x', method: 'GET', follow: false, contains: ['Ár:', 'nincs ilyen'] }, d)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.final.status).toBe(404)
    expect(r.final.title).toBe('Eladó Audi A4')
    expect(r.final.bodySha256).toBe(createHash('sha256').update(Buffer.from(html, 'utf-8')).digest('hex'))
    expect(r.final.contains[0]).toMatchObject({ needle: 'Ár:', found: true, count: 2, firstOffset: Buffer.from(html).indexOf(Buffer.from('Ár:')) })
    expect(r.final.contains[0].context).toContain('Ár: 4 990 000 Ft.')
    expect(r.final.contains[1]).toEqual({ needle: 'nincs ilyen', found: false, count: 0, firstOffset: null, context: null })
    expect(d.calls).toHaveLength(1)
    const init = d.calls[0].init
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('manual')
    expect(init.body).toBeUndefined()
    expect(init.headers).toEqual({ 'User-Agent': USER_AGENT, Accept: '*/*' })
  })
  it('a redirect is reported, not followed, unless asked', async () => {
    const pages = {
      'https://www.example-client.hu/regi': { status: 308, headers: { location: '/uj' } },
      'https://www.example-client.hu/uj': { status: 200, body: 'kesz' },
    }
    const once = deps(pages)
    const r1 = await probe({ url: 'https://www.example-client.hu/regi', method: 'GET', follow: false, contains: [] }, once)
    expect(r1.ok && r1.final).toMatchObject({ status: 308, location: '/uj' })
    expect(once.calls).toHaveLength(1)
    const both = deps(pages)
    const r2 = await probe({ url: 'https://www.example-client.hu/regi', method: 'GET', follow: true, contains: ['kesz'] }, both)
    expect(r2.ok && r2.hops.map((h) => h.status)).toEqual([308, 200])
    expect(r2.ok && r2.final.contains[0].found).toBe(true)
  })
  it('a redirect to a host off the list stops there, without requesting it', async () => {
    const d = deps({ 'https://www.example-client.hu/ki': { status: 302, headers: { location: 'https://tracker.elsewhere.net/x' } } })
    const r = await probe({ url: 'https://www.example-client.hu/ki', method: 'GET', follow: true, contains: [] }, d)
    expect(r).toMatchObject({ ok: true, stoppedAt: { url: 'https://tracker.elsewhere.net/x', reason: 'host-not-allowed' } })
    expect(d.calls).toHaveLength(1)
  })
  it('HEAD reads no body', async () => {
    const d = deps({ 'https://shop.example-shop.com/': { status: 200, body: 'x' } })
    const r = await probe({ url: 'https://shop.example-shop.com/', method: 'HEAD', follow: false, contains: [] }, d)
    expect(r.ok && r.final).toMatchObject({ status: 200, bodyBytes: 0, bodySha256: null })
  })
  it('a large body is cut at MAX_BODY_BYTES and says so', async () => {
    const d = deps({ 'https://shop.example-shop.com/big': { status: 200, body: Buffer.alloc(MAX_BODY_BYTES + 10, 97) } })
    const r = await probe({ url: 'https://shop.example-shop.com/big', method: 'GET', follow: false, contains: [] }, d)
    expect(r.ok && r.final).toMatchObject({ bodyBytes: MAX_BODY_BYTES, truncated: true })
  })
})

describe('pure helpers', () => {
  it('needles are matched on raw bytes', () => {
    expect(findNeedles(Buffer.from('aXaXa'), ['a'])[0]).toMatchObject({ count: 3, firstOffset: 0 })
    expect(extractTitle(Buffer.from('<TITLE>x</TITLE>'))).toBe('x')
  })
})

function ctx(auth: RouteContext['auth'], body: unknown, fedPeer: string | null = null): { c: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) } }
  const s = JSON.stringify(body)
  const req: any = { on(ev: string, cb: (c?: Buffer) => void) { if (ev === 'data') cb(Buffer.from(s)); if (ev === 'end') cb() } }
  return { c: { req, res, path: '/api/http-probe', method: 'POST', url: new URL('http://localhost/api/http-probe'), auth, fedPeer } as RouteContext, out }
}

describe('route', () => {
  beforeEach(() => resetHttpProbeRateLimit())
  const page = () => deps({ 'https://www.example-client.hu/': { status: 200, body: 'ok' } })
  it('a dashboard-token caller gets the measurement', async () => {
    const { c, out } = ctx({ kind: 'token', agent: 'ellenor' }, { url: 'https://www.example-client.hu/' })
    await tryHandleHttpProbe(c, page)
    expect(out.status).toBe(200)
    expect(out.body.final.status).toBe(200)
  })
  it('a federated peer or a device key is refused, and nothing is requested', async () => {
    const d = page()
    for (const [auth, fed] of [[{ kind: 'federation', peer: 'x' }, 'x'], [{ kind: 'device', device: 'k' }, null]] as const) {
      const { c, out } = ctx(auth as RouteContext['auth'], { url: 'https://www.example-client.hu/' }, fed)
      await tryHandleHttpProbe(c, () => d)
      expect(out.status).toBe(403)
    }
    expect(d.calls).toEqual([])
  })
  it('a host off the list is 403, a bad method 400', async () => {
    const a = ctx({ kind: 'token' }, { url: 'https://www.other-site.hu/' })
    await tryHandleHttpProbe(a.c, page)
    expect(a.out.status).toBe(403)
    const b = ctx({ kind: 'token' }, { url: 'https://www.example-client.hu/', method: 'POST' })
    await tryHandleHttpProbe(b.c, page)
    expect(b.out.status).toBe(400)
  })
  it('a rate limit keeps it a measuring tool', async () => {
    let last = 0
    for (let i = 0; i < 31; i++) {
      const { c, out } = ctx({ kind: 'token' }, { url: 'https://www.example-client.hu/' })
      await tryHandleHttpProbe(c, page)
      last = out.status
    }
    expect(last).toBe(429)
  })
  it('other paths are not handled', async () => {
    const { c } = ctx({ kind: 'token' }, {})
    c.path = '/api/other'
    expect(await tryHandleHttpProbe(c, vi.fn() as any)).toBe(false)
  })
})
