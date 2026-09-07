// The WebFetch egress gate: what it blocks, and what it now records about a
// block.
//
// The gate decides on the URL alone, so a main agent and a quarantine-reader
// sub-agent look identical to it -- which is why the sub-agent path the block
// message prescribes is itself blocked (kanban #224). Whether a caller-aware
// tier can be built at all depends on the PreToolUse payload carrying a field
// that identifies the caller, and that question is answered by recording the
// payload's FIELD NAMES on every block. Names only: this log is read casually
// and a value could be a url, a prompt or a secret.
//
// The gate is a .mjs hook script run by Claude Code, not application code. It
// guards its own entry point (isInvokedDirectly), so importing it here runs no
// side effects.
import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { isEgressBlocked, egressDecision, payloadKeySignature, isPublicFetchTarget } from '../../scripts/hooks/egress-gate.mjs'
import { isPublicFetchHost } from '../web/agent-scaffold.js'

const QUARANTINE = 'quarantine-reader'
const EMPTY = { domains: [], prefixes: [], quarantineDomains: [] }

describe('what the gate lets through', () => {
  it('passes a built-in allowed prefix', () => {
    expect(isEgressBlocked('WebFetch', { url: 'https://api.github.com/repos/a/b' })).toBe(false)
  })

  it('blocks arbitrary web content', () => {
    expect(isEgressBlocked('WebFetch', { url: 'https://hnrss.org/frontpage' })).toBe(true)
  })

  it('ignores every tool that is not WebFetch', () => {
    expect(isEgressBlocked('Bash', { command: 'curl https://hnrss.org/frontpage' })).toBe(false)
  })

  it('does not fall for a prefix-extension lookalike', () => {
    // 'https://api.github.com.evil.com/' does not start with the allowed
    // prefix, because the prefix carries its trailing slash.
    expect(isEgressBlocked('WebFetch', { url: 'https://api.github.com.evil.com/x' })).toBe(true)
  })

  it('matches a runtime domain on the hostname, not on the string', () => {
    const list = { domains: ['api.frankfurter.app'], prefixes: [] }
    expect(isEgressBlocked('WebFetch', { url: 'https://api.frankfurter.app/latest' }, list)).toBe(false)
    // The domain appearing in a query string must not open the gate.
    expect(isEgressBlocked('WebFetch', { url: 'https://evil.com/?x=api.frankfurter.app' }, list)).toBe(true)
  })

  it('allows a subdomain of a runtime domain', () => {
    const list = { domains: ['example.com'], prefixes: [] }
    expect(isEgressBlocked('WebFetch', { url: 'https://docs.example.com/x' }, list)).toBe(false)
  })

  it('blocks an unparseable url instead of throwing', () => {
    expect(isEgressBlocked('WebFetch', { url: 'not a url' }, { domains: ['example.com'], prefixes: [] })).toBe(true)
  })
})

// The tier that made the gate's own escape hatch usable. A sub-agent payload
// carries `agent_type`, a main agent's does not (measured 2026-08-03) -- that
// field, and nothing else, separates the two.
describe('the quarantine tier', () => {
  const feed = { url: 'https://techcrunch.com/feed/' }

  it('lets the quarantine-reader fetch a feed on its list', () => {
    expect(isEgressBlocked('WebFetch', feed, EMPTY, QUARANTINE)).toBe(false)
    expect(egressDecision('WebFetch', feed, EMPTY, QUARANTINE).tier).toBe('quarantine')
  })

  it('STILL blocks the same url for a main agent', () => {
    // The property the whole design rests on: opening the tier for the
    // sub-agent must not open it for everyone. A main agent fetching a news
    // feed puts unwrapped, untrusted text straight into its own context.
    expect(isEgressBlocked('WebFetch', feed, EMPTY, '')).toBe(true)
    expect(isEgressBlocked('WebFetch', feed, EMPTY, undefined)).toBe(true)
  })

  it('blocks a domain the quarantine-reader was never given', () => {
    expect(isEgressBlocked('WebFetch', { url: 'https://evil.example/feed' }, EMPTY, QUARANTINE)).toBe(true)
  })

  it('fails closed on anything that is not an exact agent_type match', () => {
    // A typo, a rename, a spoofed-looking value: all fall through to the
    // block. A mistake here can only deny a fetch, never grant one.
    for (const bad of ['quarantine_reader', 'Quarantine-Reader', 'quarantine-reader ', 'general-purpose', null, 42]) {
      expect(isEgressBlocked('WebFetch', feed, EMPTY, bad as never)).toBe(true)
    }
  })

  it('holds the reddit promise its definition makes: RSS only', () => {
    // The sub-agent's definition allows reddit RSS feeds; hostname matching
    // alone would hand over the whole site, including the json endpoints a
    // main agent was blocked from earlier.
    expect(isEgressBlocked('WebFetch', { url: 'https://www.reddit.com/r/devops/new.rss' }, EMPTY, QUARANTINE)).toBe(false)
    expect(isEgressBlocked('WebFetch', { url: 'https://www.reddit.com/r/devops/about/rules.json' }, EMPTY, QUARANTINE)).toBe(true)
  })

  it('inherits the ordinary allowlist rather than replacing it', () => {
    expect(isEgressBlocked('WebFetch', { url: 'https://api.github.com/x' }, EMPTY, QUARANTINE)).toBe(false)
  })

  it('takes operator additions from quarantine_domains -- for the sub-agent only', () => {
    const list = { domains: [], prefixes: [], quarantineDomains: ['feeds.example.org'] }
    expect(isEgressBlocked('WebFetch', { url: 'https://feeds.example.org/rss' }, list, QUARANTINE)).toBe(false)
    // Putting a domain in the quarantine list must not open it to a main agent.
    expect(isEgressBlocked('WebFetch', { url: 'https://feeds.example.org/rss' }, list, '')).toBe(true)
  })

  it('reports the tier so the grant can be audited', () => {
    // A fetch nobody can see is a hole nobody can find: the entry point logs
    // an ALLOWED_QUARANTINE line off this tier.
    expect(egressDecision('WebFetch', { url: 'https://api.github.com/x' }, EMPTY, QUARANTINE).tier).toBe('builtin')
    expect(egressDecision('WebFetch', feed, EMPTY, QUARANTINE).tier).toBe('quarantine')
    expect(egressDecision('WebFetch', feed, EMPTY, '').tier).toBe('none')
  })
})

describe('what a block records about the caller', () => {
  it('lists the payload field names, sorted', () => {
    const keys = payloadKeySignature({
      tool_name: 'WebFetch',
      session_id: 's1',
      cwd: '/home/x',
      tool_input: { url: 'https://hnrss.org/frontpage' },
    })
    expect(keys).toBe('cwd,session_id,tool_input,tool_name')
  })

  it('never records a value -- not from the top level, not from a nested object', () => {
    // The whole point: this line goes into a log an operator greps. A url, a
    // prompt or a token must not ride along with the diagnostic.
    const keys = payloadKeySignature({
      tool_name: 'WebFetch',
      tool_input: { url: 'https://secret.example/path?token=SHOULD-NOT-APPEAR' },
      transcript_path: '/home/viktor/.claude/projects/p/SHOULD-NOT-APPEAR.jsonl',
    })
    expect(keys).not.toContain('SHOULD-NOT-APPEAR')
    expect(keys).not.toContain('https://')
    expect(keys).toBe('tool_input,tool_name,transcript_path')
  })

  it('survives a payload that is not an object', () => {
    for (const bad of [null, undefined, 'string', 42, ['a']]) {
      expect(payloadKeySignature(bad as never)).toBe('')
    }
  })
})

// The operator sentinel: quarantine_domains: ["*"] opens the QUARANTINE tier to
// every public host. It exists because the previous attempt at "no limits" -- a
// list of bare TLDs -- was silently a one-entry list by the time it reached the
// reader's rendered prompt (see src/__tests__/quarantine-allowlist-render.test.ts).
describe('the quarantine wildcard', () => {
  const STAR = { domains: [], prefixes: [], quarantineDomains: ['*'] }
  const at = (url: string) => egressDecision('WebFetch', { url }, STAR, QUARANTINE)

  it('lets the reader fetch a public host that is on no list', () => {
    for (const url of ['https://istyle.hu/mac-mini', 'https://sub.example.co.uk/a?b=c', 'http://notebook.hu/']) {
      expect(at(url).tier).toBe('quarantine')
    }
  })

  it('still refuses hosts that point back inside', () => {
    // The reader's caller is the main agent, and the main agent is what earlier
    // fetched content can steer -- so this half is not the operator's to waive.
    for (const url of [
      'http://169.254.169.254/latest/meta-data/',   // cloud metadata
      'http://192.168.1.50/',
      'http://10.0.0.1/', 'http://172.16.4.9/', 'http://100.64.0.1/',
      'http://box.local/', 'http://svc.internal/', 'http://a.lan/', 'http://x.home/',
      'http://127.0.0.1.nip.io/', 'http://192-168-1-50.sslip.io/',
      'http://[::1]:3420/',
    ]) {
      expect(at(url).blocked, url).toBe(true)
    }
  })

  // Stated as "the sentinel changes no inward verdict" rather than as a list of
  // blocked URLs, because the built-in prefix tier already allows this install's
  // OWN dashboard (http://localhost:<port>/) for every agent -- that predates the
  // sentinel and is deliberate. Asserting a flat "blocked" there would have
  // pinned the built-in's behaviour to this card by accident; asserting the
  // DIFFERENCE keeps the claim to what the sentinel is actually responsible for.
  it('grants nothing inward that was not already reachable without it', () => {
    for (const url of [
      'http://127.0.0.1:3420/api/messages', 'http://localhost:3420/',
      'http://169.254.169.254/latest/meta-data/', 'http://192.168.1.50/',
      'http://10.0.0.1/', 'http://box.local/', 'http://127.0.0.1.nip.io/',
      'http://[::1]:3420/',
    ]) {
      const withStar = egressDecision('WebFetch', { url }, STAR, QUARANTINE)
      const without = egressDecision('WebFetch', { url }, EMPTY, QUARANTINE)
      expect(withStar.blocked, url).toBe(without.blocked)
      expect(withStar.tier, url).toBe(without.tier)
    }
  })

  it('opens nothing for the main agent, which is the whole point of the tier', () => {
    for (const agent of ['', 'general-purpose', 'main']) {
      expect(egressDecision('WebFetch', { url: 'https://istyle.hu/' }, STAR, agent).blocked).toBe(true)
    }
  })

  it('is a literal sentinel, not a pattern: a stray star does not wildcard a host', () => {
    const odd = { domains: [], prefixes: [], quarantineDomains: ['*.example.com'] }
    expect(egressDecision('WebFetch', { url: 'https://a.example.com/' }, odd, QUARANTINE).blocked).toBe(true)
  })

  it('without the sentinel an unlisted public host is still blocked', () => {
    expect(egressDecision('WebFetch', { url: 'https://istyle.hu/' }, EMPTY, QUARANTINE).blocked).toBe(true)
  })
})

// isPublicFetchTarget here and isPublicFetchHost in src/web/agent-scaffold.ts are
// the same rule written twice: a hook runs standalone with no build step, so it
// cannot import the application copy. Duplicated security logic drifts, so this
// pins both to the same verdict on one corpus -- a change to either that the
// other does not follow fails here rather than in production.
describe('the hook guard and the render guard agree', () => {
  const CORPUS = [
    'istyle.hu', 'www.apple.com', 'sub.example.co.uk', 'a-b.example.com', 'xn--80ak6aa92e.com',
    'localhost', 'box', '127.0.0.1', '8.8.8.8', '0.0.0.0', '169.254.169.254', '192.168.1.50',
    '10.0.0.1', '172.16.4.9', '100.64.0.1', 'box.local', 'svc.internal', 'a.lan', 'x.home',
    'y.intranet', 'z.test', 'q.arpa', 'w.invalid', 'p.localdomain', 'k.svc', 'm.cluster',
    '127.0.0.1.nip.io', '192-168-1-50.sslip.io', '10-0-0-1.example.com',
    '*', '', ' ', '.leading.com', 'trailing.com.', '-dash.com', 'dash-.com',
    'has space.com', 'has/slash.com', 'has:port.com', 'com', 'hu', 'co.uk',
  ]

  it('returns the same verdict for every host in the corpus', () => {
    for (const host of CORPUS) {
      expect(isPublicFetchTarget(host), host).toBe(isPublicFetchHost(host))
    }
  })

  it('and the corpus actually exercises both answers', () => {
    const yes = CORPUS.filter((h) => isPublicFetchTarget(h))
    expect(yes.length).toBeGreaterThan(3)
    expect(yes.length).toBeLessThan(CORPUS.length - 3)
  })
})
