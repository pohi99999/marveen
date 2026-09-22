import { describe, it, expect } from 'vitest'
import { detectReauthFromTranscriptLines, TRANSCRIPT_WINDOW_MS } from '../web/reauth-transcript.js'
import { detectReauthNeeded } from '../web/reauth-detect.js'
import { combineMainReauthSignals, shouldSkipMainRestartForFileDeadLogin } from '../web/reauth-healer.js'

// Shapes copied from the real main-session transcript of 2026-09-22 (6b5a8cd0):
// every injected scheduled task got the same assistant answer for 5h24m.
const T0 = Date.parse('2026-09-22T01:13:12.000Z') // 03:13:12 CEST
const line = (type: string, text: string, atMs: number, role = type) =>
  JSON.stringify({ type, timestamp: new Date(atMs).toISOString(), message: { role, content: [{ type: 'text', text }] } })
const deadTurn = (atMs: number) => [
  line('user', 'SCHEDULED TASK NOTICE -- the next <scheduled-task source="..."> ... </scheduled-task> block', atMs - 1000),
  line('assistant', 'Login expired · Please run /login', atMs),
]

// A pane whose live status region looks HEALTHY (box + context readout) -- what
// the healer saw after the injected prompts redrew the status line.
const healthyPane = [
  '● Heartbeat: nincs csatorna-üzenet.',
  '',
  '────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · 42% context',
].join('\n')

describe('reauth transcript signal (3fda6b5e)', () => {
  it('the last assistant turn "Login expired · Please run /login" inside the window is a dead login', () => {
    const r = detectReauthFromTranscriptLines(deadTurn(T0), T0 + 60_000)
    expect(r.needsReauth).toBe(true)
    expect(r.reason).toMatch(/Login expired/)
  })
  it('a normal reply AFTER a dead turn means healed (nothing to escalate)', () => {
    const lines = [...deadTurn(T0), line('user', 'ok', T0 + 5000), line('assistant', 'Heartbeat: nincs csatorna-üzenet.', T0 + 6000)]
    expect(detectReauthFromTranscriptLines(lines, T0 + 60_000).needsReauth).toBe(false)
  })
  it('a dead turn older than the window does not re-badge a quiet session', () => {
    expect(detectReauthFromTranscriptLines(deadTurn(T0), T0 + TRANSCRIPT_WINDOW_MS + 1000).needsReauth).toBe(false)
  })
  it('malformed lines and non-assistant entries are skipped, not fatal', () => {
    const lines = ['{not json', line('system', '', T0 + 100, 'system'), ...deadTurn(T0), '']
    expect(detectReauthFromTranscriptLines(lines, T0 + 60_000).needsReauth).toBe(true)
  })
  // THE 2026-09-22 CASE: pane says healthy, transcript says dead -> dead. On the
  // old code only the pane was consulted (false), so this is the test that fails
  // there.
  it('main session: a healthy-looking pane cannot mask a dead transcript', () => {
    expect(detectReauthNeeded(healthyPane).needsReauth).toBe(false)
    const combined = combineMainReauthSignals(detectReauthNeeded(healthyPane), () => detectReauthFromTranscriptLines(deadTurn(T0), T0 + 60_000))
    expect(combined.needsReauth).toBe(true)
    expect(combined.reason).toMatch(/transcript/)
  })
  it('main session: a dead pane wins without reading the transcript', () => {
    let read = 0
    const r = combineMainReauthSignals({ needsReauth: true, reason: 'Not logged in' }, () => { read++; return { needsReauth: false } })
    expect(r.reason).toBe('Not logged in'); expect(read).toBe(0)
  })
  it('a transcript-proven dead login is escalate-only (a fresh respawn reads the same dead file); a pane-proven one may restart', () => {
    expect(shouldSkipMainRestartForFileDeadLogin('transcript: Login expired · Please run /login')).toBe(true)
    expect(shouldSkipMainRestartForFileDeadLogin('Not logged in')).toBe(false)
    expect(shouldSkipMainRestartForFileDeadLogin(undefined)).toBe(false)
  })
})
