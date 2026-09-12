---
name: fleet-helper
description: Shared, dependency-free Python helpers for the agent fleet - dashboard API (memory, messages, kanban), Telegram MarkdownV2 escaping, and rule-based Mail.app triage. Use to do deterministic work (fetch/filter/SQL/format/escape) in Python instead of burning model tokens doing it in the LLM turn. The dashboard token is read from store/.dashboard-token at call time, never hardcoded.
---

# fleet-helper

Move deterministic work (fetch / filter / SQL / format / escape) out of the model
and into Python, so heartbeats and scheduled tasks stop spending tokens
re-deriving the same plumbing each cycle. Python 3 stdlib only, no pip deps.

No secrets or personal data are baked in: the dashboard token is read from
`store/.dashboard-token` at call time, the project root comes from `CLAW_DIR`
(or is auto-detected), and any personal sender/keyword lists live in a gitignored
`mail_rules.json` (see `scripts/mail_rules.example.json`).

## When to use
- Saving/searching memory, posting daily-log, sending inter-agent messages.
- Reading kanban (due today / stuck / by status) without writing SQL by hand.
- Escaping text for a Telegram MarkdownV2 message.
- An email heartbeat: pre-filter unread mail to a compact JSON before the model
  reasons about it.
- Building a token-cheap heartbeat gate (see "The heartbeat gate pattern" below).

## Scripts
- `scripts/fleet.py` - dashboard API + kanban read helpers + MarkdownV2 escaper
  (CLI and importable module).
  - **KET escaper van, es a rossz valasztas nemitja a formazast (2026-08-28-i meres).**
    `mdv2` MINDENT escapel, a `*`-ot IS: az `*felkover*` markereidbol `\*felkover\*`
    lesz, tehat sima szoveg. Ez akkor helyes, ha PROGRAMBOL rakod ossze az uzenetet
    (escapeled a dinamikus reszt, aztan te teszed ra a `*`-ot). KEZZEL IRT hosszu
    uzenethez (reggeli napindito) `mdv2b` kell: az a `*`-ot meghagyja, minden mast
    escapel, ES kuldes elott lefuttatja az `outgoing_gate_check`-et (em dash,
    ` -- `, paratlan csillag). Ha talal valamit, exit 2 es NEM ad kimenetet.
- `scripts/mail_triage.py` - rule-based unread Mail.app filter (macOS), JSON out,
  never sends and never marks read.
- `scripts/gate_example.py` - reference heartbeat gate; its shell invocation IS
  the mandatory keep-alive tool call (the LLM turn is not skipped, just cheap).
- `scripts/mail_rules.example.json` - copy to `mail_rules.json` (gitignored) with
  your real senders/keywords.
- `scripts/README.md` - full usage and the heartbeat gate pattern write-up.

## Quick start
🛑 **USE A `../../`-RELATIVE PATH, NOT A BARE RELATIVE PATH -- your shell's
CWD is your own agent directory (`<project-root>/agents/<name>/`), NOT the
repo root, so a bare relative path below resolves to nothing there.** A
sub-agent's CWD is always exactly two levels under the project root
(`agentDir()` in `src/web/agent-config.ts`: `PROJECT_ROOT/agents/<name>`), so
`../../` reaches the root from ANY agent, on ANY machine -- no hardcoded
absolute path needed. (`$CLAUDE_PROJECT_DIR`, used elsewhere for hook
`command` fields, does NOT help here: it is unset in a normal agent Bash
call, measured empty.) (Bitten twice in one night, 2026-08-17: two fleet
agents each ran a root-level `find / -iname fleet.py` trying to locate this
script -- a 10+ minute runaway search under macOS/iCloud folders.)
```bash
P=../../seed-skills/fleet-helper/scripts
python3 $P/fleet.py mdv2 "Tomorrow (8:00) - report!"   # escaped MarkdownV2 (kills *bold*)
cat brief.txt | python3 $P/fleet.py mdv2b            # keeps *bold*, refuses em dash / " -- "
python3 $P/fleet.py kanban-due
python3 $P/mail_triage.py 90                            # unread <= 90 min -> JSON
```

## The heartbeat gate pattern (the high-value idea)
Frequent heartbeats often wake the model just to run deterministic checks and
then stay silent - wasted tokens. Naively skipping the turn can be unsafe if your
channel transport (e.g. a Telegram MCP over a stdio pipe) relies on a periodic
local tool call to stay connected. The safe pattern: keep the turn but make it
cheap - the heartbeat's first action runs a `gate.py` via the shell (that one
Bash call IS the keep-alive), the gate does the deterministic checks and prints a
`has_signal` flag; on `false` the model writes one line and stops, on `true` it
only does the judgment + notification. Zero scheduler/runner changes. See
`scripts/README.md` for the full rationale and two hard-won scheduling lessons
(avoid cron collisions with other heartbeats; `skipIfBusy` trade-off).

## Pitfalls (all measured, 2026-09-09 and 2026-09-10)

- **The CLI verb is `msg`, not `send_message`.** The importable function is
  `send_message(from, to, content)`, but the CLI dispatch table takes
  `msg <from> <to> <content>`. Calling `fleet.py send_message ...` dies with
  `unknown command: send_message`. Same shape for the others: `mem-save`,
  `mem-search`, `daily-log`, `agents`, `kanban-due`, `kanban-stuck`,
  `kanban-status`, `mdv2`.
- **Prefer the helper over hand-rolled `curl` for WRITES, not just for long
  messages.** Measured 2026-09-10: a `POST /api/memories` written by hand
  returned `{"error":"Szerver hiba"}` and saved nothing, while the same content
  through `fleet.py mem-save` returned `{"ok":true,"id":...}`. The night before,
  two inter-agent messages were lost to shell quoting (a backtick started
  command substitution; an inner `"` closed the variable early). Put the body in
  a file and pass `"$(cat file)"`, or use the module.
- **Read the output; do not infer success from a missing field.** `daily-log`
  does not return an `id`, so a parser that prints `id=None` looks like a
  failure and is not one. Verify by reading the resource back
  (`GET /api/daily-log?limit=…`), not by trusting the return shape you expected.
- **A green wrapper can carry zero work.** The memory backfill endpoint answers
  `{"ok":true,"count":0}` while the embedding pipeline is down. Read `count`,
  never `ok`.

## Safety
- Token is read from `store/.dashboard-token` at call time; never printed or committed.
- Kanban helpers are READ-ONLY; mutations stay in your own audited flows.
- `mail_rules.json` (your real senders) is gitignored.
