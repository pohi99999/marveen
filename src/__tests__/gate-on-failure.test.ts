/**
 * Card a62a27ce (owner GO 2026-10-17): `onFailure: "block"` (Claude Code 2.1.295) on the SECURITY gates only.
 * The fail-closed wrapper already turns every failure it can see into exit 2; onFailure covers the two it
 * cannot: the shell not starting, and Claude Code's own hook timeout firing first (measured: a hung gate
 * under `timeout -k 1 8` ended at 11.6 s in one run of three). The hygiene gates, the image resizer and the
 * UserPromptSubmit / Stop / PostToolUse hooks stay without it, because one broken hook there would stop
 * every Bash call or deafen the channel.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  GATE_ON_FAILURE,
  gateDeadlineSec,
  gateEntriesBlockOnFailure,
  injectEmailSendGate,
  injectSelfPaceGate,
  injectEgressGate,
  injectBashEgressParser,
  injectTelegramCopyGate,
  injectMarveenApiCopyGate,
  injectDestructiveGate,
  injectKanbanWriteGate,
  injectDigestProvenanceGate,
  ensureEgressGate,
  ensureBashEgressParser,
  ensureTelegramCopyGate,
  agentSettingsPath,
} from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

type Hook = { type: string; command: string; timeout: number; onFailure?: string }
type Entry = { matcher: string; hooks: Hook[] }
const entries = (s: Record<string, unknown>): Entry[] => ((s.hooks as Record<string, unknown>).PreToolUse as Entry[])

describe('which injectors set onFailure: block', () => {
  it('the six security gates carry it, on every hook of their entry', () => {
    const s: Record<string, unknown> = {}
    injectEmailSendGate(s); injectSelfPaceGate(s); injectEgressGate(s); injectBashEgressParser(s)
    injectTelegramCopyGate(s); injectMarveenApiCopyGate(s)
    const e = entries(s)
    expect(e.length).toBe(6)
    for (const x of e) for (const h of x.hooks) expect(h.onFailure, x.matcher).toBe(GATE_ON_FAILURE)
  })

  it('the gates the owner did not name stay as they were (no onFailure)', () => {
    const s: Record<string, unknown> = {}
    injectDestructiveGate(s); injectKanbanWriteGate(s); injectDigestProvenanceGate(s)
    for (const x of entries(s)) for (const h of x.hooks) expect(h.onFailure, x.matcher).toBeUndefined()
  })
})

describe('gateEntriesBlockOnFailure (the migration staleness test)', () => {
  const hook = (onFailure?: string) => ({ type: 'command', command: 'x "/d/egress-gate.mjs"', timeout: 10, ...(onFailure ? { onFailure } : {}) })
  it('true only when every matching entry blocks, false when one does not or none is there', () => {
    expect(gateEntriesBlockOnFailure([{ matcher: 'WebFetch', hooks: [hook('block')] }], 'egress-gate.mjs', 'WebFetch')).toBe(true)
    expect(gateEntriesBlockOnFailure([{ matcher: 'WebFetch', hooks: [hook()] }], 'egress-gate.mjs', 'WebFetch')).toBe(false)
    expect(gateEntriesBlockOnFailure([{ matcher: 'WebFetch', hooks: [hook('block')] }, { matcher: 'WebFetch', hooks: [hook()] }], 'egress-gate.mjs')).toBe(false)
    expect(gateEntriesBlockOnFailure([], 'egress-gate.mjs')).toBe(false)
    expect(gateEntriesBlockOnFailure([{ matcher: 'Bash', hooks: [hook('block')] }], 'egress-gate.mjs', 'WebFetch')).toBe(false)
  })
})

// The migrations, on a throwaway agent dir (same discipline as destructive-gate-wiring.test.ts).
const TEST_AGENT = 'onfailure-gate-probe'
const root = join(AGENTS_BASE_DIR, TEST_AGENT)
function cleanup(): void {
  if (!existsSync(root)) return
  if (!root.startsWith(join(AGENTS_BASE_DIR, TEST_AGENT))) throw new Error(`refusing: ${root}`)
  if (existsSync(join(root, 'CLAUDE.md')) || existsSync(join(root, 'HANDOFF.md'))) throw new Error(`refusing: ${root} looks live`)
  rmSync(root, { recursive: true, force: true })
}
beforeEach(cleanup)
afterEach(cleanup)

describe('the migrations restore onFailure on an agent written before this change', () => {
  it('egress, bash-egress and the two copy gates: stripped entries are rewritten, a second pass is a no-op', () => {
    const s: Record<string, unknown> = {}
    injectEgressGate(s); injectBashEgressParser(s); injectTelegramCopyGate(s); injectMarveenApiCopyGate(s)
    for (const x of entries(s)) for (const h of x.hooks) delete h.onFailure   // the pre-card shape
    const path = agentSettingsPath(TEST_AGENT)
    mkdirSync(join(root, '.claude'), { recursive: true })
    writeFileSync(path, JSON.stringify(s, null, 2))
    expect(ensureEgressGate(TEST_AGENT)).toBe(true)
    expect(ensureBashEgressParser(TEST_AGENT)).toBe(true)
    expect(ensureTelegramCopyGate(TEST_AGENT)).toBe(true)
    const after = entries(JSON.parse(readFileSync(path, 'utf-8')))
    expect(after.length).toBe(4)   // replaced in place, not appended
    for (const x of after) for (const h of x.hooks) expect(h.onFailure, x.matcher).toBe(GATE_ON_FAILURE)
    expect(ensureEgressGate(TEST_AGENT)).toBe(false)
    expect(ensureBashEgressParser(TEST_AGENT)).toBe(false)
    expect(ensureTelegramCopyGate(TEST_AGENT)).toBe(false)
  })
})

describe('the main agent settings (the committed .claude/settings.json)', () => {
  const settings = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8'))
  const all: { ev: string; matcher?: string; h: Hook }[] = []
  for (const [ev, arr] of Object.entries(settings.hooks as Record<string, Entry[]>)) for (const e of arr) for (const h of e.hooks) all.push({ ev, matcher: e.matcher, h })

  it('every security gate entry blocks on failure, with the deadline four seconds inside its timeout', () => {
    const sec = all.filter((x) => x.ev === 'PreToolUse' && x.h.command.includes('governance-kapu (fail-closed)'))
    expect(sec.length).toBe(14)
    for (const x of sec) {
      expect(x.h.onFailure, x.matcher).toBe(GATE_ON_FAILURE)
      expect(x.h.command, x.matcher).toContain(`timeout -k 1 ${gateDeadlineSec(x.h.timeout)} `)
    }
  })

  it('nothing else carries onFailure (hygiene gates, resizer, UserPromptSubmit, Stop, PostToolUse, SessionStart)', () => {
    for (const x of all.filter((y) => !y.h.command.includes('governance-kapu (fail-closed)'))) expect(x.h.onFailure, `${x.ev} ${x.h.command.slice(0, 60)}`).toBeUndefined()
  })

  it('the memory-frontmatter Bash gate passes when its file is missing, and runs the gate when it is there', () => {
    const fm = all.filter((x) => x.h.command.includes('memory-frontmatter-bash-gate.py'))
    expect(fm.length).toBe(3)
    const dir = mkdtempSync(join(tmpdir(), 'fm-fallback-'))
    try {
      for (const x of fm) {
        const run = () => spawnSync('/bin/sh', ['-c', x.h.command], { input: '{}', env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: 'utf-8' }).status
        expect(run(), `${x.ev} missing file`).toBe(0)   // before: python3 on a missing file = exit 2 = every Bash blocked
        mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true })
        writeFileSync(join(dir, 'scripts', 'hooks', 'memory-frontmatter-bash-gate.py'), 'import sys\nsys.exit(2)\n')
        expect(run(), `${x.ev} present gate decides`).toBe(2)
        rmSync(join(dir, 'scripts'), { recursive: true, force: true })
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
