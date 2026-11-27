import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// MAINUNAUTHALERT1125 (Péter 18308, Marveen 9121): the main session's dead login reaches the owner within minutes,
// at night too, reminds at most once an hour, and says "rendben" once when it is back. checkSession itself runs here;
// its collaborators are mocked: the pane, the pane detector, the transcript reader, notify (execFile), the logger.

const fixture = vi.hoisted(() => ({
  pane: 'pane' as string | null,
  paneReauth: { needsReauth: false } as { needsReauth: boolean; reason?: string },
  transcript: { needsReauth: false } as { needsReauth: boolean; reason?: string },
  execCalls: [] as unknown[][],
  restarts: 0,
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (...args: unknown[]) => {
      fixture.execCalls.push(args)
      const cb = args.find((a) => typeof a === 'function') as ((e: null) => void) | undefined
      cb?.(null)
    },
  }
})
vi.mock('../web/agent-process.js', () => ({
  withTmuxBatch: (fn: () => unknown) => fn(),
  isAgentRunning: () => true,
  capturePane: () => fixture.pane,
  startAgentProcess: async () => ({ ok: true }),
}))
vi.mock('../web/reauth-detect.js', () => ({ detectReauthNeeded: () => fixture.paneReauth }))
vi.mock('../web/reauth-transcript.js', () => ({ detectReauthFromTranscript: () => fixture.transcript }))
vi.mock('../web/claude-credentials-guard.js', () => ({ quarantineFleetTokenIfDead: async () => 'no-token' }))
vi.mock('../web/main-auth.js', () => ({ mainLaunchedOnKey: () => false }))
vi.mock('../web/channel-monitor.js', () => ({ hardRestartMarveenChannels: () => { fixture.restarts++; return { ok: true } }, lastMainRespawnAt: () => 0 }))
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

const MAIN = 'marveen'
const SESSION = 'marveen-channels'
const MIN = 60_000
// The 2026-11-24 night: 02:07 local, inside quiet hours (23:00-06:00).
const NIGHT = Date.parse('2026-11-24T01:07:27.000Z')
const DEAD = { needsReauth: true, reason: 'transcript: Login reached its time limit · Please ru' }

async function load() {
  vi.resetModules()
  return import('../web/reauth-healer.js')
}
const notes = () => fixture.execCalls.filter((c) => c[0] === '/bin/bash').map((c) => (c[1] as string[])[1]!)
/** One healer probe of the main session at `atMs`, quiet hours as the night has them. */
async function probe(h: Awaited<ReturnType<typeof load>>, atMs: number, quiet = true) {
  vi.setSystemTime(atMs)
  h.checkSession(MAIN, SESSION, true, quiet)
  await vi.advanceTimersByTimeAsync(10)
}

describe('main session: dead login alert (MAINUNAUTHALERT1125)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    fixture.execCalls.length = 0
    fixture.restarts = 0
    fixture.pane = 'pane'
    fixture.paneReauth = { needsReauth: false }
    fixture.transcript = { needsReauth: false }
  })
  afterEach(() => { vi.useRealTimers() })

  it('the 11-24 night: the first transcript-proven probe alerts at once, inside quiet hours, in Hungarian with one thing to do', async () => {
    const h = await load()
    fixture.transcript = DEAD
    await probe(h, NIGHT)
    expect(notes()).toHaveLength(1)
    expect(notes()[0]).toMatch(/A fő munkamenet \(marveen\) nincs bejelentkezve/)
    expect(notes()[0]).toMatch(/Teendő: .*"Channels restart"/)
  })

  it('no secret in the message: no token, no credential, no path, not even the reason Claude Code gave', async () => {
    const h = await load()
    fixture.transcript = DEAD
    await probe(h, NIGHT)
    for (let t = 1; t <= 70; t += 3) await probe(h, NIGHT + t * MIN)
    fixture.transcript = { needsReauth: false }
    await probe(h, NIGHT + 75 * MIN)
    expect(notes().length).toBeGreaterThanOrEqual(3)
    for (const n of notes()) {
      expect(n).not.toMatch(/sk-ant|oat0\d|Bearer|token=|\/Users\/|\.claude|\.credentials|oauth-token|Please run|time limit/i)
    }
  })

  it('it does not repeat every probe: one reminder after an hour, none in between', async () => {
    const h = await load()
    fixture.transcript = DEAD
    for (let t = 0; t < 60; t += 3) await probe(h, NIGHT + t * MIN)
    expect(notes()).toHaveLength(1)
    await probe(h, NIGHT + 60 * MIN)
    expect(notes()).toHaveLength(2)
    expect(notes()[1]).toMatch(/még mindig nincs bejelentkezve \(kb\. \d+ perce\)/)
    for (let t = 63; t < 120; t += 3) await probe(h, NIGHT + t * MIN)
    expect(notes()).toHaveLength(2)
  })

  it('when it is logged in again: one "rendben" line, and nothing after it', async () => {
    const h = await load()
    fixture.transcript = DEAD
    await probe(h, NIGHT)
    fixture.transcript = { needsReauth: false }
    await probe(h, NIGHT + 3 * MIN)
    await probe(h, NIGHT + 6 * MIN)
    await probe(h, NIGHT + 9 * MIN)
    expect(notes()).toHaveLength(2)
    expect(notes()[1]).toBe('✅ A fő munkamenet (marveen) újra be van jelentkezve, rendben.')
  })

  it('a session that is merely DOWN (restart) is not "back": the line waits for the session to come up logged in', async () => {
    const h = await load()
    fixture.transcript = DEAD
    await probe(h, NIGHT)
    fixture.pane = null
    await probe(h, NIGHT + 3 * MIN)
    expect(notes()).toHaveLength(1)
    fixture.pane = 'pane'
    fixture.transcript = { needsReauth: false }
    await probe(h, NIGHT + 6 * MIN)
    expect(notes()).toHaveLength(2)
    expect(notes()[1]).toMatch(/újra be van jelentkezve/)
  })

  it('down for a restart and back still dead: no early second alert (the spell and its hour are kept)', async () => {
    const h = await load()
    fixture.transcript = DEAD
    await probe(h, NIGHT)
    fixture.pane = null
    await probe(h, NIGHT + 3 * MIN)
    fixture.pane = 'pane'
    await probe(h, NIGHT + 6 * MIN)
    await probe(h, NIGHT + 9 * MIN)
    expect(notes()).toHaveLength(1)
  })

  it('the main messages carry none of the markers the detectors read, so an alert quoted back cannot re-trigger', async () => {
    const h = await load()
    const { TRANSCRIPT_REAUTH_MARKERS } = await vi.importActual<typeof import('../web/reauth-transcript.js')>('../web/reauth-transcript.js')
    const { detectReauthNeeded } = await vi.importActual<typeof import('../web/reauth-detect.js')>('../web/reauth-detect.js')
    for (const msg of [h.buildMainEscalationMessage(MAIN, 1, true), h.buildMainEscalationMessage(MAIN, 20, false), h.buildMainRecoveredMessage(MAIN)]) {
      expect(TRANSCRIPT_REAUTH_MARKERS.some((rx) => rx.test(msg))).toBe(false)
      expect(detectReauthNeeded(msg).needsReauth).toBe(false)
    }
  })

  it('a healthy session: no alert and no "rendben" line, at night or by day', async () => {
    const h = await load()
    for (let t = 0; t < 120; t += 3) await probe(h, NIGHT + t * MIN, t % 2 === 0)
    expect(notes()).toHaveLength(0)
  })

  it('only the pane shows it (a pane can flicker): no alert on one probe, the alert on the second', async () => {
    const h = await load()
    fixture.paneReauth = { needsReauth: true, reason: 'Not logged in' }
    await probe(h, NIGHT)
    expect(notes()).toHaveLength(0)
    await probe(h, NIGHT + 3 * MIN)
    expect(notes()).toHaveLength(1)
  })

  it('a pane that flickers dead once and is healthy again: no alert at all', async () => {
    const h = await load()
    fixture.paneReauth = { needsReauth: true, reason: 'Not logged in' }
    await probe(h, NIGHT)
    fixture.paneReauth = { needsReauth: false }
    await probe(h, NIGHT + 3 * MIN)
    await probe(h, NIGHT + 6 * MIN)
    expect(notes()).toHaveLength(0)
  })

  it('a transcript-proven dead login stays escalate-only: the main session is not restarted by the healer', async () => {
    const h = await load()
    fixture.transcript = DEAD
    await probe(h, NIGHT)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixture.restarts).toBe(0)
    // The other direction: a pane-proven dead login (two probes) does restart it, as before this change.
    fixture.transcript = { needsReauth: false }
    fixture.paneReauth = { needsReauth: true, reason: 'Not logged in' }
    const h2 = await load()
    await probe(h2, NIGHT + 10 * MIN)
    await probe(h2, NIGHT + 13 * MIN)
    await vi.advanceTimersByTimeAsync(1000)
    expect(fixture.restarts).toBe(1)
  })
})

describe('the pure rules behind it', () => {
  it('thresholds: one probe for the transcript, two for the pane, three for a sub-agent; reminders hourly for main', async () => {
    const h = await load()
    expect(h.healerThresholds(true, 'transcript: x')).toEqual({ threshold: 1, cooldownMs: 60 * MIN })
    expect(h.healerThresholds(true, 'Not logged in')).toEqual({ threshold: 2, cooldownMs: 60 * MIN })
    expect(h.healerThresholds(false, 'transcript: x')).toEqual({ threshold: 3, cooldownMs: 3 * 60 * MIN })
  })
  it('quiet hours hold back a sub-agent\'s alert, never the main session\'s', async () => {
    const h = await load()
    expect(h.escalationQuiet(true, true)).toBe(false)
    expect(h.escalationQuiet(false, true)).toBe(true)
    expect(h.escalationQuiet(false, false)).toBe(false)
  })
  it('a sub-agent inside quiet hours: still queued for the morning summary, not sent (unchanged)', async () => {
    const h = await load()
    const sent: string[] = []
    const queue = new Map()
    h.routeEscalation({ session: 'agent-x', label: 'x', reason: 'Not logged in', consecutiveDead: 3 }, h.escalationQuiet(false, true), (m) => sent.push(m), queue)
    expect(sent).toHaveLength(0)
    expect(queue.size).toBe(1)
  })
  it('the recovery rule: only after an alert, only with the session up and not dead', async () => {
    const h = await load()
    expect(h.mainRecoveryDue({ alertOpen: true, sessionAlive: true, needsReauth: false })).toBe(true)
    expect(h.mainRecoveryDue({ alertOpen: false, sessionAlive: true, needsReauth: false })).toBe(false)
    expect(h.mainRecoveryDue({ alertOpen: true, sessionAlive: false, needsReauth: false })).toBe(false)
    expect(h.mainRecoveryDue({ alertOpen: true, sessionAlive: true, needsReauth: true })).toBe(false)
  })
})
