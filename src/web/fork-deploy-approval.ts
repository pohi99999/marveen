// FORKDEPLOY1121 (Péter GO 17701, Marveen 8629/8631): the merge GO and the dashboard restart as ONE owner press.
//   1. fileForkDeployRequest: the MAIN agent names a PR and its head SHA. The server reads the rest from git (the
//      install's HEAD, the fork's and the mirrors' main, the PR head, the commit) and refuses unless the PR head is ONE
//      commit on top of a main that the install, the fork and every mirror all stand on. It stores the canonical spec
//      (fork_deploy_specs, a security table) and opens a fork_deploy approval bound to its hash, with the owner's text
//      rendered from the stored spec and a Telegram nonce (the #59 pattern, schedule-command-approval.ts).
//   2. consumeForkDeploy, the consumer (registerApprovalConsumer): after the owner's decision committed, in ONE
//      transaction it consumes the approval (once, the same hash) and stamps the spec row; then it starts
//      scripts/fork-deploy.sh as a DETACHED process (its own process group: launchd's kickstart -k of the dashboard
//      does not take it down, measured 2026-11-21 with a throwaway job, Marveen 8633). The script checks every
//      precondition again, fast-forwards the install, builds, pushes, restarts the dashboard and waits for the NEW
//      dashboard's boot stamp; on a failed build or start it goes back to the old SHA. It writes each stage to
//      store/fork-deploy/<approval id>.json.
//   3. The outcome: the dashboard that sees the final stage (the old one when the script stopped before the restart,
//      the new one after it) records it on the spec row and reports it to the main agent and to the owner on Telegram.
//      When the script itself cannot reach a running dashboard at the end, it sends the owner a Telegram line itself.
// Only on macOS (launchd), where the install runs; elsewhere the filing route says so.
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getDb, createApproval, consumeApproval, registerApprovalConsumer, createAgentMessage, type Approval } from '../db.js'
import { MAIN_AGENT_ID, PROJECT_ROOT, STORE_DIR, SERVICE_ID, WEB_PORT } from '../config.js'
import { logger } from '../logger.js'
import {
  canonicalJson, forkDeploySpecHash, renderForkDeploySpec, recheckStoredForkDeploySpec, unshowableSubject,
  parseForkDeployRequest, validForkDeploySpec, isFullSha,
  FORK_DEPLOY_REMOTE, FORK_DEPLOY_MIRRORS, FORK_DEPLOY_BRANCH, FORK_DEPLOY_SPEC_VERSION,
  type ForkDeploySpecV1, type RequesterSource,
} from './fork-deploy-spec.js'
import { newApprovalNonce } from './telegram-approval.js'

export const FORK_DEPLOY_CATEGORY = 'fork_deploy'
/** How long the owner has to decide. The press re-checks every SHA anyway, so a late press on a moved head does nothing. */
export const FORK_DEPLOY_TIMEOUT_S = 12 * 3600
/** An approved request is started within this window of its decision; a deploy is not started days later at a boot. */
export const FORK_DEPLOY_CONSUME_WINDOW_S = 3600
export const FORK_DEPLOY_MAX_OPEN = 3
export const FORK_DEPLOY_DIR = join(STORE_DIR, 'fork-deploy')
export const FORK_DEPLOY_BOOT_FILE = join(FORK_DEPLOY_DIR, 'boot.json')
export const FORK_DEPLOY_SCRIPT = join(PROJECT_ROOT, 'scripts', 'fork-deploy.sh')
/** How long a dashboard keeps looking for the final stage of a started deploy before it reports "unknown". */
export const FORK_DEPLOY_WATCH_S = 15 * 60

export function forkDeployViaApprovalOn(setting: (key: string) => string): boolean {
  return String(setting('FORK_DEPLOY_VIA_APPROVAL') ?? '').trim().toLowerCase() === 'on'
}

export function dashboardServiceLabel(): string {
  return `com.${SERVICE_ID}.dashboard`
}

export type GitRun = (args: string[]) => Promise<{ code: number; stdout: string }>

/** git in the install, off the event loop; a spawn failure or a timeout is a non-zero code, never a throw. */
export const installGit: GitRun = (args) => new Promise((resolve) => {
  execFile('/usr/bin/git', args, { cwd: PROJECT_ROOT, timeout: 60_000, encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
    resolve({ code, stdout: String(stdout ?? '') })
  })
})

export type SpecBuild = { ok: true; spec: ForkDeploySpecV1 } | { ok: false; status: number; error: string }

/** ls-remote output -> { ref: sha }. */
function parseLsRemote(out: string): Record<string, string> {
  const refs: Record<string, string> = {}
  for (const line of out.split('\n')) {
    const m = /^([0-9a-f]{40})\t(\S+)$/.exec(line.trim())
    if (m) refs[m[2]] = m[1]
  }
  return refs
}

/**
 * Measure the state in git and build the spec, or say why not. 409 = the state does not allow this deploy (a moved
 * main, a PR head that is not one commit on top of it, a dirty install); 502 = git could not answer.
 */
export async function buildForkDeploySpec(pr: number, sha: string, git: GitRun, serviceLabel: string): Promise<SpecBuild> {
  const fail = (status: number, error: string): SpecBuild => ({ ok: false, status, error })
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch.code !== 0) return fail(502, 'git rev-parse failed in the install')
  if (branch.stdout.trim() !== FORK_DEPLOY_BRANCH) return fail(409, `the install is not on ${FORK_DEPLOY_BRANCH} (it is on ${branch.stdout.trim() || '?'})`)
  const head = await git(['rev-parse', 'HEAD'])
  const from = head.stdout.trim()
  if (head.code !== 0 || !isFullSha(from)) return fail(502, 'git rev-parse HEAD failed in the install')
  const dirty = await git(['status', '--porcelain', '--untracked-files=no'])
  if (dirty.code !== 0) return fail(502, 'git status failed in the install')
  if (dirty.stdout.trim()) return fail(409, 'the install has local changes to tracked files; a deploy needs a clean tree')

  const ls = await git(['ls-remote', FORK_DEPLOY_REMOTE, `refs/heads/${FORK_DEPLOY_BRANCH}`, `refs/pull/${pr}/head`])
  if (ls.code !== 0) return fail(502, `git ls-remote ${FORK_DEPLOY_REMOTE} failed`)
  const refs = parseLsRemote(ls.stdout)
  const forkMain = refs[`refs/heads/${FORK_DEPLOY_BRANCH}`]
  const prHead = refs[`refs/pull/${pr}/head`]
  if (!forkMain) return fail(409, `${FORK_DEPLOY_REMOTE} has no ${FORK_DEPLOY_BRANCH}`)
  if (forkMain !== from) return fail(409, `${FORK_DEPLOY_REMOTE}/${FORK_DEPLOY_BRANCH} (${forkMain}) is not the install's HEAD (${from}); bring them together first`)
  if (!prHead) return fail(409, `PR #${pr} has no head on ${FORK_DEPLOY_REMOTE}`)
  if (prHead !== sha) return fail(409, `PR #${pr}'s head on ${FORK_DEPLOY_REMOTE} is ${prHead}, not ${sha}: the head moved, the reviewed SHA is not the head`)
  for (const mirror of FORK_DEPLOY_MIRRORS) {
    const m = await git(['ls-remote', mirror, `refs/heads/${FORK_DEPLOY_BRANCH}`])
    if (m.code !== 0) return fail(502, `git ls-remote ${mirror} failed`)
    const mm = parseLsRemote(m.stdout)[`refs/heads/${FORK_DEPLOY_BRANCH}`]
    if (mm !== from) return fail(409, `${mirror}/${FORK_DEPLOY_BRANCH} (${mm ?? 'missing'}) is not the install's HEAD (${from}); sync the mirror first`)
  }

  const fetched = await git(['fetch', '--no-tags', '--quiet', FORK_DEPLOY_REMOTE, sha])
  if (fetched.code !== 0) return fail(502, `git fetch ${FORK_DEPLOY_REMOTE} ${sha} failed`)
  const parents = await git(['rev-list', '--parents', '-n', '1', sha])
  const p = parents.stdout.trim().split(/\s+/)
  if (parents.code !== 0 || p[0] !== sha) return fail(502, `git rev-list ${sha} failed`)
  if (p.length !== 2 || p[1] !== from) {
    return fail(409, `PR #${pr}'s head must be ONE commit whose only parent is ${FORK_DEPLOY_REMOTE}/${FORK_DEPLOY_BRANCH} (${from}); squash and rebase it first`)
  }
  const tree = (await git(['rev-parse', `${sha}^{tree}`])).stdout.trim()
  if (!isFullSha(tree)) return fail(502, 'git rev-parse of the tree failed')
  const subj = await git(['log', '-1', '--format=%s', sha])
  const subject = subj.stdout.replace(/\n$/, '')
  if (subj.code !== 0) return fail(502, 'git log failed')
  const why = unshowableSubject(subject)
  if (why !== null) return fail(400, `${why}; reword the commit`)
  const stat = await git(['diff', '--shortstat', from, sha])
  if (stat.code !== 0) return fail(502, 'git diff --shortstat failed')
  const num = (re: RegExp): number => Number(re.exec(stat.stdout)?.[1] ?? 0)
  const lock = await git(['diff', '--quiet', from, sha, '--', 'package-lock.json'])
  if (lock.code !== 0 && lock.code !== 1) return fail(502, 'git diff of package-lock.json failed')

  const spec: ForkDeploySpecV1 = {
    spec_version: FORK_DEPLOY_SPEC_VERSION, pr, subject, from_sha: from, to_sha: sha, to_tree: tree,
    remote: FORK_DEPLOY_REMOTE, mirrors: [...FORK_DEPLOY_MIRRORS], branch: FORK_DEPLOY_BRANCH,
    files_changed: num(/(\d+) files? changed/), insertions: num(/(\d+) insertions?\(\+\)/), deletions: num(/(\d+) deletions?\(-\)/),
    lockfile_changed: lock.code === 1, service_label: serviceLabel,
  }
  if (!validForkDeploySpec(spec)) return fail(502, 'the measured spec did not validate')
  return { ok: true, spec }
}

export interface ForkDeployFileResult { status: number; body: Record<string, unknown>; approval?: Approval }

export interface ForkDeployFileDeps {
  setting: (k: string) => string
  lang: 'hu' | 'en'
  requesterSource?: RequesterSource
  git?: GitRun
  platform?: NodeJS.Platform
  serviceLabel?: string
}

export async function fileForkDeployRequest(body: unknown, requestedBy: string, deps: ForkDeployFileDeps): Promise<ForkDeployFileResult> {
  if (!forkDeployViaApprovalOn(deps.setting)) {
    return { status: 403, body: { error: 'Deploy by approval is off (FORK_DEPLOY_VIA_APPROVAL).' } }
  }
  if (requestedBy !== MAIN_AGENT_ID) {
    logger.warn({ requestedBy }, 'fork_deploy request refused: only the main agent files one')
    return { status: 403, body: { error: `Only the main agent (${MAIN_AGENT_ID}) may ask for a deploy; send the request to it.` } }
  }
  if ((deps.platform ?? process.platform) !== 'darwin') {
    return { status: 501, body: { error: 'The one-press deploy restarts the dashboard through launchd; it runs on macOS only.' } }
  }
  const parsed = parseForkDeployRequest(body)
  if (!parsed.ok) return { status: parsed.status, body: { error: parsed.error } }
  const built = await buildForkDeploySpec(parsed.req.pr, parsed.req.sha, deps.git ?? installGit, deps.serviceLabel ?? dashboardServiceLabel())
  if (!built.ok) return { status: built.status, body: { error: built.error } }
  const spec = built.spec
  const json = canonicalJson(spec)
  const hash = forkDeploySpecHash(spec)
  const text = renderForkDeploySpec(spec, hash, deps.lang, { name: requestedBy, source: deps.requesterSource ?? 'self-declared' })
  const id = randomUUID()
  const now = Math.floor(Date.now() / 1000)
  // The count and the insert in ONE synchronous transaction, nothing awaited in between (the #59 rule).
  const filed = getDb().transaction((): 'ok' | 'cap' | 'same' => {
    const open = getDb().prepare(`
      SELECT s.to_sha FROM approvals a JOIN fork_deploy_specs s ON s.approval_id = a.id
      WHERE a.category = ? AND a.status = 'pending' AND (a.timeout_at IS NULL OR a.timeout_at > ?)
    `).all(FORK_DEPLOY_CATEGORY, now) as Array<{ to_sha: string }>
    if (open.some((o) => o.to_sha === spec.to_sha)) return 'same'
    if (open.length >= FORK_DEPLOY_MAX_OPEN) return 'cap'
    createApproval({
      id, agent_id: requestedBy, category: FORK_DEPLOY_CATEGORY, action_description: text, action_payload: null,
      timeout_at: now + FORK_DEPLOY_TIMEOUT_S, content_hash: hash, owner_nonce: newApprovalNonce(),
    })
    getDb().prepare(`
      INSERT INTO fork_deploy_specs (approval_id, spec_json, content_hash, pr, to_sha, requested_by, requested_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, json, hash, spec.pr, spec.to_sha, requestedBy, now)
    return 'ok'
  })()
  if (filed === 'same') return { status: 409, body: { error: `An open fork_deploy request already names ${spec.to_sha}; wait for the owner's decision.` } }
  if (filed === 'cap') return { status: 429, body: { error: 'Too many open fork_deploy requests; wait for the owner to decide the open ones.' } }
  logger.info({ approvalId: id, requestedBy, pr: spec.pr, to: spec.to_sha }, 'fork_deploy request filed; waiting for the owner')
  const approval = getDb().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as Approval
  return { status: 201, body: { ok: true, approvalId: id, contentHash: hash, text }, approval }
}

interface SpecRow { approval_id: string; spec_json: string; content_hash: string; consumed_at: number | null; outcome: string | null }

function setOutcome(approvalId: string, outcome: string): void {
  getDb().prepare('UPDATE fork_deploy_specs SET outcome = ?, outcome_at = ? WHERE approval_id = ?')
    .run(outcome, Math.floor(Date.now() / 1000), approvalId)
}

export interface ForkDeployReportDeps {
  toMain: (text: string) => void
  toOwner: (text: string) => void
}

let reportDeps: ForkDeployReportDeps = {
  toMain: (text) => { try { createAgentMessage('system', MAIN_AGENT_ID, text) } catch (err) { logger.error({ err }, 'fork_deploy report to the main agent failed') } },
  toOwner: (text) => {
    void import('./telegram.js').then((t) => t.sendMarveenAlert(text)).catch((err) => logger.error({ err }, 'fork_deploy report to the owner failed'))
  },
}
/** Tests swap the reporters. */
export function setForkDeployReportDeps(d: ForkDeployReportDeps): void { reportDeps = d }

export type ForkDeployConsumeStep = { go: true; spec: ForkDeploySpecV1 } | { go: false; reason: string }

/** The transaction: consume, stamp, re-check. Exported for the tests; the consumer and the sweep call it. */
export function consumeForkDeployStep(approvalId: string, nowS?: number): ForkDeployConsumeStep {
  const db = getDb()
  return db.transaction((): ForkDeployConsumeStep => {
    const row = db.prepare('SELECT approval_id, spec_json, content_hash, consumed_at, outcome FROM fork_deploy_specs WHERE approval_id = ?').get(approvalId) as SpecRow | undefined
    if (!row) return { go: false, reason: 'no_spec' }
    const c = consumeApproval({ id: approvalId, contentHash: row.content_hash, consumer: FORK_DEPLOY_CATEGORY, messageId: approvalId, windowSeconds: FORK_DEPLOY_CONSUME_WINDOW_S, category: FORK_DEPLOY_CATEGORY, nowS })
    if (!c.ok) return { go: false, reason: `consume_refused:${c.reason}` }
    const stamped = db.prepare('UPDATE fork_deploy_specs SET consumed_at = ? WHERE approval_id = ? AND consumed_at IS NULL').run(nowS ?? Math.floor(Date.now() / 1000), approvalId).changes
    if (stamped !== 1) throw new Error('fork_deploy spec already consumed while its approval was not')
    const re = recheckStoredForkDeploySpec(row.spec_json, row.content_hash)
    if (!re.ok) {
      setOutcome(approvalId, `refused:${re.reason}`)
      return { go: false, reason: re.reason }
    }
    return { go: true, spec: re.spec }
  })()
}

/** The script's stage file. Every value in it is a fixed word, a SHA, a number or a remote name. */
export interface DeployStageFile {
  approval_id: string
  stage: string
  final: boolean
  result?: 'deployed' | 'failed' | 'rolled_back' | 'rollback_failed'
  reason?: string
  from?: string
  to?: string
  prod?: string
  fork?: string
  mirrors_pushed?: string
  mirrors_failed?: string
  at?: number
}

export function stageFilePath(approvalId: string): string {
  return join(FORK_DEPLOY_DIR, `${approvalId}.json`)
}

export function readStageFile(approvalId: string): DeployStageFile | null {
  try {
    const v = JSON.parse(readFileSync(stageFilePath(approvalId), 'utf-8')) as DeployStageFile
    return v && typeof v === 'object' && v.approval_id === approvalId ? v : null
  } catch { return null }
}

export type SpawnDeploy = (args: string[], onExit: () => void) => void

/** The real start: bash scripts/fork-deploy.sh, DETACHED (its own process group), so the restart does not stop it. */
export const spawnDeployScript: SpawnDeploy = (args, onExit) => {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // the restart is always the real one: a test override in the dashboard's own environment never reaches the script
  delete env.FORK_DEPLOY_RESTART_CMD
  delete env.FORK_DEPLOY_HEALTH_TIMEOUT_S
  const child = spawn('/bin/bash', [FORK_DEPLOY_SCRIPT, ...args], { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore', env })
  child.on('exit', () => onExit())
  child.on('error', (err) => { logger.error({ err }, 'fork-deploy.sh spawn failed'); onExit() })
  child.unref()
}

let spawner: SpawnDeploy = spawnDeployScript
/** Tests swap the spawner. */
export function setForkDeploySpawner(s: SpawnDeploy): void { spawner = s }

const short = (s?: string): string => (s && isFullSha(s) ? s.slice(0, 8) : '?')

/** The report of a final stage, in Hungarian (the owner's and the main agent's language). */
export function renderOutcome(spec: ForkDeploySpecV1, f: DeployStageFile): string {
  const head = `Élesítés PR #${spec.pr} (${short(spec.from_sha)} -> ${short(spec.to_sha)})`
  const mirrorsFailed = f.mirrors_failed ? ` FIGYELEM: a tükör (${f.mirrors_failed}) NEM frissült, kézzel kell utánahúzni.` : ''
  switch (f.result) {
    case 'deployed':
      return `${head}: KÉSZ. Az éles telepítés és a ${spec.remote}/${spec.branch} is ${short(spec.to_sha)}, a vezérlőpult az új builddel fut.${mirrorsFailed}`
    case 'failed':
      return `${head}: NEM történt élesítés (${f.reason ?? 'ismeretlen ok'}). Az éles telepítés ${short(f.prod ?? spec.from_sha)}, a ${spec.remote}/${spec.branch} ${short(f.fork ?? spec.from_sha)}.${f.fork && f.prod && f.fork !== f.prod ? ' ELTÉRNEK.' : ''}${mirrorsFailed}`
    case 'rolled_back':
      return `${head}: VISSZAÁLLT (${f.reason ?? 'ismeretlen ok'}). Az éles telepítés újra ${short(f.prod)}, de a ${spec.remote}/${spec.branch} már ${short(f.fork)}: ELTÉRNEK, döntés kell (javító PR vagy visszavonó commit).${mirrorsFailed}`
    case 'rollback_failed':
      return `${head}: HIBA, a visszaállás sem sikerült (${f.reason ?? 'ismeretlen ok'}). Az éles telepítés ${short(f.prod)}, a ${spec.remote}/${spec.branch} ${short(f.fork)}. Kézi beavatkozás kell: store/fork-deploy/${f.approval_id}.log.${mirrorsFailed}`
    default:
      return `${head}: ismeretlen kimenet (${f.stage}).`
  }
}

/** Record a final stage once and report it; returns whether this call recorded it. */
export function finalizeFromStageFile(approvalId: string): boolean {
  const f = readStageFile(approvalId)
  if (!f || !f.final || !f.result) return false
  const row = getDb().prepare('SELECT spec_json, outcome FROM fork_deploy_specs WHERE approval_id = ?').get(approvalId) as { spec_json: string; outcome: string | null } | undefined
  if (!row) return false
  const outcome = `${f.result}${f.reason ? `:${f.reason}` : ''}`
  const won = getDb().prepare("UPDATE fork_deploy_specs SET outcome = ?, outcome_at = ? WHERE approval_id = ? AND (outcome IS NULL OR outcome = 'started')")
    .run(outcome, Math.floor(Date.now() / 1000), approvalId).changes === 1
  if (!won) return false
  const spec = JSON.parse(row.spec_json) as ForkDeploySpecV1
  const text = renderOutcome(spec, f)
  reportDeps.toMain(text)
  reportDeps.toOwner(text)
  logger.info({ approvalId, outcome }, 'fork_deploy outcome recorded')
  return true
}

/** The fork_deploy consumer: called by the decision core after an approval of this category committed. */
export function consumeForkDeploy(approval: Approval, nowS?: number): void {
  const step = consumeForkDeployStep(approval.id, nowS)
  if (!step.go) {
    if (!step.reason.startsWith('consume_refused:already_consumed')) {
      if (step.reason.startsWith('consume_refused:')) setOutcome(approval.id, step.reason)
      reportDeps.toMain(`Az élesítés jóváhagyott kérése (${approval.id}) nem indult el: ${step.reason}. Semmi nem változott.`)
    }
    return
  }
  const s = step.spec
  try { mkdirSync(FORK_DEPLOY_DIR, { recursive: true }) } catch { /* the script reports a missing dir */ }
  setOutcome(approval.id, 'started')
  spawner([approval.id, s.from_sha, s.to_sha, s.remote, s.mirrors.join(','), s.branch, s.service_label, String(WEB_PORT), s.lockfile_changed ? '1' : '0'],
    () => { try { finalizeFromStageFile(approval.id) } catch (err) { logger.error({ err }, 'fork_deploy finalize after exit failed') } })
  logger.info({ approvalId: approval.id, pr: s.pr, to: s.to_sha }, 'fork_deploy started')
}

let registered = false
export function registerForkDeployConsumer(): void {
  if (registered) return
  registerApprovalConsumer(FORK_DEPLOY_CATEGORY, (a) => { consumeForkDeploy(a) })
  registered = true
}

/** The dashboard's boot stamp: the commit its dist was built from, read at start. The script waits for it. */
export function writeForkDeployBootStamp(builtCommitFile = join(PROJECT_ROOT, 'dist', '.built-commit')): void {
  let built = ''
  try { built = readFileSync(builtCommitFile, 'utf-8').trim() } catch { /* no stamp: the script will not accept this boot */ }
  try {
    mkdirSync(FORK_DEPLOY_DIR, { recursive: true })
    const tmp = `${FORK_DEPLOY_BOOT_FILE}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ pid: process.pid, built_commit: isFullSha(built) ? built : '', started_at: Math.floor(Date.now() / 1000) }) + '\n')
    renameSync(tmp, FORK_DEPLOY_BOOT_FILE)
  } catch (err) { logger.error({ err }, 'fork_deploy boot stamp write failed') }
}

/**
 * At server start: a started deploy whose final stage is already written is recorded; one still running (this is the
 * new dashboard the script is waiting for) is watched until its final stage or FORK_DEPLOY_WATCH_S; an approved,
 * unconsumed request is started now (inside its consume window).
 */
export function sweepForkDeployOnStart(nowS = Math.floor(Date.now() / 1000)): { finalized: number; watching: number; started: number } {
  const db = getDb()
  const running = db.prepare("SELECT approval_id, consumed_at FROM fork_deploy_specs WHERE consumed_at IS NOT NULL AND (outcome IS NULL OR outcome = 'started')").all() as Array<{ approval_id: string; consumed_at: number }>
  let finalized = 0
  let watching = 0
  for (const r of running) {
    if (finalizeFromStageFile(r.approval_id)) { finalized++; continue }
    if (!existsSync(stageFilePath(r.approval_id))) {
      setOutcome(r.approval_id, 'interrupted')
      reportDeps.toMain(`Az élesítés (${r.approval_id}) a jóváhagyás után nem indult el (nincs lépésfájl). Nem indítom újra: nézd meg a fork main és az éles telepítés állását, és ha kell, kérd újra.`)
      continue
    }
    watching++
    watchStageFile(r.approval_id, r.consumed_at + FORK_DEPLOY_WATCH_S)
  }
  const pending = db.prepare(`
    SELECT a.* FROM approvals a JOIN fork_deploy_specs s ON s.approval_id = a.id
    WHERE a.category = ? AND a.status = 'approved' AND a.consumed_at IS NULL AND s.consumed_at IS NULL AND s.outcome IS NULL
  `).all(FORK_DEPLOY_CATEGORY) as Approval[]
  for (const a of pending) consumeForkDeploy(a, nowS)
  return { finalized, watching, started: pending.length }
}

function watchStageFile(approvalId: string, untilS: number): void {
  const tick = (): void => {
    try {
      if (finalizeFromStageFile(approvalId)) return
      if (Math.floor(Date.now() / 1000) > untilS) {
        const row = getDb().prepare('SELECT outcome FROM fork_deploy_specs WHERE approval_id = ?').get(approvalId) as { outcome: string | null } | undefined
        if (row && (row.outcome === null || row.outcome === 'started')) {
          setOutcome(approvalId, 'unknown')
          const f = readStageFile(approvalId)
          const text = `Az élesítés (${approvalId}) ${FORK_DEPLOY_WATCH_S / 60} perc után sem írt végeredményt (utolsó lépés: ${f?.stage ?? '?'}). Nézd meg: store/fork-deploy/${approvalId}.log.`
          reportDeps.toMain(text)
          reportDeps.toOwner(text)
        }
        return
      }
    } catch (err) { logger.error({ err }, 'fork_deploy watch tick failed') }
    setTimeout(tick, 5_000).unref()
  }
  setTimeout(tick, 1_000).unref()
}
