// MONITORGATE1030 (card 7f941346): every gate that judges a shell command must also fire on the
// Monitor tool, which runs its `command` in the same shell as Bash. Measured 2026-10-30 before the
// fix: a plain-http curl to a reserved .invalid host ran from Monitor while bash-egress-parser denied
// the same Bash call, because no PreToolUse matcher but the `*` fleet-freeze gate named Monitor.
//
// The matcher is a full-match regex against the tool name (see EMAIL_GATE_MATCHER), so this suite
// asks the question the CLI asks: for each registered PreToolUse group, does it fire on "Bash", and
// if so, does it fire on "Monitor" too? Three sources: the tracked project settings (main agent), the
// settings template (every agent), and a sub-agent's rendered settings with every opt-in gate on.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SHELL_TOOL_MATCHER,
  SELF_PACE_GATE_MATCHER,
  writeAgentSettingsFromProfile,
  agentSettingsPath,
  ensureGovernanceGateCommands,
} from '../web/agent-scaffold.js'
import { loadProfileTemplate, type ProfileTemplate } from '../web/profiles.js'
import { PROJECT_ROOT } from '../config.js'
import { AGENTS_BASE_DIR } from '../web/agent-config.js'

type Group = { matcher?: string; hooks?: Array<{ command?: string }> }
const fires = (matcher: string | undefined, tool: string): boolean =>
  matcher === undefined || matcher === '' || matcher === '*' || new RegExp(`^(?:${matcher})$`).test(tool)

// The groups that fire on Bash but not on Monitor, named by the scripts they run.
function blindToMonitor(groups: Group[]): string[] {
  return groups
    .filter((g) => fires(g.matcher, 'Bash') && !fires(g.matcher, 'Monitor'))
    .map((g) => `${g.matcher} :: ${(g.hooks ?? []).map((h) => (h.command ?? '').match(/[\w-]+\.(?:py|mjs|sh)/)?.[0]).join(',')}`)
}

const TEST_AGENT = 'monitor-matcher-probe'
const agentRoot = join(AGENTS_BASE_DIR, TEST_AGENT)
function cleanup(): void {
  if (!existsSync(agentRoot)) return
  if (existsSync(join(agentRoot, 'CLAUDE.md')) || existsSync(join(agentRoot, 'HANDOFF.md'))) {
    throw new Error(`refusing: ${agentRoot} looks like a live agent, not a test checkout`)
  }
  rmSync(agentRoot, { recursive: true, force: true })
}
beforeEach(cleanup)
afterEach(cleanup)

describe('MONITORGATE1030: shell-command gates fire on Monitor', () => {
  it('the shared matcher names both tools, and nothing else', () => {
    expect(fires(SHELL_TOOL_MATCHER, 'Bash')).toBe(true)
    expect(fires(SHELL_TOOL_MATCHER, 'Monitor')).toBe(true)
    for (const other of ['Read', 'Write', 'WebFetch', 'mcp__plugin_telegram_telegram__reply', 'BashOutput', 'MonitorX']) {
      expect({ other, fires: fires(SHELL_TOOL_MATCHER, other) }).toEqual({ other, fires: false })
    }
  })

  it('the tracked project settings: no PreToolUse group sees Bash and misses Monitor', () => {
    const s = JSON.parse(readFileSync(join(PROJECT_ROOT, '.claude', 'settings.json'), 'utf-8'))
    const pre = s.hooks.PreToolUse as Group[]
    expect(pre.filter((g) => fires(g.matcher, 'Bash') && g.matcher !== '*').length).toBeGreaterThan(0)
    expect(blindToMonitor(pre)).toEqual([])
  })

  it('the settings template: no PreToolUse group sees Bash and misses Monitor', () => {
    const s = JSON.parse(readFileSync(join(PROJECT_ROOT, 'templates', 'settings.json.template'), 'utf-8'))
    expect(blindToMonitor(s.hooks.PreToolUse as Group[])).toEqual([])
  })

  it('a rendered sub-agent with every opt-in gate on: no PreToolUse group sees Bash and misses Monitor', () => {
    const profile: ProfileTemplate = { ...loadProfileTemplate('default'), destructiveGate: true, credentialGate: true, secondReviewer: true }
    mkdirSync(join(agentRoot, '.claude'), { recursive: true })
    writeAgentSettingsFromProfile(TEST_AGENT, profile)
    const pre = JSON.parse(readFileSync(agentSettingsPath(TEST_AGENT), 'utf-8')).hooks.PreToolUse as Group[]
    const shellGates = pre.filter((g) => fires(g.matcher, 'Bash') && g.matcher !== '*')
    const scripts = shellGates.flatMap((g) => (g.hooks ?? []).map((h) => (h.command ?? '').match(/[\w-]+\.(?:py|mjs|sh)/)?.[0]))
    for (const gate of ['bash-egress-parser.mjs', 'child-claude-channel-guard.mjs', 'email-send-gate.mjs', 'self-pace-gate.mjs', 'destructive-gate.py', 'credential-gate.py', 'second-reviewer-gate.py']) {
      expect({ gate, wired: scripts.includes(gate) }).toEqual({ gate, wired: true })
    }
    expect(blindToMonitor(pre)).toEqual([])
  })

  it('migration: a self-pace entry still on the pre-Monitor matcher is rewritten in place', () => {
    const profile = loadProfileTemplate('default')
    mkdirSync(join(agentRoot, '.claude'), { recursive: true })
    writeAgentSettingsFromProfile(TEST_AGENT, profile)
    const path = agentSettingsPath(TEST_AGENT)
    const s = JSON.parse(readFileSync(path, 'utf-8'))
    const old = 'ScheduleWakeup|CronCreate|CronDelete|CronList|RemoteTrigger|Bash|Write|Edit|NotebookEdit'
    for (const g of s.hooks.PreToolUse as Group[]) {
      if (JSON.stringify(g).includes('self-pace-gate.mjs')) g.matcher = old
    }
    writeFileSync(path, JSON.stringify(s, null, 2))
    expect(ensureGovernanceGateCommands(TEST_AGENT, profile)).toBe(true)
    const after = (JSON.parse(readFileSync(path, 'utf-8')).hooks.PreToolUse as Group[])
      .filter((g) => JSON.stringify(g).includes('self-pace-gate.mjs'))
    expect(after.map((g) => g.matcher)).toEqual([SELF_PACE_GATE_MATCHER])
    // Idempotent: a second run has nothing to do.
    expect(ensureGovernanceGateCommands(TEST_AGENT, profile)).toBe(false)
  })
})
