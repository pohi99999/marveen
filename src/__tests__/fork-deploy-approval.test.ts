// FORKDEPLOY1121 (Péter GO 17701): the one-press merge + deploy, at the server, against a REAL git sandbox: PROJECT_ROOT
// is a clone of a local bare "fork" with a second bare "brunella" mirror, and the PR head is published as
// refs/pull/<n>/head, the way GitHub serves it. Both directions everywhere:
//   - only the main agent files; the setting, the platform and the generic approvals route are gates;
//   - the spec is MEASURED in git: a moved fork main, a moved mirror, a PR head that is not the named SHA, a head of two
//     commits, a dirty install, an unshowable subject: refused, no approval opened;
//   - a filed request shows the owner both full SHAs, the PR and the restart, and starts nothing;
//   - the owner's button with the right hash head starts exactly that deploy, once; a wrong head, a swapped spec, a
//     replay or a late sweep starts nothing;
//   - the final stage is recorded and reported once, to the main agent and the owner; the start-up sweep.
// SANDBOX: HOME, PROJECT_ROOT and STORE_DIR are temporary, the DB is in memory, Telegram is a recorder, the deploy
// script is never started (a recording spawner), and the reports go to recorders.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'

const h = vi.hoisted(() => ({
  root: '',
  alerts: [] as string[],
  settings: { FORK_DEPLOY_VIA_APPROVAL: 'on' } as Record<string, string>,
  telegramSends: [] as unknown[][],
}))
const tmpHome = mkdtempSync(join(tmpdir(), 'fork-deploy-home-'))
const remotes = mkdtempSync(join(tmpdir(), 'fork-deploy-remotes-'))
h.root = mkdtempSync(join(tmpdir(), 'fork-deploy-root-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
afterAll(() => {
  process.env.HOME = realHome
  Object.defineProperty(process, 'platform', realPlatform)
  for (const d of [tmpHome, remotes, h.root]) rmSync(d, { recursive: true, force: true })
})

vi.mock('../config.js', async (orig) => {
  const real = await orig<typeof import('../config.js')>()
  return { ...real, MAIN_AGENT_ID: 'marveen', PROJECT_ROOT: h.root, STORE_DIR: `${h.root}/store-dir`, CHANNEL_PROVIDER: 'telegram', TELEGRAM_BOT_TOKEN: 'tg-test-token', SERVICE_ID: 'marveen' }
})
vi.mock('../notify.js', async (orig) => ({
  ...(await orig<typeof import('../notify.js')>()),
  sendOwnerSlackDm: async () => ({ attempted: false, sent: false }),
  sendOwnerMessage: async () => ({ sent: false, reason: 'no-token' }),
}))
vi.mock('../web/telegram.js', async (orig) => ({
  ...(await orig<typeof import('../web/telegram.js')>()),
  sendTelegramMessage: async (...args: unknown[]) => { h.telegramSends.push(args); return 4242 },
  editTelegramMessageText: async () => true,
  answerTelegramCallbackQuery: async () => true,
}))
vi.mock('../owner-chat.js', async (orig) => ({ ...(await orig<typeof import('../owner-chat.js')>()), resolveOwnerChatId: () => '777001', ownerAlertChatOverride: () => null }))
vi.mock('../settings-store.js', async (orig) => ({ ...(await orig<typeof import('../settings-store.js')>()), getEffectiveSettingValue: (k: string) => h.settings[k] ?? '' }))
vi.mock('../db.js', async (orig) => {
  const real = await orig<typeof import('../db.js')>()
  return { ...real, createAgentMessage: (_f: string, _t: string, text: string) => { h.alerts.push(text); return 0 as never } }
})

const db = await import('../db.js')
const { tryHandleApprovals, applyOwnerDecision } = await import('../web/routes/approvals.js')
const { pollApprovalCallbacks } = await import('../web/approval-callbacks.js')
const { buildCallbackData } = await import('../web/telegram-approval.js')
const fd = await import('../web/fork-deploy-approval.js')
const { canonicalJson, unshowableSubject } = await import('../web/fork-deploy-spec.js')
const { SETTINGS_REGISTRY } = await import('../config-registry.js')
fd.registerForkDeployConsumer()

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' }
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8' }).trim()
const FORK = join(remotes, 'fork.git')
const BRUNELLA = join(remotes, 'brunella.git')
const WORK = join(remotes, 'work')
const OWNER_TG = '777001'
const MAIN = { kind: 'token', agent: 'marveen' }
const SESSION = { kind: 'session', user: 'owner' }

let FROM = ''
const spawned: string[][] = []
const exits: Array<() => void> = []
const toMain: string[] = []
const toOwner: string[] = []

beforeAll(() => {
  git(remotes, 'init', '-q', '--bare', '-b', 'main', FORK)
  git(remotes, 'init', '-q', '--bare', '-b', 'main', BRUNELLA)
  git(FORK, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  git(remotes, 'init', '-q', '-b', 'main', WORK)
  writeFileSync(join(WORK, 'app.txt'), 'v1\n')
  writeFileSync(join(WORK, 'package-lock.json'), '{}\n')
  git(WORK, 'add', '-A'); git(WORK, 'commit', '-q', '-m', 'base')
  git(WORK, 'remote', 'add', 'fork', FORK); git(WORK, 'remote', 'add', 'brunella', BRUNELLA)
  git(WORK, 'push', '-q', 'fork', 'main'); git(WORK, 'push', '-q', 'brunella', 'main')
  git(remotes, 'clone', '-q', '-o', 'fork', FORK, h.root)
  git(h.root, 'remote', 'add', 'brunella', BRUNELLA)
  FROM = git(h.root, 'rev-parse', 'HEAD')
  Object.defineProperty(process, 'platform', { value: 'darwin' })
})

/** Reset every repository to FROM and publish a fresh one-commit PR head as refs/pull/<pr>/head. */
function prHead(pr = 7, opts: { subject?: string; file?: string; content?: string; commits?: number } = {}): string {
  git(WORK, 'reset', '-q', '--hard', FROM)
  for (let i = 0; i < (opts.commits ?? 1); i++) {
    writeFileSync(join(WORK, opts.file ?? 'app.txt'), (opts.content ?? 'v2\n') + String(i))
    git(WORK, 'add', '-A'); git(WORK, 'commit', '-q', '-m', i === 0 ? (opts.subject ?? 'feat: change the app (#7)') : `more ${i}`)
  }
  const sha = git(WORK, 'rev-parse', 'HEAD')
  git(WORK, 'push', '-q', '--force', 'fork', `${sha}:refs/pull/${pr}/head`)
  return sha
}

async function call(method: string, path: string, body: unknown, auth: Record<string, unknown>) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  req.headers = { 'content-type': 'application/json', 'x-agent-id': String((auth as { agent?: string }).agent ?? 'unknown') }
  const out = { status: 200, body: null as any }
  const res: any = { writeHead(s: number) { out.status = s; return res }, setHeader() {}, end(c?: string) { if (c) { try { out.body = JSON.parse(c) } catch { out.body = c } } } }
  const url = new URL(`http://127.0.0.1:3420${path}`)
  expect(await tryHandleApprovals({ req, res, path, method, url, auth, fedPeer: null } as any)).toBe(true)
  return out
}
const file = (pr: number, sha: string, auth: Record<string, unknown> = MAIN, extra: Record<string, unknown> = {}) => call('POST', '/api/fork-deploy-specs', { spec_version: 1, pr, sha, ...extra }, auth)
const specRow = (id: string) => db.getDb().prepare('SELECT * FROM fork_deploy_specs WHERE approval_id = ?').get(id) as Record<string, any> | undefined
const deployApprovals = () => db.listApprovals({ category: 'fork_deploy' })
const settle = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  db.initDatabase(':memory:')
  h.alerts.length = 0
  h.telegramSends.length = 0
  h.settings = { FORK_DEPLOY_VIA_APPROVAL: 'on' }
  spawned.length = 0; exits.length = 0; toMain.length = 0; toOwner.length = 0
  fd.setForkDeploySpawner((args, onExit) => { spawned.push(args); exits.push(onExit) })
  fd.setForkDeployReportDeps({ toMain: (t) => toMain.push(t), toOwner: (t) => toOwner.push(t) })
  // every repository back on FROM
  git(WORK, 'reset', '-q', '--hard', FROM)
  git(WORK, 'push', '-q', '--force', 'fork', `${FROM}:refs/heads/main`)
  git(WORK, 'push', '-q', '--force', 'brunella', `${FROM}:refs/heads/main`)
  git(h.root, 'reset', '-q', '--hard', FROM)
  rmSync(join(h.root, 'store-dir'), { recursive: true, force: true })
})

describe('1. who may file, and the gates', () => {
  it.each([
    ['the shared token claiming a sub-agent', { kind: 'token', agent: 'kenshin' }],
    ['a sub-agent\'s own token claiming the main agent', { kind: 'token', agent: 'marveen', tokenAgent: 'kenshin' }],
    ['the shared token with no claim', { kind: 'token' }],
  ])('%s: 403, nothing opened', async (_l, auth) => {
    const sha = prHead()
    expect((await file(7, sha, auth)).status).toBe(403)
    expect(deployApprovals()).toEqual([])
    expect(h.telegramSends).toEqual([])
  })

  it('the setting off: 403; the registry default is on', async () => {
    h.settings.FORK_DEPLOY_VIA_APPROVAL = 'off'
    expect((await file(7, prHead())).status).toBe(403)
    expect(SETTINGS_REGISTRY.find((d) => d.key === 'FORK_DEPLOY_VIA_APPROVAL')?.default).toBe('on')
  })

  it('not macOS: 501 (the restart is launchd\'s)', async () => {
    const r = await fd.fileForkDeployRequest({ spec_version: 1, pr: 7, sha: prHead() }, 'marveen', { setting: (k) => h.settings[k] ?? '', lang: 'hu', platform: 'linux' })
    expect(r.status).toBe(501)
  })

  it('POST /api/approvals cannot open a fork_deploy row', async () => {
    const r = await call('POST', '/api/approvals', { agent_id: 'marveen', category: 'fork_deploy', action_description: 'x', content_hash: 'a'.repeat(64) }, MAIN)
    expect(r.status).toBe(403)
    expect(deployApprovals()).toEqual([])
  })

  it.each([
    ['an unknown field', { spec_version: 1, pr: 7, sha: 'a'.repeat(40), branch: 'x' }, 'unknown field'],
    ['a short SHA', { spec_version: 1, pr: 7, sha: 'abcdef12' }, 'full 40-character'],
    ['an upper-case SHA', { spec_version: 1, pr: 7, sha: 'A'.repeat(40) }, 'full 40-character'],
    ['a PR that is not a whole number', { spec_version: 1, pr: '7', sha: 'a'.repeat(40) }, 'pr must be'],
    ['no spec_version', { pr: 7, sha: 'a'.repeat(40) }, 'spec_version'],
  ])('%s: 400', async (_l, body, msg) => {
    const r = await call('POST', '/api/fork-deploy-specs', body, MAIN)
    expect(r.status).toBe(400)
    expect(String(r.body.error)).toContain(msg)
    expect(deployApprovals()).toEqual([])
  })
})

describe('2. the spec is measured in git; a state that does not allow the deploy is refused', () => {
  it('a fork main that moved: 409', async () => {
    const sha = prHead()
    git(WORK, 'reset', '-q', '--hard', FROM); writeFileSync(join(WORK, 'x.txt'), 'x'); git(WORK, 'add', '-A'); git(WORK, 'commit', '-q', '-m', 'x'); git(WORK, 'push', '-q', '--force', 'fork', 'HEAD:refs/heads/main')
    const r = await file(7, sha)
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('is not the install\'s HEAD')
    expect(deployApprovals()).toEqual([])
  })

  it('a mirror that moved: 409', async () => {
    const sha = prHead()
    git(WORK, 'reset', '-q', '--hard', FROM); writeFileSync(join(WORK, 'y.txt'), 'y'); git(WORK, 'add', '-A'); git(WORK, 'commit', '-q', '-m', 'y'); git(WORK, 'push', '-q', '--force', 'brunella', 'HEAD:refs/heads/main')
    const r = await file(7, sha)
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('brunella/main')
  })

  it('the PR head is not the named SHA (the head moved after the review): 409', async () => {
    const reviewed = prHead()
    prHead(7, { content: 'v3\n' })
    const r = await file(7, reviewed)
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('the head moved')
  })

  it('a head of two commits: 409 (squash and rebase first)', async () => {
    const r = await file(7, prHead(7, { commits: 2 }))
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('ONE commit')
  })

  it('local changes in the install: 409', async () => {
    const sha = prHead()
    writeFileSync(join(h.root, 'app.txt'), 'dirty\n')
    const r = await file(7, sha)
    expect(r.status).toBe(409)
    expect(r.body.error).toContain('clean tree')
  })

  it('a subject with a look-alike letter or a bidi character: 400; Hungarian letters pass', async () => {
    expect((await file(7, prHead(7, { subject: 'fix: Ellenőr аdmin' }))).status).toBe(400)
    expect((await file(7, prHead(7, { subject: 'fix: safe‮evil' }))).status).toBe(400)
    expect(unshowableSubject('docs: két javítás az Ellenőr szerint (#60)')).toBeNull()
    expect(unshowableSubject('x y')).toContain('U+00A0')
    expect(deployApprovals()).toEqual([])
  })
})

describe('3. a filed request: both SHAs, the PR and the restart shown; nothing started', () => {
  it('201; the spec is what git says; the hash is the stored JSON\'s; the Telegram buttons carry the hash head', async () => {
    const sha = prHead(7, { file: 'package-lock.json', content: '{"v":2}\n' })
    const r = await file(7, sha)
    expect(r.status).toBe(201)
    const a = db.getApproval(r.body.approvalId)!
    const row = specRow(a.id)!
    expect([a.category, a.status, a.agent_id]).toEqual(['fork_deploy', 'pending', 'marveen'])
    expect(createHash('sha256').update(row.spec_json, 'utf8').digest('hex')).toBe(a.content_hash)
    expect(canonicalJson(JSON.parse(row.spec_json))).toBe(row.spec_json)
    expect(JSON.parse(row.spec_json)).toEqual({
      spec_version: 1, pr: 7, subject: 'feat: change the app (#7)', from_sha: FROM, to_sha: sha, to_tree: git(h.root, 'rev-parse', `${sha}^{tree}`),
      remote: 'fork', mirrors: ['brunella'], branch: 'main', files_changed: 1, insertions: 2, deletions: 1, lockfile_changed: true,
      service_label: 'com.marveen.dashboard',
    })
    const text = a.action_description
    expect(text).toContain(`PR #7: feat: change the app (#7)`)
    expect(text).toContain(FROM)
    expect(text).toContain(sha)
    expect(text.split('\n')).toContain('- utána: build, és a vezérlőpult (com.marveen.dashboard) ÚJRAINDUL; várható kiesés kb. 5-15 mp. Ha a build vagy az indulás elbukik, a telepítés visszaáll a régi SHA-ra, és jelentés megy.')
    expect(text).toContain('az éles telepítés vagy a PR feje elmozdul')
    expect(text).toContain('npm ci')
    expect(text).toContain(`ellenőrző kód: ${a.content_hash!.slice(0, 10)}`)
    expect(text).toContain('ÖNBEVALLOTT')
    await settle()
    expect(h.telegramSends).toHaveLength(1)
    const [, , , extra] = h.telegramSends[0] as [string, string, string, any]
    const datas = extra.reply_markup.inline_keyboard[0].map((b: { callback_data: string }) => b.callback_data) as string[]
    expect(datas.every((d) => d.endsWith(`:${a.content_hash!.slice(0, 10)}`))).toBe(true)
    expect(spawned).toEqual([])
    // nothing moved anywhere
    expect(git(FORK, 'rev-parse', 'refs/heads/main')).toBe(FROM)
    expect(git(h.root, 'rev-parse', 'HEAD')).toBe(FROM)
  })

  it('the same SHA twice: 409; more than three open: 429', async () => {
    const sha = prHead()
    expect((await file(7, sha)).status).toBe(201)
    expect((await file(7, sha)).status).toBe(409)
    expect((await file(8, prHead(8, { content: 'b' }))).status).toBe(201)
    expect((await file(9, prHead(9, { content: 'c' }))).status).toBe(201)
    expect((await file(10, prHead(10, { content: 'd' }))).status).toBe(429)
  })
})

describe('4. the owner\'s press starts exactly that deploy, once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fork-deploy-cb-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  let n = 0
  async function press(data: string, fromId: number | string = OWNER_TG) {
    n += 1
    const f = join(dir, `cb-${n}.jsonl`)
    writeFileSync(f, JSON.stringify({ data, from_id: fromId }) + '\n')
    const [o] = await pollApprovalCallbacks(f, OWNER_TG, join(dir, `off-${n}.json`))
    return o
  }

  it('the Jóváhagyom button: consumed, the script started with the stored SHAs, outcome started; a second press does nothing', async () => {
    const sha = prHead()
    const { body } = await file(7, sha)
    await settle()
    const [, , , extra] = h.telegramSends[0] as [string, string, string, any]
    const approveData = extra.reply_markup.inline_keyboard[0][0].callback_data as string
    expect(await press(approveData)).toMatchObject({ outcome: 'approved' })
    expect(spawned).toEqual([[body.approvalId, FROM, sha, 'fork', 'brunella', 'main', 'com.marveen.dashboard', '3420', '0', '7']])
    const a = db.getApproval(body.approvalId)!
    expect([a.status, a.consumed_by, a.consumed_ref]).toEqual(['approved', 'fork_deploy', body.approvalId])
    expect(specRow(body.approvalId)).toMatchObject({ outcome: 'started' })
    expect(await press(approveData)).toMatchObject({ outcome: 'refused', reason: 'already_resolved' })
    fd.consumeForkDeploy(db.getApproval(body.approvalId)!)
    expect(spawned).toHaveLength(1)
  })

  it('a press with another hash head, or none: content_changed, nothing started', async () => {
    const { body } = await file(7, prHead())
    const a = db.getApproval(body.approvalId)!
    expect(await press(buildCallbackData(a.id, a.owner_nonce!, 'approved'))).toMatchObject({ outcome: 'refused', reason: 'content_changed' })
    expect(await press(buildCallbackData(a.id, a.owner_nonce!, 'approved', 'f'.repeat(10)))).toMatchObject({ outcome: 'refused', reason: 'content_changed' })
    expect(db.getApproval(a.id)!.status).toBe('pending')
    expect(spawned).toEqual([])
  })

  it('the typed /approvals command cannot decide it; the shared token cannot approve on the dashboard', async () => {
    const { body } = await file(7, prHead())
    const a = db.getApproval(body.approvalId)!
    expect(applyOwnerDecision(a.id, a.owner_nonce!, 'approved', undefined, 'command')).toMatchObject({ ok: false, reason: 'button_only' })
    expect((await call('PATCH', `/api/approvals/${a.id}`, { status: 'approved', resolved_by: 'x', content_hash: body.contentHash }, MAIN)).status).toBe(403)
    expect(spawned).toEqual([])
  })

  it('the owner session on the dashboard with the shown hash: started; with another hash: 409, nothing started', async () => {
    const { body } = await file(7, prHead())
    expect((await call('PATCH', `/api/approvals/${body.approvalId}`, { status: 'approved', resolved_by: 'dashboard', content_hash: 'e'.repeat(64) }, SESSION)).status).toBe(409)
    expect(spawned).toEqual([])
    expect((await call('PATCH', `/api/approvals/${body.approvalId}`, { status: 'approved', resolved_by: 'dashboard', content_hash: body.contentHash }, SESSION)).status).toBe(200)
    await settle()
    expect(spawned).toHaveLength(1)
  })

  it('the stored spec swapped after filing (another SHA): approved, consumed, refused hash_mismatch, nothing started, alerted', async () => {
    const sha = prHead()
    const { body } = await file(7, sha)
    db.getDb().prepare('UPDATE fork_deploy_specs SET spec_json = replace(spec_json, ?, ?) WHERE approval_id = ?').run(sha, 'b'.repeat(40), body.approvalId)
    await call('PATCH', `/api/approvals/${body.approvalId}`, { status: 'approved', resolved_by: 'dashboard', content_hash: body.contentHash }, SESSION)
    await settle()
    expect(spawned).toEqual([])
    expect(specRow(body.approvalId)!.outcome).toBe('refused:hash_mismatch')
    expect(toMain.join('\n')).toContain('hash_mismatch')
  })

  it('the generic consume route cannot spend the approval', async () => {
    const { body } = await file(7, prHead())
    db.getDb().prepare("UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_by = 'x' WHERE id = ?").run(Math.floor(Date.now() / 1000), body.approvalId)
    const r = db.consumeCategoryApproval({ id: body.approvalId, category: 'fork_deploy', contentHash: body.contentHash, consumer: 'tool', windowSeconds: 600 })
    expect([r.ok, r.reason]).toEqual([false, 'wrong_category'])
  })
})

describe('5. the outcome is recorded and reported once', () => {
  async function started(): Promise<{ id: string; sha: string }> {
    const sha = prHead()
    const { body } = await file(7, sha)
    await call('PATCH', `/api/approvals/${body.approvalId}`, { status: 'approved', resolved_by: 'dashboard', content_hash: body.contentHash }, SESSION)
    await settle()
    return { id: body.approvalId, sha }
  }
  const writeStage = (id: string, v: Record<string, unknown>) => {
    mkdirSync(fd.FORK_DEPLOY_DIR, { recursive: true })
    writeFileSync(fd.stageFilePath(id), JSON.stringify({ approval_id: id, ...v }))
  }

  it('deployed: recorded, one report to the main agent and one to the owner; the script\'s exit after it adds nothing', async () => {
    const { id, sha } = await started()
    writeStage(id, { stage: 'deployed', final: true, result: 'deployed', from: FROM, to: sha, prod: sha, fork: sha, mirrors_pushed: 'brunella', mirrors_failed: '' })
    exits[0]()
    expect(specRow(id)!.outcome).toBe('deployed')
    expect(toMain).toHaveLength(1)
    expect(toOwner).toEqual(toMain)
    expect(toMain[0]).toContain('KÉSZ')
    expect(toMain[0]).toContain(sha.slice(0, 8))
    expect(fd.finalizeFromStageFile(id)).toBe(false)
    expect(toMain).toHaveLength(1)
  })

  it('rolled back after the restart: the report names the fork and the install as apart', async () => {
    const { id, sha } = await started()
    writeStage(id, { stage: 'rolled_back', final: true, result: 'rolled_back', reason: 'health_failed', from: FROM, to: sha, prod: FROM, fork: sha })
    expect(fd.finalizeFromStageFile(id)).toBe(true)
    expect(specRow(id)!.outcome).toBe('rolled_back:health_failed')
    expect(toOwner[0]).toContain('VISSZAÁLLT')
    expect(toOwner[0]).toContain('ELTÉRNEK')
    expect(toOwner[0]).toContain(FROM.slice(0, 8))
    expect(toOwner[0]).toContain(sha.slice(0, 8))
  })

  it('a failed precheck: "NEM történt élesítés", and a mirror that was not pushed is named', async () => {
    const { id } = await started()
    writeStage(id, { stage: 'failed', final: true, result: 'failed', reason: 'precheck_fork_moved', prod: FROM, fork: 'c'.repeat(40), mirrors_failed: 'brunella' })
    expect(fd.finalizeFromStageFile(id)).toBe(true)
    expect(toMain[0]).toContain('NEM történt élesítés (precheck_fork_moved)')
    expect(toMain[0]).toContain('ELTÉRNEK')
    expect(toMain[0]).toContain('brunella')
  })

  it('a stage that is not final records nothing', async () => {
    const { id } = await started()
    writeStage(id, { stage: 'restarting', final: false })
    expect(fd.finalizeFromStageFile(id)).toBe(false)
    expect(specRow(id)!.outcome).toBe('started')
    expect(toMain).toEqual([])
  })
})

describe('6. the start-up sweep and the boot stamp', () => {
  it('a started deploy with its final stage written: recorded at boot', async () => {
    const sha = prHead()
    const { body } = await file(7, sha)
    await call('PATCH', `/api/approvals/${body.approvalId}`, { status: 'approved', resolved_by: 'dashboard', content_hash: body.contentHash }, SESSION)
    mkdirSync(fd.FORK_DEPLOY_DIR, { recursive: true })
    writeFileSync(fd.stageFilePath(body.approvalId), JSON.stringify({ approval_id: body.approvalId, stage: 'deployed', final: true, result: 'deployed', prod: sha, fork: sha }))
    expect(fd.sweepForkDeployOnStart()).toEqual({ finalized: 1, watching: 0, started: 0 })
    expect(specRow(body.approvalId)!.outcome).toBe('deployed')
  })

  it('a consumed deploy without a stage file: interrupted, alerted, never re-run', async () => {
    const { body } = await file(7, prHead())
    await call('PATCH', `/api/approvals/${body.approvalId}`, { status: 'approved', resolved_by: 'dashboard', content_hash: body.contentHash }, SESSION)
    spawned.length = 0
    expect(fd.sweepForkDeployOnStart()).toEqual({ finalized: 0, watching: 0, started: 0 })
    expect(specRow(body.approvalId)!.outcome).toBe('interrupted')
    expect(toMain[0]).toContain('Nem indítom újra')
    expect(spawned).toEqual([])
  })

  it('an approved, unconsumed request inside the window is started at boot; one decided over an hour ago is not', async () => {
    const now = Math.floor(Date.now() / 1000)
    const a1 = (await file(7, prHead())).body.approvalId
    db.getDb().prepare("UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_by = 'telegram-owner' WHERE id = ?").run(now - 60, a1)
    expect(fd.sweepForkDeployOnStart(now)).toEqual({ finalized: 0, watching: 0, started: 1 })
    expect(spawned).toHaveLength(1)
    db.initDatabase(':memory:'); spawned.length = 0
    const a2 = (await file(7, prHead())).body.approvalId
    db.getDb().prepare("UPDATE approvals SET status = 'approved', resolved_at = ?, resolved_by = 'telegram-owner' WHERE id = ?").run(now - 2 * 3600, a2)
    fd.sweepForkDeployOnStart(now)
    expect(spawned).toEqual([])
    expect(String(specRow(a2)!.outcome)).toMatch(/^consume_refused:/)
  })

  it('the boot stamp carries the built commit of this dist', () => {
    const stampFile = join(h.root, 'built-commit-test')
    writeFileSync(stampFile, `${FROM}\n`)
    fd.writeForkDeployBootStamp(stampFile)
    const boot = JSON.parse(readFileSync(fd.FORK_DEPLOY_BOOT_FILE, 'utf-8'))
    expect(boot.built_commit).toBe(FROM)
    expect(boot.pid).toBe(process.pid)
    writeFileSync(stampFile, 'garbage\n')
    fd.writeForkDeployBootStamp(stampFile)
    expect(JSON.parse(readFileSync(fd.FORK_DEPLOY_BOOT_FILE, 'utf-8')).built_commit).toBe('')
    expect(existsSync(fd.FORK_DEPLOY_BOOT_FILE)).toBe(true)
  })

  it('web.ts writes the boot stamp, registers the consumer and runs the sweep, after the schedule_command ones', () => {
    const WEB = readFileSync(new URL('../web.ts', import.meta.url), 'utf-8')
    const sc = WEB.indexOf('  try { sweepScheduleCommandOnStart() }')
    const stamp = WEB.indexOf('  writeForkDeployBootStamp()\n')
    const reg = WEB.indexOf('  registerForkDeployConsumer()\n')
    const sweep = WEB.indexOf('  try { sweepForkDeployOnStart() }')
    expect(sc).toBeGreaterThan(-1)
    expect(stamp).toBeGreaterThan(sc)
    expect(reg).toBeGreaterThan(stamp)
    expect(sweep).toBeGreaterThan(reg)
  })
})

describe('7. the real start of the script: detached, without the test hooks', () => {
  it('its own process group (a kickstart of the dashboard does not reach it), and FORK_DEPLOY_* test hooks removed from its environment', async () => {
    const rec = join(h.root, 'spawn-record.txt')
    mkdirSync(join(h.root, 'scripts'), { recursive: true })
    writeFileSync(fd.FORK_DEPLOY_SCRIPT, [
      '#!/bin/bash',
      `{ echo "pid=$$"; echo "pgid=$(ps -o pgid= -p $$ | tr -d ' ')"; echo "restart=\${FORK_DEPLOY_RESTART_CMD:-unset}"; echo "health=\${FORK_DEPLOY_HEALTH_TIMEOUT_S:-unset}"; echo "args=$*"; } > "${rec}"`,
    ].join('\n'))
    process.env.FORK_DEPLOY_RESTART_CMD = 'touch /tmp/should-never-run'
    process.env.FORK_DEPLOY_HEALTH_TIMEOUT_S = '1'
    try {
      await new Promise<void>((resolve) => fd.spawnDeployScript(['x', 'y'], resolve))
    } finally {
      delete process.env.FORK_DEPLOY_RESTART_CMD
      delete process.env.FORK_DEPLOY_HEALTH_TIMEOUT_S
    }
    const r = Object.fromEntries(readFileSync(rec, 'utf-8').trim().split('\n').map((l) => l.split(/=(.*)/s).slice(0, 2)))
    expect(r.pgid).toBe(r.pid)
    expect(Number(r.pgid)).not.toBe(Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf-8' }).trim()))
    expect([r.restart, r.health, r.args]).toEqual(['unset', 'unset', 'x y'])
  })
})
