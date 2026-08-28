# outgoing-copy-gate — PreToolUse hook

## Problem

An agent's outbound copy — a Telegram reply, an email, a Bash-invoked send —
can carry mistakes that only matter once they reach a real person: an em
dash used as a substitute for a proper thought-break, a `--` doing the same
job, stripped Hungarian accents, a misspelled name, or an invisible
mixed-script (homoglyph) character that breaks search/grep on the sent text
without ever being visible to the eye. Nothing upstream of the actual send
call checked for any of this — a bad message would go out, and the mistake
would only surface after the fact, in front of the recipient.

## What it checks

`scripts/hooks/outgoing-copy-gate.py` runs on `PreToolUse` and audits the
outbound text before the send happens:

1. **Em dash (U+2014)** — forbidden in every deliverable, no exceptions.
2. **Double hyphen as an em-dash substitute** (`" -- "` in prose) — same
   complaint as the em dash, checked separately from code/CLI `--flag`
   syntax (which is stripped out before this check runs).
3. **Missing Hungarian accents** — accent-insensitive Hungarian-language
   detection, then a large accentless→accented word dictionary
   (`ACCENTLESS` in the script) flags stripped-accent spellings. Falls back
   to an accent-ratio heuristic for long stretches of prose that don't hit
   enough dictionary words directly.
4. **Mixed-script (homoglyph) words** — a word that mixes Latin letters with
   a look-alike character from another script (e.g. Cyrillic) is invisible
   to the eye but silently breaks grep/full-text search on the sent copy.
5. **Owner-specific name rules** — e.g. a frequently-misspelled surname.
   Loaded from an **untracked local file**
   (`store/outgoing-copy-gate-rules.json`, shape
   `{"bad_name_patterns": [...], "correction": "..."}`) rather than
   hardcoded in the script, since a personal name rule shouldn't ship in a
   public repo. A missing/empty rules file is never silent — see fail-open
   vs. fail-closed below.

## How it's wired

Registered in `.claude/settings.json` under `PreToolUse`, matching three
different call shapes, all routed to the same script:

- `Bash` — but only commands the gate recognises as an actual *send*
  invocation (`sendmail`/`msmtp`/`swaks`, `send.py --to`, `graph-mail send`,
  a `curl`/`wget` targeting `api.resend.com`, or an interpreter `-c`/`-e`
  string that both spawns a process and names a sender program). This is
  **position-aware**, not a substring search on the whole command string —
  an early version matched on raw text and produced false positives on
  things like an inter-agent message that merely *mentioned* `send.py` in
  its own JSON body.
- `.*send_email.*` (MCP tool matcher) — direct email-send tool calls.
- `mcp__plugin_telegram_telegram__reply` — the Telegram reply tool.

For a Bash send, the gate still has to recover the actual body text from
the shell command (`--body`/`--subject` flags, heredocs, or `< file`
redirection) before it can audit anything.

## Fail-open vs. fail-closed

The two channels are handled differently on purpose:

- **Email is fail-closed.** If the body can't be recovered (e.g. a
  `--body "$(cat file)"` that reaches the hook unexpanded, or a pipe the
  hook can't see into), or the name-rules file is missing, the send is
  **blocked**. Email is deferrable, and a silently-skipped name check is
  worse than a delayed send.
- **Telegram is fail-open on internal hook errors** (but still blocks on an
  actual finding). Telegram is the owner's only supervision channel — a
  gate crash that silences it costs more than one slipped accent would. A
  missing name-rules file on this path logs a `systemMessage` warning
  instead of blocking, since it's the one place the warning is actually
  seen by the running session.

A found problem always blocks the send (exit code 2, explanation on
stderr) regardless of channel — the fail-open/fail-closed distinction is
only about what happens when the hook itself *can't tell*.

## Known edge cases (why some things look more complex than they need to)

- Command-position detection went through several false-positive/negative
  rounds: quoted strings and heredoc bodies are excluded from the "is this
  actually a send" scan (so content that merely *mentions* a send pattern
  doesn't trigger it), while quoted URL arguments in their normal `curl`
  position still count.
- A handful of accentless Hungarian words are intentionally **excluded**
  from the dictionary because the same spelling is also a valid word
  without the accent (`mar`, `meg`, `kor`, `szamlazz`, …) — including them
  would false-positive on correct text.
- Technical spans (URLs, emails, code spans, `snake_case` identifiers,
  filenames/domains, paths) are stripped before the accent and dashboard
  checks run, so e.g. the identifier `video_view` doesn't get flagged as
  the unaccented Hungarian word "video".

## Related

- [channel-reply-guard.md](channel-reply-guard.md) (deprecated) /
  [telegram-reply-enforcement-2026-08-02.md](telegram-reply-enforcement-2026-08-02.md)
  — the *did the agent reply at all* problem; this gate is orthogonal —
  *is the reply's content clean*.
