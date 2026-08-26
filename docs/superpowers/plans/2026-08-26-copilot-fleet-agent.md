# Copilot CLI Fleet Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Marveen fleet agent run the GitHub Copilot CLI (`copilot`) instead of Claude Code, so tasks can be delegated to it from the dashboard/kanban/inter-agent messaging when Claude capacity is tight.

**Architecture:** Add an `engine` field (`"claude"` default | `"copilot"`) to `agent-config.json`. Branch at the very top of `startAgentProcess` to a new, self-contained module (`src/web/copilot-agent-process.ts`) that owns Copilot's launch command, tmux session, and message delivery — the existing Claude-specific code in `agent-process.ts` (CC-version workarounds, isolated `CLAUDE_CONFIG_DIR`, fleet OAuth token, pane-idle heuristics tuned to Claude's TUI) is not touched or reused for the new path.

**Tech Stack:** TypeScript, Node.js, tmux (session management), `copilot` CLI (GitHub Copilot CLI, already installed and logged in on the target WSL host), Vitest.

**Spec:** `docs/superpowers/specs/2026-08-26-copilot-fleet-agent-design.md`

## Global Constraints

- Scope is Copilot only — no Antigravity work in this plan (separate future plan).
- No MCP wiring, no Telegram/Slack channel bridging for Copilot agents (explicit spec exclusion).
- Do not modify the Claude-specific launch/pane-idle logic in `agent-process.ts` — add a parallel path instead.
- `engine` is the field name, not `provider` (that name is taken by the channel-provider concept in this codebase).
- Every shell value interpolated into a tmux command string must go through `shSingleQuote()` (existing helper, `src/web/agent-process.ts`) — this codebase has a documented command-injection incident (card b7fa5281) from skipping this.
- Session naming must reuse the existing `agentSessionName(name)` helper (`agent-${name}`) so dashboard start/stop/status keep working unmodified.

---

## Task 1: `engine` field on agent-config

**Files:**
- Modify: `src/web/agent-config.ts`
- Test: `src/__tests__/agent-config-engine.test.ts` (new)

**Interfaces:**
- Produces: `readAgentEngine(name: string): 'claude' | 'copilot'` — reads `agent-config.json`'s `engine` field, defaults to `'claude'` for missing/invalid values (so every pre-existing agent, which has no `engine` key, keeps behaving exactly as before).

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/agent-config-engine.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let SANDBOX = ''

vi.mock('../agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return actual
})

// AGENTS_BASE_DIR is derived from PROJECT_ROOT at import time in the real
// module; agent-config.ts's own tests use a temp dir + direct file writes
// against agentDir(name), so mirror that pattern here.
const { AGENTS_BASE_DIR, readAgentEngine } = await import('../web/agent-config.js')

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'engine-'))
})
afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

function writeAgentConfig(name: string, config: object) {
  const dir = join(AGENTS_BASE_DIR, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(config))
}

describe('readAgentEngine', () => {
  it('defaults to claude when agent-config.json has no engine field', () => {
    writeAgentConfig('engine-test-a', { model: 'claude-sonnet-5' })
    expect(readAgentEngine('engine-test-a')).toBe('claude')
  })

  it('defaults to claude when agent-config.json is missing entirely', () => {
    expect(readAgentEngine('engine-test-nonexistent')).toBe('claude')
  })

  it('returns copilot when explicitly set', () => {
    writeAgentConfig('engine-test-b', { engine: 'copilot' })
    expect(readAgentEngine('engine-test-b')).toBe('copilot')
  })

  it('falls back to claude for an unrecognized value (typo-safety)', () => {
    writeAgentConfig('engine-test-c', { engine: 'gpt-whatever' })
    expect(readAgentEngine('engine-test-c')).toBe('claude')
  })
})
```

Note: check `src/__tests__/agent-worker.test.ts` or `src/web/agent-config.ts`'s own test file (if one exists alongside it) first — copy whatever sandbox/mocking pattern that file already uses for `AGENTS_BASE_DIR`/`agentDir()` instead of the sketch above if it differs, so this test matches the codebase's actual convention.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/agent-config-engine.test.ts`
Expected: FAIL — `readAgentEngine` is not exported yet.

- [ ] **Step 3: Implement `readAgentEngine`**

In `src/web/agent-config.ts`, add (near the other `readAgentX` readers, e.g. next to whatever reads `securityProfile`):

```typescript
export function readAgentEngine(name: string): 'claude' | 'copilot' {
  try {
    const config = JSON.parse(readFileOr(join(agentDir(name), 'agent-config.json'), '{}'))
    return config.engine === 'copilot' ? 'copilot' : 'claude'
  } catch {
    return 'claude'
  }
}
```

Match the exact `readFileOr`/`agentDir` imports already used by neighboring functions in this file — don't add a second way to read the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/agent-config-engine.test.ts`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add src/web/agent-config.ts src/__tests__/agent-config-engine.test.ts
git commit -m "feat(agents): add engine field (claude|copilot) to agent-config"
```

---

## Task 2: Copilot launch-command builder (pure, unit-tested)

**Files:**
- Create: `src/web/copilot-agent-process.ts`
- Test: `src/__tests__/copilot-agent-process.test.ts`

**Interfaces:**
- Consumes: `agentSessionName(name)`, `shSingleQuote(value)` from `src/web/agent-process.ts` (both already exported).
- Produces:
  - `buildCopilotLaunchCommand(opts: { configDir: string; resume: boolean; model?: string }): string` — the shell command string to hand to `tmux new-session`.
  - `copilotConfigDir(name: string): string` — where the isolated Copilot config lives for this agent: `join(agentDir(name), '.copilot-config')`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/copilot-agent-process.test.ts
import { describe, it, expect } from 'vitest'
import { buildCopilotLaunchCommand, copilotConfigDir } from '../web/copilot-agent-process.js'

describe('buildCopilotLaunchCommand', () => {
  it('builds a fresh-session command with --allow-all-tools and a quoted config-dir', () => {
    const cmd = buildCopilotLaunchCommand({ configDir: '/home/pohi/marveen/agents/coder/.copilot-config', resume: false })
    expect(cmd).toBe(
      "copilot --allow-all-tools --config-dir '/home/pohi/marveen/agents/coder/.copilot-config'",
    )
  })

  it('adds --continue when resume is true', () => {
    const cmd = buildCopilotLaunchCommand({ configDir: '/tmp/cfg', resume: true })
    expect(cmd).toBe("copilot --allow-all-tools --continue --config-dir '/tmp/cfg'")
  })

  it('adds --model when a model is given', () => {
    const cmd = buildCopilotLaunchCommand({ configDir: '/tmp/cfg', resume: false, model: 'gpt-5.2' })
    expect(cmd).toBe("copilot --allow-all-tools --config-dir '/tmp/cfg' --model 'gpt-5.2'")
  })

  it('single-quotes a config-dir path containing a single quote (defence #2, mirrors shSingleQuote use elsewhere)', () => {
    const cmd = buildCopilotLaunchCommand({ configDir: "/tmp/weird'dir", resume: false })
    expect(cmd).toContain(`'/tmp/weird'\\''dir'`)
  })
})

describe('copilotConfigDir', () => {
  it('is a dotdir inside the agent directory, not the shared ~/.copilot', () => {
    expect(copilotConfigDir('coder')).toMatch(/agents[/\\]coder[/\\]\.copilot-config$/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/copilot-agent-process.test.ts`
Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Implement the module**

```typescript
// src/web/copilot-agent-process.ts
//
// Launch path for fleet agents whose engine is "copilot" (GitHub Copilot
// CLI) instead of Claude Code. Deliberately kept separate from
// agent-process.ts: that file's Claude-specific workarounds (CC-version
// regressions, isolated CLAUDE_CONFIG_DIR, fleet OAuth token, pane-idle
// detection tuned to Claude's TUI) do not apply here and must not be
// entangled with this path. See docs/superpowers/specs/
// 2026-08-26-copilot-fleet-agent-design.md for the full design.
import { join } from 'node:path'
import { agentDir } from './agent-config.js'
import { agentSessionName, shSingleQuote } from './agent-process.js'

export function copilotConfigDir(name: string): string {
  return join(agentDir(name), '.copilot-config')
}

export function buildCopilotLaunchCommand(opts: {
  configDir: string
  resume: boolean
  model?: string
}): string {
  const parts = ['copilot', '--allow-all-tools']
  if (opts.resume) parts.push('--continue')
  parts.push('--config-dir', shSingleQuote(opts.configDir))
  if (opts.model) parts.push('--model', shSingleQuote(opts.model))
  return parts.join(' ')
}

export { agentSessionName }
```

Adjust the import path for `agentDir` if Task 1 revealed it lives somewhere other than `agent-config.ts` — use whatever the codebase actually exports.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/copilot-agent-process.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add src/web/copilot-agent-process.ts src/__tests__/copilot-agent-process.test.ts
git commit -m "feat(agents): pure command builder for Copilot CLI fleet agents"
```

---

## Task 3: Wire start/stop into the agent lifecycle

**Files:**
- Modify: `src/web/agent-process.ts` (`startAgentProcess`, top of function, right after the `if (isAgentRunning(name)) return ...` guard around line 958 — insert the branch BEFORE the existing `agentProvider = resolveAgentProvider(name)` line so the Claude-only channel-provider logic never runs for a Copilot agent)
- Modify: `src/web/copilot-agent-process.ts` (add `startCopilotAgentProcess`)

**Interfaces:**
- Consumes: `readAgentEngine` (Task 1), `buildCopilotLaunchCommand`/`copilotConfigDir` (Task 2), `runTmux` (need to check whether `agent-process.ts` exports it — if not, export it there; it is currently a module-local `function runTmux(...)` per the earlier read of the file).
- Produces: `startCopilotAgentProcess(name: string, opts: { fresh?: boolean }): { ok: boolean; pid?: number; error?: string }` — same return shape as `startAgentProcess`, so the route handler doesn't need to know which engine ran.

- [ ] **Step 1: Export `runTmux` from agent-process.ts**

`runTmux` is currently module-private in `src/web/agent-process.ts`. Add `export` to its declaration (find `function runTmux(host: string | null, tmuxArgs: string[], ...)`) so `copilot-agent-process.ts` can use the same tmux invocation path (this keeps ssh/local handling and quoting in one place, per the existing comment above that function).

- [ ] **Step 2: Implement `startCopilotAgentProcess`**

Add to `src/web/copilot-agent-process.ts`:

```typescript
import { existsSync, mkdirSync } from 'node:fs'
import { isAgentRunning, runTmux } from './agent-process.js' // add `export` to isAgentRunning too if it isn't already

export function startCopilotAgentProcess(
  name: string,
  opts: { fresh?: boolean } = {},
): { ok: boolean; pid?: number; error?: string } {
  const dir = agentDir(name)
  if (!existsSync(dir)) return { ok: false, error: 'Agent not found' }
  if (isAgentRunning(name)) return { ok: false, error: 'Agent is already running' }

  const configDir = copilotConfigDir(name)
  mkdirSync(configDir, { recursive: true })

  const session = agentSessionName(name)
  const resume = existsSync(join(configDir, 'session-state')) && !opts.fresh
  const cmd = buildCopilotLaunchCommand({ configDir, resume })

  try {
    runTmux(null, ['new-session', '-d', '-s', session, '-c', dir, cmd])
  } catch (err: any) {
    return { ok: false, error: `tmux launch failed: ${err.message}` }
  }
  return { ok: true }
}
```

Check `isAgentRunning`'s actual signature/export status while implementing — if it inspects Claude-specific pane content (rather than just tmux session existence) it is NOT safe to reuse as-is; in that case write a minimal `isSessionAlive(session)` here instead that just checks `tmux has-session`.

- [ ] **Step 3: Branch in `startAgentProcess`**

In `src/web/agent-process.ts`, immediately after:
```typescript
  if (isAgentRunning(name)) return { ok: false, error: 'Agent is already running' }
```
add:
```typescript
  if (readAgentEngine(name) === 'copilot') {
    return startCopilotAgentProcess(name, opts)
  }
```
(import `readAgentEngine` from `./agent-config.js` and `startCopilotAgentProcess` from `./copilot-agent-process.js` at the top of the file). Everything below this point in `startAgentProcess` is unreached for Copilot agents and stays exactly as-is.

- [ ] **Step 4: Confirm stop/status need no changes**

Read `stopAgentProcess` (around line 1423) and whatever function backs `GET /api/agents/<name>/status`. If both operate purely on `agentSessionName(name)` / tmux session existence (no Claude-specific pane inspection), no change is needed — note this in the commit message. If either DOES inspect pane content in a Claude-specific way (e.g. checking for a Claude TUI string to decide "running"), add a matching `engine === 'copilot'` branch there too, following the same pattern as Step 3.

- [ ] **Step 5: Manual verification (not unit-testable — real tmux + real CLI)**

With the user present:
1. Create a throwaway test agent directory under `agents/` with a minimal `agent-config.json` containing `"engine": "copilot"`.
2. `POST /api/agents/<test-name>/start`, confirm `{"ok":true}`.
3. `tmux attach -t agent-<test-name>` and visually confirm the Copilot CLI TUI came up logged in (not a login prompt).
4. `POST /api/agents/<test-name>/stop`, confirm the tmux session is gone (`tmux ls`).
5. Restart it once more with `opts.fresh` unset to confirm the `--continue` resume path doesn't error.

- [ ] **Step 6: Commit**

```bash
git add src/web/agent-process.ts src/web/copilot-agent-process.ts
git commit -m "feat(agents): start copilot-engine agents via a dedicated launch path"
```

---

## Task 4: Inter-agent message delivery for Copilot agents

**Files:**
- Modify: `src/web/copilot-agent-process.ts` (add `sendPromptToCopilotSession`)
- Modify: wherever `POST /api/messages` currently calls `sendPromptToSession` for the destination agent (grep `sendPromptToSession(` across `src/web/routes/` to find the exact call site — likely a messages/inter-agent route file not yet opened in this plan's research)

**Interfaces:**
- Consumes: `agentSessionName`, `runTmux` from `agent-process.ts`; `readAgentEngine` from `agent-config.ts`.
- Produces: `sendPromptToCopilotSession(session: string, text: string): Promise<'sent'>`.

- [ ] **Step 1: Write the failing test (text-framing only — the actual tmux send is not unit-tested, matching how the rest of this codebase tests agent-process.ts)**

```typescript
// add to src/__tests__/copilot-agent-process.test.ts
import { formatCopilotInboundMessage } from '../web/copilot-agent-process.js'

describe('formatCopilotInboundMessage', () => {
  it('frames an inter-agent message the same way the Claude path does', () => {
    expect(formatCopilotInboundMessage('marveen', 'Fix the login bug')).toBe(
      '[Uzenet @marveen-tol]: Fix the login bug',
    )
  })
})
```

Before writing this, grep `agent-process.ts` for the literal `[Uzenet @` framing string used on the Claude path (it appears in the doc comment already read: `"[Uzenet @<felado>-tol]: ..."`) and match its exact format/casing so a receiving agent — Claude or Copilot — sees an identical envelope.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/copilot-agent-process.test.ts`
Expected: FAIL — `formatCopilotInboundMessage` not exported.

- [ ] **Step 3: Implement**

```typescript
// add to src/web/copilot-agent-process.ts
export function formatCopilotInboundMessage(from: string, content: string): string {
  return `[Uzenet @${from}-tol]: ${content}`
}

export async function sendPromptToCopilotSession(session: string, text: string): Promise<'sent'> {
  // Deliberately NOT reusing waitForPaneIdle/paneLooksIdle/clearInputBuffer from
  // agent-process.ts -- those are tuned to Claude Code's TUI (see spec, Risks).
  // Simple, conservative delivery: send the literal text, then Enter, with a
  // fixed settle delay. Less robust than the Claude path; revisit once this
  // has real usage data (see spec Testing Plan step 4).
  runTmux(null, ['send-keys', '-t', session, '-l', text])
  await new Promise(r => setTimeout(r, 300))
  runTmux(null, ['send-keys', '-t', session, 'Enter'])
  return 'sent'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/copilot-agent-process.test.ts`
Expected: PASS (6/6)

- [ ] **Step 5: Wire it into the messages route**

Find the `POST /api/messages` handler (grep `sendPromptToSession(` under `src/web/routes/`). Where it currently resolves the destination session and calls `sendPromptToSession(session, ...)` unconditionally, branch on the destination agent's engine:

```typescript
const destEngine = readAgentEngine(toAgentName)
if (destEngine === 'copilot') {
  await sendPromptToCopilotSession(session, formatCopilotInboundMessage(fromAgentName, content))
} else {
  await sendPromptToSession(session, /* existing Claude framing */, host)
}
```

Match the existing variable names at that call site exactly (`toAgentName`/`fromAgentName`/`content` are placeholders for whatever the route actually calls them — read the surrounding function signature before editing).

- [ ] **Step 6: Manual verification**

With the test Copilot agent from Task 3 running:
1. From the dashboard or `POST /api/messages`, send a short message from `marveen` to the test Copilot agent.
2. `tmux attach -t agent-<test-name>` and confirm the message landed as a fresh prompt (not appended to stale text, not stuck in an input box).
3. Send a reply from the Copilot agent back to `marveen` the same way; confirm `marveen`'s pane receives it (this direction DOES go through the existing Claude-side `sendPromptToSession`, unchanged — just confirming the round trip).

- [ ] **Step 7: Commit**

```bash
git add src/web/copilot-agent-process.ts src/web/routes/<messages-route-file>
git commit -m "feat(agents): deliver inter-agent messages to copilot-engine agents"
```

---

## Task 5: Dashboard UI — engine selector

**Files:**
- Modify: `web/index.html` (wizard step 1 panel — add an engine `<select>` next to the existing `#agentModel` element)
- Modify: `web/app.js:2726-2735` (POST body for agent creation) and the agent-card render function (grep `securityProfile` in `app.js` near line 3410 for the detail-panel pattern to mirror for a card-level engine badge)
- Modify: `src/web/routes/agents.ts` (accept `engine` in the `POST /api/agents` body handler, and include it in the agent info response — mirror the existing `securityProfile` field, e.g. around the `displayName`/`securityProfile` reads at lines ~467-476)
- Modify: `src/web/agent-put-fields.ts` (add `engine` to `AgentPutFieldCheck`, mirroring the `securityProfile` validator at line ~25, so it's editable after creation too)

- [ ] **Step 1: Add the HTML control**

In `web/index.html`, find the wizard step 1 panel containing the `id="agentModel"` select. Add immediately after it:

```html
<label for="agentEngine">Engine</label>
<select id="agentEngine">
  <option value="claude" selected>Claude Code</option>
  <option value="copilot">GitHub Copilot CLI</option>
</select>
```

- [ ] **Step 2: Include it in the creation POST**

In `web/app.js`, at the `fetch('/api/agents', ...)` call (~line 2726-2735), add `engine: document.getElementById('agentEngine').value` to the JSON body.

- [ ] **Step 3: Backend accepts and stores it**

In `src/web/routes/agents.ts`, find the `POST /api/agents` handler's body-parsing (same place `model`/`profile`/`description` are read from the request body) and write `engine` into the newly-created `agent-config.json` alongside the existing fields — default to `'claude'` when absent so old dashboard frontends (or direct API calls) keep working unchanged.

- [ ] **Step 4: Backend exposes it on GET**

In the same file, around the `displayName: readAgentDisplayName(name)` / `securityProfile: readAgentSecurityProfile(name)` block (~lines 467-476), add `engine: readAgentEngine(name)`.

- [ ] **Step 5: Editable post-creation**

In `src/web/agent-put-fields.ts`, add an `engine` entry to the field-check map alongside `securityProfile` (~line 25), validating it's `'claude'` or `'copilot'`.

- [ ] **Step 6: Render an engine badge on the agent card**

In `web/app.js`, find where the agent card DOM is built (search for where `securityProfile` or `displayName` get rendered into card markup) and add a small badge/label showing the engine when it's `'copilot'` (omit the badge for `'claude'` — the current default look stays byte-identical for every existing agent).

- [ ] **Step 7: Manual verification**

1. Reload the dashboard, open "Ügynök felvétele", confirm the Engine dropdown appears and defaults to Claude Code.
2. Create a test agent with Engine = GitHub Copilot CLI.
3. Confirm its card shows the Copilot badge and `GET /api/agents/<name>` returns `"engine":"copilot"`.
4. Start it from the dashboard button (not the API directly this time) and confirm it comes up the same way Task 3's manual check did.

- [ ] **Step 8: Commit**

```bash
git add web/index.html web/app.js src/web/routes/agents.ts src/web/agent-put-fields.ts
git commit -m "feat(dashboard): engine selector and badge for copilot-engine agents"
```

---

## Task 6: Full end-to-end validation + spec risk sign-off

**Files:** none (validation only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: all tests pass, including the new ones from Tasks 1-4.

- [ ] **Step 2: Walk the spec's Testing Plan (docs/superpowers/specs/2026-08-26-copilot-fleet-agent-design.md, "Tesztelési terv") end to end** with the user present:
  1. Confirm `copilot login` state (already logged in per 2026-08-26 investigation, but confirm it's still valid).
  2. Real (non-Marveen) manual `copilot --allow-all-tools --config-dir <test-dir>` sanity check.
  3. Marveen-integrated create/start/stop (Task 3).
  4. Inter-agent message round trip (Task 4).
  5. Kanban card assigned to the Copilot agent; observe it pick up and act on the task.

- [ ] **Step 3: Update the spec's "Kockázatok / nyitott kérdések" section** with what was actually observed (message delivery reliability, `--config-dir` first-run behavior, `--continue`/`--resume` semantics) — replace the pre-implementation guesses with real findings.

- [ ] **Step 4: Update the Obsidian project note** (`01_Projects/Marveen.md` in the vault) — move this item from "Következő lépések" into "Jelenlegi állapot" with the same kind of concrete summary used for the 2026-08-26 MCP/Telegram work, and add anything genuinely surprising to "Tanulságok".

- [ ] **Step 5: Commit and push to both remotes**

```bash
git push origin main
git push brunella main
```
