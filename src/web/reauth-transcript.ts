// Second, pane-independent dead-token signal for the MAIN session: its own
// transcript. When the OAuth refresh fails, Claude Code answers every prompt with
// the assistant line "Login expired · Please run /login" (2026-09-22 03:00-08:24:
// 30 such turns, one per injected scheduled task). The pane-based detector saw
// "Not logged in" once at 03:08 and then nothing -- the live status region is
// redrawn by the injected prompts, consecutiveDead fell back to 0, the quiet-hours
// entry was dropped as "healed", and neither the 06:00 summary nor restartMain
// fired: 5h24m of silent outage. The transcript cannot be masked by redraws.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { projectsDirFor } from './active-model.js'

/** Assistant texts Claude Code emits instead of a reply while the login is dead. */
export const TRANSCRIPT_REAUTH_MARKERS: RegExp[] = [
  /Login expired\s*[·\-–]\s*Please run\s+\/login/i,
  /^Not logged in\b.*\/login/i,
]

/** Only a RECENT dead-login turn counts: an old one from a since-healed session
 *  (the healed session keeps writing normal turns after it) must not re-badge. */
export const TRANSCRIPT_WINDOW_MS = 20 * 60 * 1000

export type TranscriptReauth = { needsReauth: boolean; reason?: string; atMs?: number }

function assistantText(entry: unknown): string | null {
  const e = entry as { type?: string; message?: { role?: string; content?: unknown } }
  if (e?.type !== 'assistant') return null
  const c = e.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.map((p) => (p && typeof p === 'object' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join(' ')
  return null
}

/**
 * Pure: scan transcript lines (newest last). The LAST assistant turn decides:
 * a dead-login marker there, inside the window, means the session is dead now;
 * a normal reply after a dead one means it healed (or a fresh login landed).
 */
export function detectReauthFromTranscriptLines(lines: string[], nowMs: number, windowMs = TRANSCRIPT_WINDOW_MS): TranscriptReauth {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let entry: unknown
    try { entry = JSON.parse(line) } catch { continue }
    const text = assistantText(entry)
    if (text === null) continue
    const ts = Date.parse((entry as { timestamp?: string }).timestamp ?? '')
    const atMs = Number.isFinite(ts) ? ts : nowMs
    const marker = TRANSCRIPT_REAUTH_MARKERS.find((rx) => rx.test(text.trim()))
    if (!marker) return { needsReauth: false }
    if (nowMs - atMs > windowMs) return { needsReauth: false }
    return { needsReauth: true, reason: 'transcript: ' + text.trim().slice(0, 40), atMs }
  }
  return { needsReauth: false }
}

/** Tail of the newest transcript in the project dir (the live session), bounded. */
export function readNewestTranscriptTail(workingDir: string, maxBytes = 256 * 1024, configDir?: string): string[] {
  const dir = projectsDirFor(workingDir, configDir)
  if (!existsSync(dir)) return []
  const newest = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]
  if (!newest) return []
  const path = join(dir, newest.f)
  const size = statSync(path).size
  const buf = readFileSync(path)
  const slice = size > maxBytes ? buf.subarray(size - maxBytes) : buf
  const lines = slice.toString('utf-8').split('\n')
  if (size > maxBytes) lines.shift() // drop the partial first line
  return lines
}

export function detectReauthFromTranscript(workingDir: string, nowMs = Date.now(), configDir?: string): TranscriptReauth {
  try {
    return detectReauthFromTranscriptLines(readNewestTranscriptTail(workingDir, undefined, configDir), nowMs)
  } catch {
    return { needsReauth: false }
  }
}
