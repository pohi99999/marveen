# One-press deploy: merge GO and dashboard restart as one owner approval

Before this, putting a reviewed fork PR live took the owner three steps: a "go live" in the chat (the merge), a
`service_restart` approval button, and, for #59, a third button. This page is the one-press path: the main agent asks,
the owner sees exactly which SHA goes live and that the dashboard restarts, and one press merges, pulls, builds and
restarts, on exactly that SHA. On by default: `FORK_DEPLOY_VIA_APPROVAL=on`. Switching it back on after `off` needs the
owner's session. macOS (launchd) only. Marker: FORKDEPLOY1121 (Péter GO 17701, Marveen 8629/8631).

Other approvals keep their own buttons: a scheduled shell command (`schedule_command`) is still a separate decision.

## The shape of the PR

The SHA the owner approves must be the SHA that goes live, so the merge is a **fast-forward of one commit**, not a
squash (a squash commit is born at the merge, after the press). Before asking for the review, the PR branch is brought
to ONE commit whose only parent is the fork's `main`. The reviewer (Ellenőr) measures that commit, and the same SHA goes
in the request. GitHub marks the PR merged when its head lands on `main`.

## The request

`POST /api/fork-deploy-specs`, filed only by the main agent (`marveen`), or the helper:

```bash
bash scripts/marveen-api.sh fork-deploy-request marveen <pr-number> <full-head-sha>
```

```json
{ "spec_version": 1, "pr": 61, "sha": "<40 lower-case hex>" }
```

Only the PR number and the head SHA are sent. The server measures everything else in the install's git
(`src/web/fork-deploy-approval.ts`, `buildForkDeploySpec`), and refuses with 409, opening nothing, unless all of these hold:

- the install is on `main` with no local changes to tracked files;
- `fork/main` and every mirror's `main` (`brunella`) are the install's `HEAD` (`git ls-remote`);
- `refs/pull/<pr>/head` on the fork is the named SHA (a head that moved after the review is refused);
- that commit has exactly one parent, the install's `HEAD`.

The commit subject is shown as written, so it may hold printable ASCII and the Hungarian accented letters only. A
look-alike letter, a no-break space or a bidi or zero-width character is refused with 400 (reword the commit).
Caps: one open request per SHA, three in all; a request times out after 12 hours.

The answer is `201 { ok: true, approvalId, contentHash, text }`. The canonical spec (sorted keys) goes into
`fork_deploy_specs`, a security table agents cannot write (`SECURITY_TABLES`, `scripts/hooks/db-write-gate.mjs`), and a
`fork_deploy` approval is opened whose `content_hash` is the spec's sha256. Nothing is pushed, pulled or restarted yet.

## What the owner sees

Rendered by the server from the stored spec, in this order:

- PR number and commit subject;
- the full old SHA (fork main and the install), and the full new SHA (the PR head);
- the change's size (files, `+`/`-` lines), and whether `package-lock.json` changes (then `npm ci` runs);
- the targets of the push (`fork`, `brunella`);
- that the dashboard (`com.<service>.dashboard`) restarts, with an expected outage of about 5-15 s, and that a failed
  build or start puts the install back on the old SHA with a report;
- that a moved main, mirror or install before the press means nothing happens and a new request is needed;
- the requester: on the shared token a self-declared name, said so;
- the spec version and the check code (the first 10 hex characters of the content hash).

The decision is the same as for the other hash-bound categories: the Telegram buttons carry the check code
(`apr:<id>:<nonce>:a|r:<10 hex>`), a missing or different code is `content_changed`, the typed command cannot decide
it (`button_only`), and the dashboard approve needs the owner's session and the shown hash. `POST /api/approvals` with
this category is 403, and the generic consume refuses it.

## The press

After the decision commits, the consumer consumes the approval once (within an hour of the decision), stamps the spec
row (`outcome = started`) and re-checks the stored spec. Then it starts `scripts/fork-deploy.sh` as a **detached**
process: its own process group, so `launchctl kickstart -k` of the dashboard does not stop it. (Measured 2026-11-21 with
a throwaway launchd job: the detached child ran on after the kickstart, a child in the job's own group died with it.)

The script, logging to `store/fork-deploy/<approval id>.log` and writing each stage to `store/fork-deploy/<approval id>.json`:

1. checks every precondition again, fresh (install, fork main, mirrors, one commit);
2. `git merge --ff-only <sha>` in the install, `npm ci` only when `package-lock.json` changed, `npm run build`, and
   checks that `dist/.built-commit` is the new SHA;
3. backs up `store/claudeclaw.db` (sqlite's backup API, `integrity_check`) to `store/backups/fork-deploy-*.db`, the last
   three kept;
4. pushes the SHA to `fork/main`, then to each mirror (fast-forward only, never forced);
5. writes a `--- RESTART ... fork-deploy <old>..<new> ---` marker to `store/dashboard.log`, restarts the dashboard
   (`launchctl kickstart -k gui/<uid>/com.<service>.dashboard`), and waits up to 120 s for the NEW dashboard: its boot
   stamp (`store/fork-deploy/boot.json`, written at every dashboard start with the commit its dist was built from) must
   name the new SHA, started after the restart, and the port must answer 200.

**When something fails:**

| Where | What happens | Fork main | Install |
| --- | --- | --- | --- |
| a precondition | nothing | old | old |
| build, `npm ci`, the backup, the fork push | the install goes back to the old SHA (`reset --keep`, rebuild), no restart | old | old |
| a mirror push | the deploy goes on; the report names the mirror to bring up by hand | new | new |
| the new dashboard does not come up | the install goes back to the old SHA, rebuilt, restarted again | **new** | old |
| the rollback fails too | the script itself sends the owner a Telegram line (`scripts/notify.sh`) | new | ? |

The report of a final stage goes to the main agent and to the owner on Telegram, sent by the dashboard that sees it: the
old one when the script stopped before the restart, the new one after it (its start-up sweep watches a running deploy
for 15 minutes). A rollback after the restart says in words that the fork main and the install are apart, and that a
decision is needed (a fixing PR or a revert commit).

**Start-up sweep.** A deploy decided while the dashboard was down is started at the next start, within the hour; later
it is refused (`consume_refused:...`). A consumed deploy without a stage file is marked `interrupted`, reported, and
never re-run.

## Turning it off

`FORK_DEPLOY_VIA_APPROVAL=off` closes the filing route (403). A request filed before stays open, and approving it still
deploys: to stop everything, switch it off and reject the open `fork_deploy` approvals.

## Rollback

- **A deploy that should not have gone live:** a revert commit as a new PR, deployed the same way.
- **The code:** reverting the commit removes the route, the consumer, the sweep, the boot stamp and the script. The
  `fork_deploy_specs` table stays in the database (`CREATE TABLE IF NOT EXISTS`); the revert takes it off the
  security-table list too, and nothing reads it then, so it may be dropped. `store/fork-deploy/` and
  `store/backups/fork-deploy-*.db` can be deleted by hand.
