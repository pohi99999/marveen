# A scheduled shell command through an approval

A `command` task runs a shell command on a schedule, inside the dashboard process (`bash -lc`), outside every tool gate,
on every occurrence until it is switched off. Creating one directly (`POST /api/schedules` with `type: "command"`) needs
the owner's dashboard session (OWNEREXEC1109), and that does not change. This page is the second path: the main agent
asks, the owner approves on Telegram or on the dashboard, and only then does the server create exactly what the owner
saw. On by default: `SCHEDULE_COMMAND_VIA_APPROVAL=on`. Switching it back on after `off` needs the owner's session.
Marker: SCHEDCMDAPPROVAL1121.

## The request

`POST /api/schedule-command-specs`, filed only by the main agent (`marveen`):

```json
{
  "spec_version": 1,
  "name": "psearch-grant-ingest-daily",
  "schedule": "23 5 * * *",
  "command": "bash /Users/pohi/work/psearch-ingest/run-daily.sh PSEARCH_SB_SECRET_KEY",
  "timeoutMs": 900000,
  "failThreshold": 1,
  "description": "P-Search napi pályázat-betöltés"
}
```

- The fields are exactly what a command task's `task-config.json` carries for its run. An unknown field is refused with
  400. A missing `timeoutMs` or `failThreshold` gets the runner's defaults (10 s, 2), written into the spec, so the
  owner sees the real values.
- `name` is a task name (lower-case letters, digits, single dashes, at most 64), `schedule` a five-field cron in
  printable ASCII (a no-break or fullwidth character in the cron is refused, so the owner reads what the runner parses).
- `command` is one line of **printable ASCII** (0x20-0x7E), at most 2000 characters, without leading or trailing
  whitespace. A look-alike letter (Cyrillic `а`, Greek `ο`), a no-break or ideographic space, a variation selector or a
  control, bidi or zero-width character is refused: each would make the command the owner reads differ from the one
  bash runs. Several steps go on one line with `;` or `&&`.
- `description` (at most 500) may be Hungarian; it is shown, not run. Control and invisible format characters are
  refused there too.
- **Who may ask.** Only `marveen`. A sub-agent's own token is refused, by this route and by the agent-token route list.
  On the shared token the name is **self-declared** (the `X-Agent-Id` header or the claimed agent): any agent holding
  the shared token could claim it. The owner's approval is therefore the real protection, and the owner's text says
  where the name came from (below).
- Caps: at most 3 open requests, one per task name; an existing task name is 409, a fourth open request 429.

The answer is `201 { approvalId, contentHash, text }`. The server stores the canonical spec (sorted keys, no whitespace)
in `schedule_command_specs`, a security table agents cannot write (`scripts/hooks/db-write-gate.mjs`,
`SECURITY_TABLES`), and opens a `schedule_command` approval whose `content_hash` is the sha256 of that JSON. Nothing is
created yet. The request times out after 24 hours.

## What the owner sees

Plain text (no parse mode), rendered by the server from the stored spec:

- a warning that the command runs in the dashboard process, outside every tool gate, until switched off;
- the task name, the cron, then **the command verbatim on its own line**;
- the timeout, the failure threshold, the description, the agent, the spec version;
- the requester: `kérő: marveen (saját tokennel azonosítva)` on the agent's own token, or
  `kérő: marveen (a közös tokennel, ÖNBEVALLOTT név: bármelyik ügynök írhatta, csak a jóváhagyásod véd)` on the shared
  token;
- the check code: the first 10 hex characters of the content hash.

The requesting agent's own words never reach that text except the fields of the spec itself.

## The decision

`schedule_command` is hash-bound (`HASH_BOUND_APPROVAL_CATEGORIES`) and server-consumed (`SERVER_CONSUMED_CATEGORIES`).

- **Telegram.** Both buttons carry the check code: `apr:<id>:<nonce>:a|r:<10 hex>` (62 bytes, under Telegram's 64).
  The press goes through the decision core with that hash; a missing or different code is refused as
  `content_changed`. A rejection needs no code. The typed `/approvals … approve <nonce>` command cannot decide a
  hash-bound request (`button_only`).
- **Dashboard.** `PATCH /api/approvals/:id` needs the owner's session and the shown `content_hash`: without it 400, with
  another 409.
- `POST /api/approvals` with this category is 403, and the generic category consume refuses it (`wrong_category`): only
  the server spends this approval.

## The create

After the approval commits, the consumer (`src/web/schedule-command-approval.ts`):

1. in one transaction consumes the approval (once, with the same hash, within 7 days of the decision), stamps the spec
   row, and re-checks the stored spec: canonical, the approved hash, still valid under the request rules (the ASCII rule
   included);
2. creates the task through `createScheduledTask` (`src/web/schedule-create.ts`), the same validation, write and
   registry registration `POST /api/schedules` uses;
3. writes the outcome on the spec row (`created`, or the reason). Anything but `created` alerts the main agent.

**Start-up sweep.** An approved, unconsumed request (decided while the server was down) is consumed then. A request
consumed without an outcome (a crash between the two) is marked `interrupted` and alerted, never re-run. An approval
past its consume window is refused once (`consume_refused:expired` on the row) and not picked up again.

## Turning it off

`SCHEDULE_COMMAND_VIA_APPROVAL=off` (dashboard settings) closes the filing route: `POST /api/schedule-command-specs`
answers 403. The setting is read only there. A request filed before the switch stays open, and approving it still
creates the task (the consumer does not read the setting). To stop everything, switch it off and reject the open
requests.

## Rollback

- **Stop new requests:** `SCHEDULE_COMMAND_VIA_APPROVAL=off`, then reject the open `schedule_command` approvals.
- **A task created this way** is an ordinary command task: switch it off or delete it on the dashboard's schedules
  page, as any other. Its spec row keeps the record (`outcome = created`, `created_task`).
- **The code:** reverting the commit removes the route, the consumer and the sweep; the Telegram buttons of the other
  categories keep their old format. The `schedule_command_specs` table stays in the database (it was created with
  `CREATE TABLE IF NOT EXISTS` and nothing reads it after the revert); dropping it is not needed and, being a security
  table, it is not writable by agents anyway.
