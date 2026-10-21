# Security Audit — brunella-marveen

**Audit date:** 2026-10-21
**Version audited:** `package.json` 1.44.0, commit `c02033c3` on `main`
**Change policy:** only Critical and High findings were fixed in this change, and only with small, low-risk edits. Everything else is a recommendation.
**Secrets:** none are reproduced here. Where a secret-shaped string was found, only its location and type are given.

## Contents

1. [Scope](#1-scope)
2. [Method](#2-method)
3. [Summary](#3-summary)
4. [Critical](#4-critical)
5. [High](#5-high)
6. [Medium](#6-medium)
7. [Low](#7-low)
8. [Controls that work](#8-controls-that-work)
9. [Fix order for the open findings](#9-fix-order-for-the-open-findings)

---

## 1. Scope

The whole repository was in scope:

- the Node/TypeScript server (`src/`), including the dashboard HTTP API (`src/web.ts`, `src/web/**`, `src/web/routes/**`) and the channel coordinator (`src/channel-coordinator*`);
- the dashboard frontend (`web/`);
- every shell, Python and Node helper script, and every hook (`scripts/`, `scripts/hooks/`);
- the installers and the updater (`install*.sh`, `install-windows.ps1`, `update.sh`, `scripts/install-*.sh`);
- the seed and template content agents follow (`seed-config/`, `seed-skills/`, `seed-scheduled-tasks/`, `templates/`), plus `docs/`, `.github/workflows/`, `.gitignore` and `.claude/settings.json`;
- the full git history: 2014 commits across all 5 remote branches. The session's clone was shallow and was un-shallowed before the scan.

Out of scope:

- the live, running deployment and its `.env` or `store/` contents;
- third-party plugins that are not vendored here, such as the Telegram channel plugin itself;
- the Claude Code CLI.

## 2. Method

**Secret scan of the git history**
- Every added line in `git log --all -p` was checked against high-confidence patterns:
  - Anthropic and OpenAI keys
  - Telegram bot tokens
  - GitHub, AWS, Google API, Slack and Stripe tokens
  - PEM private keys and JWTs
  - `token=`/`secret=` assignments of 40 or more hex characters
- Paths added at any point in history were also checked against `store/`, `logs/`, `.env*`, `*.db`, `*.log`, `*.pem`/`*.key`, credential files and evidence or transcript folders.

**`.gitignore` and `.env` review**
- Checked what `.gitignore` covers, and traced how `.env` is loaded and passed on to child processes.

**Dependencies**
- `npm audit` on the committed `package-lock.json`, with `npm ls` used to trace each finding to its parent package.

**Manual code review**, split into four parallel tracks, with every reported claim re-checked against the source before inclusion:
- Dashboard authentication and authorization: route enumeration, the auth-gate allowlist, the bind address, timing-safe comparisons, CORS and CSRF, static file serving, and tokens in query strings.
- Command injection and path traversal: every `exec`/`spawn`/`sh -c` call and every filesystem path built from request, agent, Telegram or file input, in TypeScript and in the scripts.
- Hook gates and prompt injection: how each gate behaves on error, timeout, missing interpreter and malformed input; Claude Code's exit-code semantics (only exit 2 blocks); and the trust paths for email, web, Telegram and inter-agent messages.
- Installers and credential handling: `curl | sh` patterns and pinning, tokens on the command line (`ps`) or in logs, credential file modes, and the tmux environment.

**Tests**
- `npm run typecheck` and the vitest suite. The suite refuses to run in a live install, so it was run from a clean git worktree under `$HOME` with a scratch `HOME`.

## 3. Summary

| Severity | Count | Fixed in this change |
|---|---|---|
| Critical | 0 | – |
| High | 6 | 4 (H1–H4) |
| Medium | 14 | 0 |
| Low | 14 | 0 |

**Secrets in git history: none found.**
- The scan found 8 secret-shaped strings, all in test fixtures:
  - `src/__tests__/secret-gate.test.ts`: a fake GitHub token, AWS's documented example key, a dummy JWT and a PEM header
  - `src/__tests__/agent-terminal-mask-keys.test.ts`: a fake Anthropic-prefixed string
  - `src/__tests__/agent-transcript.test.ts`: a PEM header
  - `src/__tests__/fixtures/skill-scan/14-api-key-shaped.{md,expected.json}`: a fake Stripe-prefixed string
- All of them are deliberate dummy values for the secret-gate and masking tests.
- No `store/`, `.env`, database, log or credential file was ever committed.
- `.gitignore` covers `.env` and `.env.*` (keeping `.env.example`), `store/`, `agents/`, `*.db*`, `*.log`, `*.secret*`, evidence and transcript folders, `.mcp.json` and `.channels-config/`. A gitleaks CI job (`.github/workflows/secret-gate.yml`) runs on top of that.

**The overall posture is unusually defensive** for a self-hosted tool:
- the dashboard binds to loopback by default;
- secrets are compared timing-safely;
- subprocesses are called with argument arrays (no shell);
- governance hooks are wrapped so that they fail closed.

**The main structural weakness is one shared dashboard bearer token.** It is held by the operator and by every agent. Because of it, the server cannot tell agents apart, or an agent from the owner. Most of the remaining High and Medium findings (H5, H6, M1) come from this, and they need a design change (per-agent credentials), not a patch.

---

## 4. Critical

None found.

---

## 5. High

### H1 — Command injection in the Slack smoke-test route — **FIXED**

**Where:** `src/web/routes/agents.ts:1343-1360` (before the fix: `execSync(\`bash "${scriptPath}" "${name}"\`)`)

**Why it matters:**
- `name` is the URL-decoded `:name` path segment of `POST /api/agents/:name/channels/slack/smoke-test`, and it was inserted unvalidated into a double-quoted `sh -c` string.
- A name such as `$(cmd)/../<real-slack-agent>`, URL-encoded, normalises to an existing agent directory, so every existence and config check passes. The `$(cmd)` part then runs as the dashboard user.
- That command runs outside every agent-side PreToolUse gate (destructive, egress, credential) and leaves no tool-call audit trail.
- Precondition: a Slack agent exists with `SLACK_SMOKE_TEST_ALLOWED=true`.

**Fix (applied):**
- The route now calls `execFileSync('bash', [scriptPath, name], …)`, so no shell is involved.
- H2 additionally makes such a name throw before any file access.

### H2 — `%2F..` in an agent name resolves to the agents base directory; `DELETE` wipes every agent — **FIXED**

**Where:** `src/web/agent-config.ts:46` (`agentDir`) and `src/web/sanitize.ts:35-42` (`safeJoin`). Exploited through `src/web/routes/agents.ts:2711-2743` (DELETE) and about 30 other `/api/agents/:name/*` routes that only `decodeURIComponent` the name.

**Why it matters:**
- `safeJoin` deliberately accepts a target equal to the base directory.
- So `DELETE /api/agents/x%2F..` gives `name = "x/.."`, which resolves to `agentDir = AGENTS_BASE_DIR`, which then runs `rmSync(AGENTS_BASE_DIR, {recursive: true})`.
- That one call deletes every sub-agent's persona, config, channel tokens and state.
- `foo%2F..%2Fbar` likewise redirects any route to another agent's directory.

**Fix (applied):**
- `agentDir()` now refuses any name that is empty, `.`, `..`, or contains `/`, `\` or NUL. An agent name is one path segment, which matches `sanitizeAgentName()`.
- Handlers already turn the thrown error into a 500, and the internal callers that tolerate odd names wrap `agentDir` in `try`.

**Further recommendation:** validate `:name` once, in a shared helper for every `/api/agents/:name/*` route (`sanitizeAgentName(name) === name`), and return 400 instead of 500.

### H3 — The live dashboard token was written into the model's prompt — **FIXED**

**Where:** `src/web/voice-directive.ts:50-77` (`buildTtsDirective`). It is served by `GET /api/voice/directive` (`src/web/routes/voice.ts:178`) and injected on every voice turn by `scripts/hooks/voice-reply-directive.py`.

**Why it matters:**
- The directive contained the token's actual value (`Authorization: Bearer <value>`).
- That token gives full admin access to the dashboard. Through the directive it reached:
  - Claude transcripts and `.jsonl` session files
  - compaction summaries
  - conversation exports
  - every downstream log of the prompt.

**Fix (applied):**
- The directive now contains `$(cat '<store>/.dashboard-token')`, so the shell reads the 0600 file when the command runs. This matches the pattern used elsewhere in the repo.
- The remaining exposure on curl's command line is covered by M4.

**Existing installs:** the token is already in the transcripts of past voice turns, so rotating it is recommended (delete `store/.dashboard-token` and restart).

### H4 — The channel-coordinator backfill bypassed the Telegram sender allowlist — **FIXED**

**Where:** `src/channel-coordinator.ts`, `processBatch()` and `reconcilePending()`; the mapping is in `src/channel-coordinator/telegram-client.ts:100-124`.

**Why it matters:**
- While the native Telegram poller is down, the coordinator reads the bot's `getUpdates` directly. It handed every update to the main agent: any DM, any group message, any `channel_post`, from any user.
- Each one arrived as a `<channel source="telegram" …>` envelope, which the provenance gate and the agent's instructions treat as a real owner-channel message.
- The plugin's `access.json` pairing and allowlist were skipped entirely.
- The main agent runs with `--dangerously-skip-permissions`. A stranger who messaged the bot therefore had a direct prompt-injection path into the most privileged agent.

**Fix (applied):**
- New `isAllowedInboundSender()` applies the same rule as the plugin:
  - a DM whose sender is in `allowFrom`;
  - a chat in `groups`, where a non-empty per-group `allowFrom` must also contain the sender;
  - or `ALLOWED_CHAT_ID`.
- It fails closed: if `access.json` cannot be read, only `ALLOWED_CHAT_ID` is admitted.
- Dropped updates are marked `failed` with a reason, so the reconcile replay never resurrects them. Events already stored are also filtered on replay.
- Approval button presses still go to the dashboard, which checks the sender against the owner itself.
- Regression tests: `src/__tests__/security-audit-fixes.test.ts`.

### H5 — Any agent can approve an approval request, including an outgoing email — NOT FIXED (needs a design change)

**Where:**
- `src/web/routes/approvals.ts:457-490`: `PATCH /api/approvals/:id` accepts a self-declared `resolved_by`. The only check is `resolved_by !== target.agent_id`, and the code comment itself says identity cannot be enforced under the shared token.
- `src/web/routes/approvals.ts:332` and the GET routes return the full row, including `owner_nonce`.
- `scripts/hooks/email-approval-gate.py:519-526` accepts any `status='approved'` row with a matching `content_hash`, whoever resolved it.

**Why it matters:**
- A prompt-injected agent can do the whole loop alone:
  1. create an `email_send` approval;
  2. PATCH it to `approved` with `resolved_by: "owner"`;
  3. send the email.
- No human is involved at autonomy level 2, which is exactly the level meant to require the owner.
- The owner nonce, which is meant to protect the Telegram button path, also comes back in the response to the requesting agent.

**Why not fixed here:**
- The main agent legitimately approves through this PATCH (with the shared token) after asking the owner in chat. Restricting it would break that flow.
- An existing test asserts that `owner_nonce` appears in the POST response.

**Recommended fix:**
- Stop returning `owner_nonce` from any API response, and update the test.
- Make the email gate accept only approvals whose `resolved_by` is `telegram-owner` (set server-side by `applyOwnerDecision`) or a dashboard session/device-key user. Record that resolver kind server-side from `ctx.auth.kind`, never from the request body.
- Have `/telegram-decision` accept only the in-process coordinator, and never trust `from_id` from the request body.
- Long term: give each agent its own credential (see M1).

### H6 — Agents can raise their own autonomy level and change other gate inputs — NOT FIXED (needs a design change)

**Where:**
- `src/web/routes/autonomy.ts:52-85`: `POST /api/autonomy` has no auth-kind check, so the shared token suffices.
- `store/autonomy-config.json`, including its `maxLevel`, is writable through the agent's own file tools.
- `scripts/hooks/email-approval-gate.py:640` (`if level >= 3: exit 0`) trusts that file as it stands.
- The same applies to `store/verified-recipients.json`, the `EMAIL_RECIPIENT_LEDGER=off` switch in `.env` (`scripts/email-send-gate.mjs:647`), and the approvals SQLite database that the gate reads.

**Why it matters:**
- A compromised agent can switch off the email approval gate without the owner knowing, by raising `email_send` to level 3.
- The gate only protects anything if the inputs it reads cannot be changed by the agents it gates.

**Why not fixed here:** in token mode the dashboard UI also uses the shared token. Restricting the route to session or device-key auth would break token-mode installs, and a file-write guard needs a new PreToolUse gate.

**Recommended fix:**
- Allow `POST /api/autonomy` only from an operator session or device key.
- Add a PreToolUse Write/Edit/Bash guard, modelled on the existing `egress-allowlist.json` guard in `self-pace-gate.mjs`, that protects:
  - `store/autonomy-config.json`
  - `store/verified-recipients.json`
  - `.env`
  - `store/*.db`
  - `agents/*/.claude/settings*.json`
- Pin `maxLevel` in code instead of reading it from the editable file.

---

## 6. Medium

**M1 — Inter-agent sender identity is self-declared, and sub-agent→main messages get trusted-peer framing.**
- **Where:**
  - `src/web/routes/messages.ts:160-300`: `from` is taken from the request body.
  - `src/team-trust.ts:63`: `if (from === ctx.mainAgentId || to === ctx.mainAgentId) return true`.
- **Why it matters:** any sub-agent can post as the main agent (`from=<main>`), which every agent then trusts. Every message from a sub-agent to the main agent is also wrapped as `<trusted-peer>`. So a web-reading agent that has been prompt-injected can steer the most privileged agent with coworker authority.
- **Fix:**
  - Give each agent its own token, or require an HMAC over `from` keyed per agent, and derive the sender from the credential.
  - Until then, deliver sub-agent→main messages as untrusted with a sender label, and refuse `from=<main>` unless the main agent's credential sent it.

**M2 — Agent bundle import copies symlinks and executable config unchecked.**
- **Where:** `src/web/agent-bundle.ts:261` (`tar -xzf`) and `:287` (`cpSync(stagedAgentDir, dest, {recursive: true})`).
- **Why it matters:**
  - A bundle can ship `agent/SOUL.md` as a symlink to `~/.claude/.credentials.json` or an SSH key, which the dashboard's persona and file views then read back.
  - It can also ship `.claude/settings.json` hooks or a `.mcp.json` that run as soon as the imported agent starts.
- **Fix:**
  - After extraction, walk the tree with `lstat` and reject symlinks and hard links, as the skills import already does.
  - Copy only the `PORTABLE_ENTRIES` allowlist.
  - Strip hook and MCP config from the bundle, or require explicit operator confirmation for it.

**M3 — macOS Keychain: the vault master key is readable by any app and sits on argv.**
- **Where:** `src/web/keychain.ts:54-61`: `security add-generic-password … -w <value> -A`.
- **Why it matters:** `-A` lets every application read the item without a prompt, and passing `-w <value>` puts the key in `ps` output while the command runs.
- **Fix:** drop `-A`. The item is then trusted only for the `security` tool, which is also what reads it back. Do not pass the value on argv: use a native binding, or `-w` as the last argument so `security` prompts for it. This was not changed here because it cannot be verified on macOS from this environment.

**M4 — The dashboard token and the Telegram bot token appear on the command line (readable through `ps` / `/proc/*/cmdline`).**
- **Where:** about 42 files use `curl -H "Authorization: Bearer $(cat …/.dashboard-token)"` (the shell expands `$(cat …)` before curl starts, so the value is in curl's argv). Examples:
  - `src/web/agent-scaffold.ts` (14 copies, including `:2592`, `:3500`, `:3707-3741`)
  - `src/web/heartbeat-agent-scaffold.ts:246-249`
  - `src/web/routes/kanban.ts:73`
  - `src/web/federation/onboarding.ts:95,141,211,237`
  - `scripts/agent-msg.sh:147`, `scripts/agent-msg-get.sh:29`, `scripts/channels.sh:1137,1163`, `scripts/watchdog.sh:129`
  - `scripts/hooks/provenance-gate.py:425,699,764,785`, `scripts/hooks/memory-lookup-nudge.py:91`
  - `seed-scheduled-tasks/*/SKILL.md`, `templates/profiles/researcher.json:33`
- The Telegram bot token is in URLs at `scripts/lib/send-telegram.sh:46`, `scripts/channel-outage-alarm.sh:108`, `install-linux.sh:1056-1073` and `install-macos.sh:458-475`.
- **Fix:** move to the helpers the repo already has:
  - `scripts/lib/curl-tok.sh` (`curl -K -` from stdin)
  - `-H @<0600 header file>` (as in `scripts/pre-pr-review.sh:116`)
  - `-K /dev/fd/3` (as in `scripts/supabase-q.sh:117-126`)

  For the bot URL: `printf 'url = "…/bot%s/…"' | curl -K -`.

**M5 — The admin token is accepted in a query string.**
- **Where:** `src/web/auth-gate.ts:151-156` accepts `?token=` on `GET /api/agents/:name/pane/stream`, and the frontend always uses it (`web/app.js:18117`).
- **Why it matters:** the full shared token ends up in reverse-proxy and Tailscale access logs and in browser history.
- **Fix:** issue a short-lived, single-use stream ticket, the way `video-review` already does.

**M6 — No Host-header allowlist (DNS rebinding), and the login lockout is shared.**
- **Where:**
  - `src/web/csrf-origin.ts:31-45`: same-origin is decided by comparing Origin with Host.
  - `src/web/login-throttle.ts:26,65`: 50 failures per hour, counted across all users, lock every login. Operator-login failures add to the same counter (`src/web/routes/operator.ts:277`).
- **Why it matters:** a rebinding page can reach the unauthenticated endpoints from the victim's browser, to guess passwords or to lock out all logins. No token or cookie leaks this way.
- **Fix:**
  - Reject any request whose `Host` is not on an allowlist: `localhost`, `127.0.0.1`, `[::1]`, `DASHBOARD_PUBLIC_URL`'s host and the configured origins.
  - Give operator login its own throttle counter.

**M7 — A non-loopback bind is allowed silently, over plain HTTP.**
- **Where:** `src/config.ts:350` (`WEB_HOST`, default `127.0.0.1`) and `src/web.ts:359`.
- **Why it matters:** with `WEB_HOST=0.0.0.0`, the token and cookies cross the network in cleartext, and nothing warns about it.
- **Fix:** log a loud warning, or refuse to start, when `WEB_HOST` is not loopback unless an explicit `DASHBOARD_TLS_TERMINATED=1`-style acknowledgement is set.

**M8 — Third-party scripts load without integrity checks, and the dashboard sends no security headers.**
- **Where:** `web/index.html:8-14` loads `@xterm/xterm@5`, `@xterm/addon-fit@0.10` (both floating versions) and `qrcode-generator@2.0.4` from `cdn.jsdelivr.net`, with no SRI hashes. The server sends no `Content-Security-Policy`, `Referrer-Policy` or `X-Frame-Options`.
- **Why it matters:** whoever controls that CDN content runs JavaScript on the dashboard, where it can read the token from `localStorage`.
- **Fix:**
  - Pin exact versions and add `integrity="sha384-…" crossorigin="anonymous"`, or vendor the files.
  - Add `Content-Security-Policy: script-src 'self' <pinned CDN>`, `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`.

**M9 — A missing gate script silently removes the gate.**
- **Where:** `src/web.ts:663` prunes hook entries whose script is missing (`src/web/hook-registration-guard.ts:29-35`), and `src/web/agent-scaffold.ts:302-306` skips re-injecting them.
- **Why it matters:** deleting or renaming `scripts/email-send-gate.mjs`, or a broken update, turns a fail-closed gate into no gate at all. The only trace is an info-level log line.
- **Fix:** never prune security gates. Keep the fail-closed entry (exit 127 maps to block) and alert the owner.

**M10 — Agents skip permission prompts by default, and the destructive and credential gates are opt-in.**
- **Where:**
  - The main agent always runs with `--dangerously-skip-permissions`: `scripts/channels.sh:1570,1662`, `src/web/channel-monitor.ts:1159`.
  - Sub-agents get it unless their profile is `strict` (`src/web/agent-process.ts:2468`). The default profile is `permissive` (`src/web/profiles.ts:73`).
  - The destructive and credential gates are off by default (`src/web/profiles.ts:55-61`), and the main agent has neither (`src/web/agent-scaffold.ts:1556,1672`).
- **Why it matters:** this is what turns every prompt-injection path (M1, H4 before its fix, email and web content) into a high-impact one.
- **Fix:**
  - Enable the destructive and credential gates by default, including on the main agent.
  - Make web-reading profiles such as `marketer` `strict`, or at least give them the egress and credential gates.

**M11 — Installers run remote scripts without pinning or verification.**
- **Where:**
  - `install-linux.sh:700`: `curl -fsSL https://claude.ai/install.sh | bash`
  - `install-linux.sh:767` and `install-macos.sh:254`: `curl -fsSL https://bun.sh/install | bash`
  - `install-linux.sh:1746` and `install-macos.sh:1304`: `curl … ollama.com/install.sh | sh`, run after `sudo -v`
  - `install-linux.sh:518-519`: the nodesource setup script run through `sudo -E bash -`
  - `install-macos.sh:278`: `sudo npm install -g @anthropic-ai/claude-code` with no version
- **Why it matters:** each of these runs code fetched at install time, often as root, with nothing checking what was fetched.
- **Fix:**
  - Pin versions (`bun.sh/install | bash -s bun-vX.Y.Z`, `@anthropic-ai/claude-code@<ver>`), and prefer distro or apt repositories with GPG keys.
  - Drop `-E` from the `sudo` call.
  - Add `--ignore-scripts` where possible.

**M12 — The Go toolchain is installed as root from a predictable `/tmp` path without verification.**
- **Where:** `install-linux.sh:1870-1878`: `curl … -o "/tmp/${_GOTAR}"`, then `sudo tar -C /usr/local -xzf "/tmp/${_GOTAR}"`.
- **Why it matters:** on a shared host, another user can pre-create or race that file and have their content unpacked as root into a directory on PATH. The `sha256` that go.dev publishes in the same JSON is never checked.
- **Fix:** download into a `mktemp -d` directory, check the archive with `sha256sum -c` against the JSON `sha256`, then extract.

**M13 — Bootstrap and update run code from the mutable `main` branch.**
- **Where:**
  - `install-linux.sh:34-47` `source`s `install-lang.sh` fetched from `${MARVEEN_REF:-main}`.
  - `install-linux.sh:585-600` clones or pulls, then `exec`s the result.
  - `install-windows.ps1:107` writes to a fixed `/tmp/marveen-install.sh`.
  - `update.sh:558` runs `git pull --ff-only` and then `npm ci` and the build, with no signature check.
- **Why it matters:** anyone who can push to `main`, or who compromises a maintainer account, runs code on every install and update.
- **Fix:**
  - Default to a release tag, and verify it with `git verify-tag` or a published SHA-256.
  - Use `mktemp` in the Windows wrapper.

**M14 — Approval button callbacks can be replayed to the main agent, nonce included.**
- **Where:** `src/channel-coordinator.ts`, the approval branch of `processBatch()`, together with `getEventsNeedingHandoff()` (`src/channel-coordinator/ingest.ts:203-217`).
- **Why it matters:**
  - The approval relay marks its event delivered with `agent_message_id = 0`. The reconcile query treats `am.id IS NULL` as needing a handoff.
  - Until the relay finishes, the event's `agent_message_id` is still NULL.
  - Either way, the `apr:<id>:<nonce>:a` callback can be handed to the main agent: exactly the leak that card 3558 was meant to prevent.
- **Fix:** mark relayed callbacks with a distinct terminal status (for example `relayed`) that `getEventsNeedingHandoff` excludes, and set it before the relay instead of after.

---

## 7. Low

**L1 — Node gates allow the call when their stdin is malformed or empty.**
- **Where:** `scripts/email-send-gate.mjs:994`, `scripts/hooks/self-pace-gate.mjs:607`, `kanban-write-gate.mjs:115`, `egress-gate.mjs:579`, `readonly-repo-gate.mjs:328` and `digest-provenance-gate.mjs:233` all call `allow()` when JSON parsing fails.
- **Why it matters:** the harness controls this input, so only a harness bug could exploit it.
- **Fix:** exit 2, as the Python gates already do (`email-approval-gate.py:584`, `destructive-gate.py:951-955`).

**L2 — Some gate entries lack `onFailure: "block"`.**
- **Where:** `src/web/agent-scaffold.ts:1352,1376,1594,1647,1691` (kanban-write, digest-provenance, child-claude, destructive and credential gates).
- **Why it matters:** on stock macOS, which has no coreutils `timeout`, a gate that hangs is killed by Claude Code's own timeout, and that kill does not block the tool call.
- **Fix:** build these entries with `securityGateHook()`, and include them in the staleness check at `:2176-2189`.

**L3 — `outgoing-copy-gate.py` lets the call through on internal error.**
- **Where:** `scripts/hooks/outgoing-copy-gate.py:1333-1337,1415-1419`.
- **Why it matters:** this is deliberate, since it is a text-quality gate. It must not be counted as an exfiltration control.
- **Fix:** none needed; document the intent.

**L4 — The image-resize hook accepts `..` in model-supplied paths.**
- **Where:** `scripts/hooks/channel-image-resize.sh:120-133`.
- **Why it matters:** the `*/channels/*/inbox/*` pattern also matches `…/inbox/../../x.png`, so any large image the user can write to can be downscaled and moved. This affects integrity only; there is no code execution.
- **Fix:** resolve the path with `realpath` and match the result.

**L5 — `memory-save.sh` loads `.env` with word splitting and globbing.**
- **Where:** `scripts/hooks/memory-save.sh:10`: `export $(grep -v '^#' .env | xargs)`. `scripts/migrate-main-agent-id.sh:30-32` `source`s `.env`.
- **Why it matters:** `.env` values are split and glob-expanded, or run as shell code. `.env` is operator-owned, so the risk is low.
- **Fix:** use `set -a; . .env; set +a`, or the existing parser.

**L6 — Shell-string subprocess calls that are safe today.**
- **Where:**
  - `src/web/routes/skills.ts:420` and `src/web/routes/agents-skills.ts:98`: `execSync(\`unzip -o "${tmpPath}" …\`)`
  - `src/web/dashboard-settings.ts:475`: a git clone
- **Why it matters:** the inputs are a UUID path or regex-restricted, so nothing is exploitable now, but a future change to the inputs would be.
- **Fix:** switch to `execFileSync` with an argument array.

**L7 — Static file serving has no explicit containment check.**
- **Where:** `src/web/routes/static.ts:129-154`: `/avatars/` and `/icons/` use a plain `join`.
- **Why it matters:** they are safe only because WHATWG URL parsing normalises `..` and never decodes `%2F`.
- **Fix:** add `resolve` plus a `startsWith(base + sep)` check.

**L8 — Blocked URLs are logged in full.**
- **Where:** `scripts/hooks/egress-gate.mjs:535` writes `url="${url}"` to `store/egress-blocked.log`.
- **Why it matters:** query strings and `bot<token>` paths are stored verbatim.
- **Fix:** log origin and path only, or run the URL through the redactor.

**L9 — Installer output and prompts expose secrets.**
- **Where:**
  - `install-linux.sh:2575` (and `install-macos.sh` around `:1822`) prints `http://localhost:…/?token=<token>`.
  - Secret prompts use `read` without `-s`: `install-linux.sh:839,869,1097,1109,1128-1129`, `install-macos.sh:375,499,511,588-589`, `scripts/auth.sh:35,39`.
- **Why it matters:** tokens land in terminal scrollback, and typed secrets are echoed to the screen.
- **Fix:** print where the token file is (or a one-time link) instead of the token, and use `read -rsp` for secret prompts.

**L10 — Credential files can keep or get loose modes.**
- **Where:**
  - `src/google-api.ts:100` writes Google refresh tokens with no mode, so a new file is 0644 under the default umask.
  - `src/env.ts:80-82` and `src/web/model-fallback-runner.ts:93-96` keep whatever mode an existing `.env` has.
  - `store/` is created with the default umask (`src/index.ts:371`, `src/web/dashboard-auth.ts:24`).
- **Why it matters:** other local users can read Google tokens, a loose `.env`, and logs and state files under `store/`.
- **Fix:** use `atomicWriteFileSync(…, {mode: 0o600})` and `chmodSync(…, 0o600)` after rewrites, and create `store/` with `mkdirSync(…, {mode: 0o700})`.

**L11 — Predictable `/tmp` paths in agent instructions.**
- **Where:** `src/web/agent-scaffold.ts:3500,3713` and `scripts/hooks/memory-lookup-nudge.py:91` use `curl -D /tmp/mem-fejlec-<agent>.txt`.
- **Why it matters:** curl follows symlinks there, so another local user can redirect the write.
- **Fix:** use `$TMPDIR` or a folder under `store/`.

**L12 — The OAuth token and API key are exported to the tmux global environment.**
- **Where:** `scripts/channels.sh:1408-1414`.
- **Why it matters:** every pane started later inherits them, including agents meant to run on their own credential. Other users cannot reach them, because the tmux socket is 0700.
- **Fix:** rely on the 0600 pane auth file, and run `set-environment -g -u` once the pane is up.

**L13 — Dependency advisories from `npm audit` (3).**

| Package | npm rating | Path | Notes |
|---|---|---|---|
| `vite` 8.2.0 | high | dev, via `vitest` | `launch-editor` issues on Windows dev servers |
| `hono` 4.13.7 | moderate | `@anthropic-ai/claude-agent-sdk` → `@modelcontextprotocol/sdk` | `serveStatic` double-decode; `serveStatic` is not used here |
| `esbuild` 0.27.3 | low | dev, via `tsx`/`vitest` | Windows dev-server file read |

- **Why it matters:** none of the three is reachable in the production runtime as this project uses it.
- **Fix:** run `npm audit fix` (all are fixable within semver) in a separate dependency PR.

**L14 — Minor authentication hardening.**
- **Where:**
  - `src/web/dashboard-auth.ts:15-16`: no minimum strength is enforced on `DASHBOARD_TOKEN` when it comes from the environment.
  - `GET /api/agents/:name/avatar` works without auth, and its 200-or-404 answer reveals whether an agent name exists.
- **Fix:** require at least 32 characters for `DASHBOARD_TOKEN` and warn otherwise.

---

## 8. Controls that work

**Authentication**
- Loopback bind by default.
- Every token, password and HMAC check is timing-safe (`crypto.timingSafeEqual` after a length check) or done by hash lookup. Session and device-key secrets are stored only as hashes.
- Passwords use scrypt, with a dummy hash check for unknown usernames.
- Cookies are `HttpOnly; SameSite=Strict`, sessions are rotated on login, and operator keys only work on `/api/operator/*`.
- CSRF protection blocks non-GET requests from other origins. CORS echoes an origin only when it is allowlisted or same-host, and never allows credentials.
- No authentication decision trusts `X-Forwarded-For` or `remoteAddress`.

**Subprocesses and paths**
- Almost every subprocess is called with an argument array (`execFileSync`/`spawn`).
- tmux keys are sent with `send-keys -l` through `runTmux`.
- Remote ssh arguments go through `shQuote`.
- Agent launch secrets are written to 0600 files and read back with `$(cat '<file>')`.
- Path containment is solid in video review, research files, idea attachments, schedules and skill import (which rejects symlinks and `..`).

**Hooks**
- Every governance gate is wrapped so that it fails closed: an interpreter probe, an inner `timeout`, any rc other than 0 or 2 mapped to exit 2, and `onFailure: block` where configured.
- The Python gates deny on any exception, failed import or unreachable database.

**Prompt safety**
- Channel tags are neutralised with a random sentinel.
- Untrusted wrapping is used for email, calendar, memory and kanban content.
- Reserved sender ids are protected.
- Telegram commands act only for `ALLOWED_CHAT_ID`, and approval callbacks check `from.id`.

**Secrets**
- `.env` is parsed into an object and not loaded into `process.env`, so child processes do not inherit it.
- The pino logger redacts token-, key- and JWT-shaped values.
- Safe curl helpers already exist (`scripts/lib/curl-tok.sh`, the `-H @file` and `-K /dev/fd/3` patterns).
- Gitleaks runs in CI, and a pre-commit secret gate is installed.

## 9. Fix order for the open findings

1. **H5 and H6:** stop returning `owner_nonce`, and make the email gate trust only resolutions it can attribute server-side; protect the gate's input files with a write guard and restrict `POST /api/autonomy`.
2. **M1:** per-agent credentials. This removes the root cause of H5, H6 and M1.
3. **M10:** enable the destructive and credential gates by default, and make web-reading profiles `strict`.
4. **M14 and M2.**
5. **M4 and M5:** move all token use off argv and out of URLs.
6. **M6, M7 and M8:** Host allowlist, non-loopback warning, SRI and CSP.
7. **The installer items:** M11, M12 and M13.
