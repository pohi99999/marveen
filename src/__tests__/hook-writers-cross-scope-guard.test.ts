import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import {
  agentSettingsPath,
  ensureAgentProvenanceHook,
  ensureAgentStalenessHook,
} from '../web/agent-scaffold.js'

// XSCOPE913. ensureAgentHooks has honoured the cross-scope guard since
// 2026-09-04, but the two dedicated UserPromptSubmit writers that the startup
// loop (web.ts) calls right after it did not: each only asked "is the script
// already in MY file?". For the main agent that file is the SHARED
// ~/.claude/settings.json, while the repo's project scope already runs the
// same script in its own spelling -- so every dashboard start re-added the
// wrapper the operator had just removed (measured 2026-09-13 23:18:20, one
// second after a restart; doctor.sh red again: "KETSZER FUT ... provenance-gate.py").
//
// The writers derive their target from agentSettingsPath(name); the `scopes`
// seam makes that target play the user scope, exactly as the ensureAgentHooks
// test does, so nothing here touches the real home directory.

const NAME = 'xscope913-writer-probe'
const PROJECT_SPELLING = (script: string) => `python3 "$CLAUDE_PROJECT_DIR/scripts/hooks/${script}"`

let root: string
let projectScope: string
const target = () => agentSettingsPath(NAME)
const scopes = () => ({ user: target(), project: projectScope })

function writeProjectScope(scripts: string[]): void {
  mkdirSync(join(projectScope, '..'), { recursive: true })
  const entries = scripts.map((s) => ({ hooks: [{ type: 'command', command: PROJECT_SPELLING(s) }] }))
  writeFileSync(projectScope, JSON.stringify({ hooks: { UserPromptSubmit: entries } }, null, 2))
}

function scriptsIn(path: string): string[] {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { hooks?: { UserPromptSubmit?: Array<{ hooks?: Array<{ command?: string }> }> } }
  return (parsed.hooks?.UserPromptSubmit ?? []).flatMap((e) => (e.hooks ?? []).map((h) => h.command ?? ''))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'xscope913-'))
  projectScope = join(root, 'repo', '.claude', 'settings.json')
  rmSync(join(PROJECT_ROOT, 'agents', NAME), { recursive: true, force: true })
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(join(PROJECT_ROOT, 'agents', NAME), { recursive: true, force: true })
})

describe('ensureAgentProvenanceHook respects the cross-scope guard', () => {
  it('does NOT write the user scope when the project scope already runs provenance-gate.py', () => {
    writeProjectScope(['provenance-gate.py'])
    expect(ensureAgentProvenanceHook(NAME, scopes())).toBe(false)
    expect(existsSync(target())).toBe(false)
  })

  it('still wires the hook when the project scope does not run it (the allowed direction)', () => {
    writeProjectScope(['staleness-guard.py'])
    expect(ensureAgentProvenanceHook(NAME, scopes())).toBe(true)
    expect(scriptsIn(target()).some((c) => c.includes('provenance-gate.py'))).toBe(true)
    // Idempotent on the second pass.
    expect(ensureAgentProvenanceHook(NAME, scopes())).toBe(false)
  })
})

describe('ensureAgentStalenessHook respects the cross-scope guard', () => {
  it('does NOT write the user scope when the project scope already runs staleness-guard.py', () => {
    writeProjectScope(['staleness-guard.py'])
    expect(ensureAgentStalenessHook(NAME, scopes())).toBe(false)
    expect(existsSync(target())).toBe(false)
  })

  it('still wires the hook when the project scope does not run it', () => {
    writeProjectScope(['provenance-gate.py'])
    expect(ensureAgentStalenessHook(NAME, scopes())).toBe(true)
    expect(scriptsIn(target()).some((c) => c.includes('staleness-guard.py'))).toBe(true)
  })
})

describe('the incident replay: a restart must not undo the operator removal', () => {
  it('user scope emptied by hand, project scope carries the script: two startups add nothing', () => {
    writeProjectScope(['provenance-gate.py', 'staleness-guard.py'])
    mkdirSync(join(target(), '..'), { recursive: true })
    writeFileSync(target(), JSON.stringify({ hooks: { UserPromptSubmit: [] } }, null, 2))
    for (let startup = 0; startup < 2; startup++) {
      expect(ensureAgentProvenanceHook(NAME, scopes())).toBe(false)
      expect(ensureAgentStalenessHook(NAME, scopes())).toBe(false)
    }
    expect(scriptsIn(target())).toEqual([])
  })
})
