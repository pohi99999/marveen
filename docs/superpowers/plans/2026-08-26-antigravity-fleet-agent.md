# Antigravity CLI (`agy`) Fleet Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Use `[ ]`/`[x]` syntax for tracking.

**Goal:** Let a Marveen fleet agent run the Antigravity CLI (`agy`, Gemini
models) as a third engine option alongside `claude` and `copilot`, so tasks
can be delegated to it when Claude/Copilot credit is tight. See
`docs/superpowers/specs/2026-08-26-antigravity-fleet-agent-design.md` for the
full design and rationale — this plan only breaks it into executable steps.

**Baseline:** `main` branch, already contains the `copilot` engine (merged
and live-validated). This plan builds a peer engine using the SAME pattern
where possible, and REFACTORS the one place that was hardcoded to `copilot`
literally (`message-router.ts`'s `isCopilotEngine`) into a general engine
switch, because a third parallel `=== 'antigravity'` branch there would be
the worst kind of duplication.

**Key simplification vs. the Copilot plan:** no config-dir isolation needed.
`agy` scopes conversations/projects by the launching `cwd` (verified:
`~/.gemini/config/projects/<uuid>.json` stores `{"name": "<abs cwd>"}`), and
authentication lives in the shared `$HOME/.gemini` (a full HOME override
triggers an interactive OAuth prompt — confirmed by a live isolated-HOME
probe). So agents just launch from their own `agentDir(name)`, same as the
Claude engine already does.

---

## Task 1: Widen the engine type to include `'antigravity'`

**Files:** `src/web/agent-config.ts`, `src/web/routes/agents.ts`,
`src/__tests__/agent-config-engine.test.ts` (extend existing file)

- In `agent-config.ts`: change `readAgentEngine`/`writeAgentEngine` signatures
  from `'claude' | 'copilot'` to `'claude' | 'copilot' | 'antigravity'`.
  `readAgentEngine` must still default to `'claude'` for anything that is not
  exactly `'copilot'` or `'antigravity'` (missing file, corrupt JSON, unknown
  string) — do not change that fallback behavior, only widen the accepted set.
- In `routes/agents.ts`: the `POST /api/agents` handler's engine normalization
  (`const engine: 'claude' | 'copilot' = rawEngine === 'copilot' ? 'copilot' :
  'claude'`) becomes a 3-way check: `'copilot'` and `'antigravity'` pass
  through as themselves, anything else becomes `'claude'`. Same for the `PUT
  /api/agents/:name` engine-update validation (`data.engine !== 'claude' &&
  data.engine !== 'copilot'` — add the third accepted value). Update the
  JSDoc comment listing the accepted engines (currently says "'claude'
  (default) or 'copilot'").
- Extend `src/__tests__/agent-config-engine.test.ts` with cases for
  `'antigravity'`: write+read round-trip, and confirm an unknown string
  (e.g. `'bogus'`) still falls back to `'claude'` (regression guard — this
  behavior must survive the widening).

**Verify:** `npx vitest run src/__tests__/agent-config-engine.test.ts` and
`npx tsc --noEmit` (or the project's build script) both clean.

---

## Task 2: Antigravity command builder + launcher (pure logic, new file)

**Files:** new `src/web/antigravity-agent-process.ts`, new
`src/__tests__/antigravity-agent-process.test.ts`

Model this file directly on `src/web/copilot-agent-process.ts`, but WITHOUT
any config-dir concept (see spec's "Kulcsfontosságú felfedezés" section for
why). Concretely:

- `buildAntigravityLaunchCommand(opts: { resume: boolean; model?: string;
  effort?: 'low' | 'medium' | 'high' }): string` — pure function, no I/O.
  Builds: `agy --dangerously-skip-permissions` + (`--continue` if
  `opts.resume`) + (`--model <shSingleQuote(opts.model)>` if `opts.model` is
  set) + (`--effort <opts.effort>` if `opts.effort` is set — no quoting
  needed, it's a closed enum). Reuse `shSingleQuote` from
  `agent-process.ts` (already exported, already used by
  `copilot-agent-process.ts` — import it the same way). Order of flags:
  `--dangerously-skip-permissions`, then `--continue` (if resuming), then
  `--model`, then `--effort` — deterministic order matters for the test
  assertions, pick this one and test it exactly.
- `startAntigravityAgentProcess(name: string, opts: { fresh?: boolean } =
  {}): { ok: boolean; pid?: number; error?: string }`:
  - `existsSync(agentDir(name))` check, `isAgentRunning(name)` check — same
    guard shape as `startCopilotAgentProcess`.
  - **No `mkdirSync` for a config dir** — nothing to create.
  - Resume detection: unlike Copilot (which checks for a `session-state`
    folder inside its own config-dir), there is no per-agent directory that
    is exclusively ours to stat. Use a small sentinel file instead:
    `join(agentDir(name), '.antigravity-started')`. `resume = existsSync(that
    file) && !opts.fresh`. After a successful `tmux new-session` call, write
    that sentinel (`writeFileSync(that path, new Date().toISOString())` —
    content doesn't matter, only existence). Write it AFTER the tmux launch
    succeeds, not before (mirror the try/catch shape below).
  - Read the agent's configured model via `readAgentModel(name)` (already
    imported/used elsewhere in `agent-process.ts` — check its exact import
    path) and pass it as `opts.model` to the command builder. There is no
    existing per-agent "effort" field in `agent-config.ts` — do NOT invent
    one in this task; just never pass `effort` (leave the flag off). A
    follow-up can wire an effort field later if wanted.
  - Launch: `runTmux(null, ['new-session', '-d', '-s', session, '-c', dir,
    cmd])` inside try/catch, same error-message shape as
    `startCopilotAgentProcess`.
  - Export `agentSessionName` re-export line is NOT needed here (only one
    file needs to re-export it, and `copilot-agent-process.ts` already does
    — anything importing it can get it from either file or straight from
    `agent-process.ts`; check `agent-process.ts`'s wiring in Task 3 to see
    which import path it actually needs and import directly from there
    instead of introducing a second re-export of the same symbol).
- `formatAntigravityInboundMessage(safeFrom: string, content: string,
  category: AgentMessageCategory): string` — copy
  `formatCopilotInboundMessage`'s logic verbatim (same envelope shape
  `[Uzenet @<from>-tol]: <content>`, same fail-closed non-trusted-peer
  warning text — reuse the identical `COPILOT_UNTRUSTED_WARNING` string
  content but as a new constant `ANTIGRAVITY_UNTRUSTED_WARNING` in this file,
  same wording). Keep the comment explaining WHY (ink-TUI, no Claude-prompt
  framing) — copy that reasoning from copilot-agent-process.ts, adapted to
  say "Antigravity CLI" instead of "Copilot CLI".
- `sendPromptToAntigravitySession(session: string, text: string):
  Promise<'sent'>` — copy `sendPromptToCopilotSession` verbatim (newline
  flattening, `withSessionSendLock`, `send-keys -l` then `Enter`, the
  fail-open warning log). Same reasoning comments, adapted wording.

**Verify:** new test file covers: (a) `buildAntigravityLaunchCommand` with no
options → just `agy --dangerously-skip-permissions`; (b) with
`resume: true` → adds `--continue` in the right position; (c) with a model
containing a character that needs quoting → `--model` value is
single-quoted via `shSingleQuote` (same style of test as
`copilot-agent-process.test.ts`'s quoting case — read that file first for
the exact assertion style and mock setup, since importing the real
`agent-process.js` on this Windows dev checkout throws at module load
without `tmux`; the existing Copilot test file's mock-the-whole-module
pattern is the one to copy). `npx vitest run
src/__tests__/antigravity-agent-process.test.ts` green.

---

## Task 3: Wire start/stop lifecycle in `agent-process.ts`

**Files:** `src/web/agent-process.ts`

- Import `startAntigravityAgentProcess` from the new file (mirror the
  existing `import { startCopilotAgentProcess } from
  './copilot-agent-process.js'` line).
- In `startAgentProcess` (around the existing `if (readAgentEngine(name) ===
  'copilot') { return startCopilotAgentProcess(name, opts) }` branch — find
  it near line 961 per the Copilot commit), add a sibling branch:
  ```
  if (readAgentEngine(name) === 'antigravity') {
    return startAntigravityAgentProcess(name, opts)
  }
  ```
  Keep it BEFORE any Claude-specific setup in the function, same position as
  the Copilot branch (early return, so none of the Claude scaffolding below
  it runs for an antigravity agent).
- **Known parked gap from the Copilot review (still open, do not silently
  extend it further):** a remote/ssh-configured agent
  (`readAgentRemoteConfig`) is checked BEFORE either engine branch and would
  silently route through the Claude-only remote path regardless of engine.
  This plan does not fix that pre-existing gap (out of scope, same as it was
  for Copilot) — just don't make it worse; place the antigravity branch at
  the same point as the copilot one (after the remote check, same as
  today), so the pre-existing gap's scope doesn't change.
- Confirm `isAgentRunning`/`stopAgentProcess` need NO changes (verify by
  reading them — they're pure tmux-session-existence checks per the
  Copilot design's Task 3 finding; if that's still true here, no diff
  needed in this task beyond the import + branch above).

**Verify:** `npx tsc --noEmit` clean. `npx vitest run` on whatever existing
agent-process test files exist and pass on this Windows checkout today
(check baseline pass/fail counts first — this repo has known
Windows-vs-WSL test gaps unrelated to this change; do not treat pre-existing
unrelated failures as caused by this task, but DO treat any NEW failure as
this task's regression).

---

## Task 4: Message delivery — generalize `isCopilotEngine`, add antigravity branch

**Files:** `src/web/message-router.ts`, new test file
`src/__tests__/message-router-antigravity-delivery.test.ts` (mirror
`message-router-copilot-delivery.test.ts` from the Copilot plan if it
exists on `main` — check first).

This is the highest-risk task in this plan (same file where the Copilot
plan's final review found a CRITICAL cross-task defect: the Claude-tuned
readiness gate silently swallowed all Copilot delivery). Read the current
`isCopilotEngine` code (around line 585-740, per the earlier investigation)
CAREFULLY before touching it.

- Replace `const isCopilotEngine = readAgentEngine(msg.to_agent) ===
  'copilot'` with `const destEngine = readAgentEngine(msg.to_agent)` once,
  then derive `const usesClaudeTuiDelivery = destEngine === 'claude'`.
- The readiness-gate skip condition changes from `if (!isCopilotEngine &&
  !(await isSessionReadyForPrompt(...)))` to `if (usesClaudeTuiDelivery &&
  !(await isSessionReadyForPrompt(...)))` — i.e. the gate (and everything
  inside its block: stuck-session detection, the parked-input janitor) now
  runs ONLY for `'claude'`-engine agents, and is skipped for BOTH
  `'copilot'` and `'antigravity'` — same reasoning as the existing comment
  block explains for Copilot (the gate is Claude-TUI-specific), just
  worded to cover both non-Claude engines now. Update the big explanatory
  comment above this line to describe the general case ("any non-Claude
  engine") rather than only Copilot — do not delete the reasoning, expand
  it.
- In the delivery branch (further down, where
  `sendPromptToCopilotSession`/`formatCopilotInboundMessage` are currently
  called for the copilot case and the Claude wrap+send path is used
  otherwise): change the two-way branch into a three-way one:
  - `destEngine === 'copilot'` → existing Copilot formatting/send calls,
    unchanged.
  - `destEngine === 'antigravity'` → `formatAntigravityInboundMessage` +
    `sendPromptToAntigravitySession`, imported from the new
    `antigravity-agent-process.js`.
  - else (`'claude'`) → existing Claude wrap + `sendPromptToSession` path,
    unchanged.
- Grep the WHOLE file for any other `isCopilotEngine` or literal
  `=== 'copilot'` occurrences you have not yet touched (the earlier
  investigation found 5 matches in this file total — make sure all of them
  are accounted for, either generalized or deliberately left copilot-only
  with a one-line comment saying why antigravity doesn't need that branch).
- **Do NOT touch** `stuck-input-watcher.ts` or `channel-monitor.ts` in this
  task. The Copilot final review flagged those as sharing the same root
  cause but currently no-op "by coincidence, not by design" for non-Claude
  engines — that is explicitly parked as a separate future follow-up in
  both the Copilot spec and this one. Broadening the guard there is out of
  scope for this plan; do not expand scope here.

**Verify:** new test file covers the three-way branch (a message routed to a
`'claude'`-engine, a `'copilot'`-engine, and an `'antigravity'`-engine agent
each take the correct path) plus a regression check that the readiness gate
still runs for `'claude'` and still gets skipped for `'copilot'` (protect
the exact bug the Copilot final review found from resurfacing). Run this
new test file directly with `npx vitest run
src/__tests__/message-router-antigravity-delivery.test.ts` and confirm
green — do not rely solely on the whole-suite run given the pre-existing
Windows/WSL gaps.

---

## Task 5: Dashboard UI — engine selector gets a third option

**Files:** `web/index.html`, `web/app.js`, possibly
`src/web/agent-put-fields.ts` and `src/web/routes/agents.ts` (PUT validation)

- Find the engine `<select>` markup added for the Copilot option (search
  `web/index.html` for `copilot` near an `engine` select — the Copilot plan
  added this in its Task 5, commit `96360e6`, message "engine selector and
  badge for copilot-engine agents"). Add a third `<option value="antigravity">
  Antigravity (Gemini)</option>` (or whatever label convention the existing
  Copilot option uses — match its exact style/casing).
  the two create the same badge and add a third case:
  `antigravity` → e.g. an "AG" or "🌐"-style badge distinct from the
  existing Claude/Copilot ones — check what visual distinction the
  Copilot badge used (color, initials, icon) and follow the same pattern
  for consistency, just with different initials/color.
- In `src/web/routes/agents.ts`'s `PUT /api/agents/:name` engine-value
  validation (already touched in Task 1) — confirm the accepted-values
  check already covers `'antigravity'` from Task 1; if Task 1 was done
  correctly this task should need NO further backend validation changes,
  only the two frontend files. Only touch `agent-put-fields.ts` if you find
  it duplicates the accepted-engine list separately (check first — the
  Copilot plan's Task 5 reviewer found the PUT-value-validation logic lives
  in the route handler, not in `agent-put-fields.ts`'s name-only checker;
  confirm that is still true here before assuming you need a change there).

**Verify:** `npx tsc --noEmit` clean (if `web/app.js` is type-checked by the
project's config; if it's plain JS outside the TS project, skip). Manually
inspect the rendered HTML/JS diff for correctness — there is no automated
UI test in this repo for this surface (confirmed by the Copilot plan's
Task 5 review, which found "no test for the PUT 400-rejection path... is
consistent with a pre-existing gap on sibling fields" — same applies here,
don't invent a new UI test framework for this one file).

---

## Task 6: Final whole-branch review + live WSL validation

Same shape as the Copilot plan's Task 6 (which found and fixed a CRITICAL
defect before merge — do not skip or shortcut this).

1. Run the FULL test suite once on the final branch state
   (`npx vitest run`), compare pass/fail counts against the documented
   pre-existing baseline (216 failing / 2261 passing / 204 skipped as of
   the Copilot merge — re-confirm this baseline is still accurate on
   current `main` before comparing, since other work may have landed since)
   — zero new regressions is the bar, not a specific total.
2. Dispatch ONE opus-tier "final whole-branch review" pass across the
   entire diff (base..tip of this plan's commits), explicitly asking it to
   check for the SAME class of cross-task defect the Copilot review found:
   does ANY earlier-task change silently make a LATER task's code
   unreachable or wrongly-gated? Pay special attention to Task 4's
   message-router.ts refactor interacting with Task 3's lifecycle wiring.
3. Merge to `main` locally, push to both `origin` and `brunella` remotes
   (same as the Copilot plan's finishing step).
4. **Live WSL deployment + validation** (do this with the user watching,
   not unattended — background scaffold generation calls burn Claude
   credit and can silently hang for hours on a spend-limit, as happened
   during the Copilot live test):
   - `git fetch fork && git cherry-pick` the new commits onto the WSL
     `~/marveen` install (it is a SEPARATE shallow clone of upstream
     `Szotasz/marveen`, NOT connected to the dev fork — confirmed during
     the Copilot deployment; do not attempt a plain `git pull` there).
   - `npm run build` (tsc) clean.
   - Restart the dashboard + channels tmux sessions using the
     properly-quoted `tmux new-session -d -s <name> "<full command
     including redirects>"` form (a bare `nohup ... &` inside
     `scripts/start.sh` gets killed when the invoking shell exits — this
     bit twice during the Copilot deployment).
   - Create a throwaway `engine: 'antigravity'` test agent via the
     dashboard API (skip AI-generated CLAUDE.md/SOUL.md if the Claude
     credit limit is active — write minimal placeholder files by hand,
     exactly as done for the Copilot live test).
   - Start it, confirm `ps aux` shows a real `agy --dangerously-skip-
     permissions ...` process (not `claude`), send it an inter-agent test
     message via `POST /api/messages`, confirm delivery + a real reply
     appears in the tmux pane, confirm the message's status update
     matches whatever Task 4 implemented (likely `'delivered'`, same
     limitation as Copilot, since antigravity has no completion write-back
     either — confirm this explicitly rather than assuming).
   - **Additionally, specifically for this engine** (per the spec's open
     risk): stop the test agent, start it again from the SAME `agentDir`,
     and confirm `--continue` actually resumes the same conversation
     (check the pane for prior context, not a fresh greeting) — this is
     the one behavior this plan could not verify statically and MUST be
     confirmed live before calling the feature done.
   - Stop the test agent when done.
   - Record the outcome (including the `--continue` resume check result)
     in the Obsidian vault note for this feature, same as the Copilot
     deployment note.

**This task's job is to catch what Tasks 1-5 individually cannot see.** Do
not skip the live `--continue` resume check even under time pressure — it
is the one part of this design that could not be verified any other way.
