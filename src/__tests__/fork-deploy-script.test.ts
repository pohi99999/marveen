// FORKDEPLOY1121: scripts/fork-deploy.sh, run for real against a sandbox: an "install" clone with two remotes (fork,
// brunella) that are local bare repositories, a package.json whose build stamps dist/.built-commit (and fails when the
// tree holds a FAIL file), a tiny HTTP server for the health check, and a fake restart command that writes the boot
// stamp a new dashboard would write. Both directions:
//   - the approved SHA goes live: fork main, brunella main and the install all on TO, result "deployed";
//   - a moved fork main, a moved install, a moved mirror, a two-commit head: nothing moves anywhere, result "failed";
//   - a failing build: the install goes back to FROM, nothing pushed;
//   - a new dashboard that does not come up: the install goes back to FROM and is restarted, the fork stays on TO, and
//     the stage file says both (result "rolled_back").
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, copyFileSync, chmodSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import http from 'node:http'
import type { AddressInfo } from 'node:net'

const SCRIPT = join(__dirname, '..', '..', 'scripts', 'fork-deploy.sh')
const HOOK_PROOF = join(__dirname, '..', '..', 'scripts', 'hook-proof.mjs')
const ID = '11111111-2222-3333-4444-555555555555'
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' }

let base = ''
let server: http.Server
let port = 0

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf-8' }).trim()
}

interface Sandbox { install: string; fork: string; brunella: string; work: string; from: string }

function makeSandbox(): Sandbox {
  const root = mkdtempSync(join(base, 'sb-'))
  const fork = join(root, 'fork.git')
  const brunella = join(root, 'brunella.git')
  const work = join(root, 'work')
  const install = join(root, 'install')
  git(root, 'init', '-q', '--bare', '-b', 'main', fork)
  git(root, 'init', '-q', '--bare', '-b', 'main', brunella)
  // GitHub serves any reachable SHA; a local bare repo needs this to fetch the PR head by SHA.
  git(fork, 'config', 'uploadpack.allowAnySHA1InWant', 'true')
  git(root, 'init', '-q', '-b', 'main', work)
  writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'sb', version: '1.0.0', scripts: { build: 'node build.cjs' } }))
  writeFileSync(join(work, 'build.cjs'), [
    "const { execFileSync } = require('node:child_process')",
    "const fs = require('node:fs')",
    "if (fs.existsSync('FAIL')) { console.error('build failed on purpose'); process.exit(1) }",
    "fs.mkdirSync('dist', { recursive: true })",
    "const head = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim()",
    "fs.writeFileSync('dist/.built-commit', (fs.existsSync('STAMPBAD') ? 'f'.repeat(40) : head) + '\\n')",
  ].join('\n'))
  writeFileSync(join(work, '.gitignore'), 'dist/\nstore/\n')
  writeFileSync(join(work, 'app.txt'), 'v1\n')
  // a valid lockfile at FROM (no dependencies), so the rollback's npm ci passes where the new one fails
  writeFileSync(join(work, 'package-lock.json'), JSON.stringify({ name: 'sb', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'sb', version: '1.0.0' } } }, null, 2) + '\n')
  git(work, 'add', '-A')
  git(work, 'commit', '-q', '-m', 'base')
  git(work, 'remote', 'add', 'fork', fork)
  git(work, 'remote', 'add', 'brunella', brunella)
  git(work, 'push', '-q', 'fork', 'main')
  git(work, 'push', '-q', 'brunella', 'main')
  git(root, 'clone', '-q', '-o', 'fork', fork, install)
  git(install, 'remote', 'add', 'brunella', brunella)
  mkdirSync(join(install, 'scripts'), { recursive: true })
  copyFileSync(SCRIPT, join(install, 'scripts', 'fork-deploy.sh'))
  chmodSync(join(install, 'scripts', 'fork-deploy.sh'), 0o755)
  writeFileSync(join(install, 'scripts', '.gitignore'), '*\n')
  // the install's real hook-proof pre-push gate (Ellenőr 8634 H1): the PR head was committed in ANOTHER clone (work),
  // so this install has no pre-commit proof for it; the push must still go, because the commit is already on the fork
  copyFileSync(HOOK_PROOF, join(install, 'scripts', 'hook-proof.mjs'))
  writeFileSync(join(install, '.git', 'hooks', 'pre-push'), '#!/usr/bin/env bash\nset -euo pipefail\nexec node "$(git rev-parse --show-toplevel)/scripts/hook-proof.mjs" pre-push "$@"\n')
  chmodSync(join(install, '.git', 'hooks', 'pre-push'), 0o755)
  mkdirSync(join(install, 'store'), { recursive: true })
  execFileSync('python3', ['-I', '-c', 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("create table t(x)"); c.commit(); c.close()', join(install, 'store', 'claudeclaw.db')])
  execFileSync('npm', ['run', '-s', 'build'], { cwd: install, env: GIT_ENV })
  return { install, fork, brunella, work, from: git(install, 'rev-parse', 'HEAD') }
}

/** One commit on top of main, pushed as the PR head (refs/pull/7/head). */
function prCommit(sb: Sandbox, file = 'app.txt', content = 'v2\n'): string {
  writeFileSync(join(sb.work, file), content)
  git(sb.work, 'add', '-A')
  git(sb.work, 'commit', '-q', '-m', `change ${file}`)
  const sha = git(sb.work, 'rev-parse', 'HEAD')
  git(sb.work, 'push', '-q', '--force', 'fork', `${sha}:refs/pull/7/head`)
  git(sb.work, 'reset', '-q', '--hard', 'HEAD~1')
  return sha
}

/** The fake restart: writes the boot stamp a new dashboard writes; failBoots=n makes the first n boots come up with a
 *  wrong built commit, staleBoot writes a start time from long before the restart. */
function restartCmd(sb: Sandbox, failBoots = 0, staleBoot = false): string {
  const f = join(sb.install, 'restart.sh')
  writeFileSync(f, [
    '#!/bin/bash',
    `C="${sb.install}/restart-count"`,
    'n=$(( $(cat "$C" 2>/dev/null || echo 0) + 1 )); echo "$n" > "$C"',
    `built=$(cat "${sb.install}/dist/.built-commit")`,
    `if [ "$n" -le ${failBoots} ]; then built=0000000000000000000000000000000000000000; fi`,
    staleBoot ? 'started=1000' : 'started=$(date +%s)',
    `printf '{"pid":1,"built_commit":"%s","started_at":%s}\\n' "$built" "$started" > "${sb.install}/store/fork-deploy/boot.json"`,
  ].join('\n'))
  chmodSync(f, 0o755)
  return f
}

interface RunOpts { failBoots?: number; staleBoot?: boolean; lock?: string; mirrors?: string; port?: number; pr?: string }

/** Async on purpose: the health check calls this process's own HTTP server, which a spawnSync would block. */
async function runDeploy(sb: Sandbox, to: string, opts: RunOpts = {}): Promise<{ code: number; stage: Record<string, unknown> }> {
  const child = spawn('/bin/bash', [join(sb.install, 'scripts', 'fork-deploy.sh'), ID, sb.from, to, 'fork', opts.mirrors ?? 'brunella', 'main', 'com.test.dashboard', String(opts.port ?? port), opts.lock ?? '0', opts.pr ?? '7'], {
    cwd: sb.install,
    env: { ...GIT_ENV, FORK_DEPLOY_RESTART_CMD: restartCmd(sb, opts.failBoots ?? 0, opts.staleBoot ?? false), FORK_DEPLOY_HEALTH_TIMEOUT_S: '4' },
    stdio: 'ignore',
  })
  const code = await new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? -1)))
  const stageFile = join(sb.install, 'store', 'fork-deploy', `${ID}.json`)
  const stage = existsSync(stageFile) ? JSON.parse(readFileSync(stageFile, 'utf-8')) as Record<string, unknown> : {}
  return { code, stage }
}

const remoteMain = (bare: string): string => git(bare, 'rev-parse', 'refs/heads/main')

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'fork-deploy-sh-'))
  server = http.createServer((_req, res) => { res.writeHead(200); res.end('ok') })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
  port = (server.address() as AddressInfo).port
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  rmSync(base, { recursive: true, force: true })
})

describe('fork-deploy.sh', () => {
  let sb: Sandbox
  beforeEach(() => { sb = makeSandbox() })

  it('the approved SHA goes live: install, fork and mirror all on TO, the build stamped TO, a DB backup made', async () => {
    const to = prCommit(sb)
    const r = await runDeploy(sb, to)
    expect(r.stage).toMatchObject({ final: true, result: 'deployed', prod: to, fork: to, mirrors_pushed: 'brunella', mirrors_failed: '' })
    expect(git(sb.install, 'rev-parse', 'HEAD')).toBe(to)
    expect(remoteMain(sb.fork)).toBe(to)
    expect(remoteMain(sb.brunella)).toBe(to)
    expect(readFileSync(join(sb.install, 'dist', '.built-commit'), 'utf-8').trim()).toBe(to)
    expect(readFileSync(join(sb.install, 'restart-count'), 'utf-8').trim()).toBe('1')
    expect(readFileSync(join(sb.install, 'store', 'dashboard.log'), 'utf-8')).toMatch(/--- RESTART .* fork-deploy .* \(deploy\) ---/)
    const backups = execFileSync('ls', [join(sb.install, 'store', 'backups')], { encoding: 'utf-8' }).trim().split('\n')
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(new RegExp(`^fork-deploy-${sb.from.slice(0, 8)}-`))
  }, 60_000)

  it('a fork main that moved after the request: nothing moves, nothing restarts', async () => {
    const to = prCommit(sb)
    writeFileSync(join(sb.work, 'other.txt'), 'x\n'); git(sb.work, 'add', '-A'); git(sb.work, 'commit', '-q', '-m', 'other'); git(sb.work, 'push', '-q', 'fork', 'main')
    const moved = remoteMain(sb.fork)
    const r = await runDeploy(sb, to)
    expect(r.stage).toMatchObject({ final: true, result: 'failed', reason: 'precheck_fork_moved', prod: sb.from })
    expect(git(sb.install, 'rev-parse', 'HEAD')).toBe(sb.from)
    expect(remoteMain(sb.fork)).toBe(moved)
    expect(remoteMain(sb.brunella)).toBe(sb.from)
    expect(existsSync(join(sb.install, 'restart-count'))).toBe(false)
  }, 60_000)

  it('an install that moved after the request: nothing moves', async () => {
    const to = prCommit(sb)
    writeFileSync(join(sb.install, 'app.txt'), 'local\n'); git(sb.install, 'commit', '-q', '-am', 'local')
    const r = await runDeploy(sb, to)
    expect(r.stage).toMatchObject({ final: true, result: 'failed', reason: 'precheck_install_moved' })
    expect(remoteMain(sb.fork)).toBe(sb.from)
    expect(existsSync(join(sb.install, 'restart-count'))).toBe(false)
  }, 60_000)

  it('a mirror that moved: nothing moves', async () => {
    const to = prCommit(sb)
    writeFileSync(join(sb.work, 'm.txt'), 'm\n'); git(sb.work, 'add', '-A'); git(sb.work, 'commit', '-q', '-m', 'mirror only'); git(sb.work, 'push', '-q', 'brunella', 'main')
    const r = await runDeploy(sb, to)
    expect(r.stage).toMatchObject({ final: true, result: 'failed', reason: 'precheck_mirror_moved' })
    expect(remoteMain(sb.fork)).toBe(sb.from)
    expect(git(sb.install, 'rev-parse', 'HEAD')).toBe(sb.from)
  }, 60_000)

  it('a head that is two commits on top of main: refused, nothing moves', async () => {
    writeFileSync(join(sb.work, 'a.txt'), 'a\n'); git(sb.work, 'add', '-A'); git(sb.work, 'commit', '-q', '-m', 'a')
    writeFileSync(join(sb.work, 'b.txt'), 'b\n'); git(sb.work, 'add', '-A'); git(sb.work, 'commit', '-q', '-m', 'b')
    const to = git(sb.work, 'rev-parse', 'HEAD')
    git(sb.work, 'push', '-q', 'fork', `${to}:refs/pull/7/head`)
    const r = await runDeploy(sb, to)
    expect(r.stage).toMatchObject({ final: true, result: 'failed', reason: 'precheck_not_one_commit' })
    expect(remoteMain(sb.fork)).toBe(sb.from)
    expect(git(sb.install, 'rev-parse', 'HEAD')).toBe(sb.from)
  }, 60_000)

  it('a build that fails: the install goes back to FROM and is rebuilt, nothing pushed, nothing restarted', async () => {
    const to = prCommit(sb, 'FAIL', 'x\n')
    const r = await runDeploy(sb, to)
    expect(r.stage).toMatchObject({ final: true, result: 'failed', reason: 'build_failed', prod: sb.from, fork: sb.from })
    expect(git(sb.install, 'rev-parse', 'HEAD')).toBe(sb.from)
    expect(readFileSync(join(sb.install, 'dist', '.built-commit'), 'utf-8').trim()).toBe(sb.from)
    expect(remoteMain(sb.fork)).toBe(sb.from)
    expect(remoteMain(sb.brunella)).toBe(sb.from)
    expect(existsSync(join(sb.install, 'restart-count'))).toBe(false)
  }, 60_000)

  it('a new dashboard that does not come up: back to FROM and restarted again; the fork stays on TO and the stage says so', async () => {
    const to = prCommit(sb)
    const r = await runDeploy(sb, to, { failBoots: 1 })
    expect(r.stage).toMatchObject({ final: true, result: 'rolled_back', reason: 'health_failed', prod: sb.from, fork: to })
    expect(git(sb.install, 'rev-parse', 'HEAD')).toBe(sb.from)
    expect(readFileSync(join(sb.install, 'dist', '.built-commit'), 'utf-8').trim()).toBe(sb.from)
    expect(remoteMain(sb.fork)).toBe(to)
    expect(readFileSync(join(sb.install, 'restart-count'), 'utf-8').trim()).toBe('2')
  }, 60_000)

  it('the PR head moved after the request (a force-push): the approved SHA does NOT go, nothing moves', async () => {
    const approved = prCommit(sb)
    prCommit(sb, 'app.txt', 'v3\n')
    const r = await runDeploy(sb, approved)
    expect(r.stage).toMatchObject({ final: true, result: 'failed', reason: 'precheck_pr_head_moved', prod: sb.from, fork: sb.from })
    expect(git(sb.install, 'rev-parse', 'HEAD')).toBe(sb.from)
    expect(existsSync(join(sb.install, 'restart-count'))).toBe(false)
  }, 60_000)

  it('the PR head goes through the install\'s hook-proof gate though it was committed elsewhere; the PR ref is gone after', async () => {
    const to = prCommit(sb)
    // the gate is armed: a commit made in the install without a proof is blocked by it
    writeFileSync(join(sb.install, 'local.txt'), 'l\n'); git(sb.install, 'add', '-A'); git(sb.install, 'commit', '-q', '--no-verify', '-m', 'no proof')
    const blocked = spawnSync('git', ['push', 'fork', 'HEAD:refs/heads/probe'], { cwd: sb.install, env: GIT_ENV, encoding: 'utf-8' })
    expect(blocked.status).not.toBe(0)
    expect(blocked.stderr).toContain('without pre-commit proof')
    git(sb.install, 'reset', '-q', '--hard', sb.from)
    const r = await runDeploy(sb, to)
    expect(r.stage).toMatchObject({ final: true, result: 'deployed', fork: to })
    expect(git(sb.install, 'for-each-ref', 'refs/remotes/fork/pr/')).toBe('')
  }, 60_000)

  it('the install not on the branch, or with a changed tracked file: nothing moves', async () => {
    const to = prCommit(sb)
    git(sb.install, 'checkout', '-q', '-b', 'other')
    expect((await runDeploy(sb, to)).stage).toMatchObject({ result: 'failed', reason: 'precheck_not_on_branch' })
    git(sb.install, 'checkout', '-q', 'main')
    writeFileSync(join(sb.install, 'app.txt'), 'dirty\n')
    expect((await runDeploy(sb, to)).stage).toMatchObject({ result: 'failed', reason: 'precheck_install_dirty' })
    expect(remoteMain(sb.fork)).toBe(sb.from)
    expect(git(sb.install, 'rev-parse', 'HEAD')).toBe(sb.from)
  }, 60_000)

  it('the fork refuses the push: the install goes back to FROM, nothing restarted, no mirror pushed', async () => {
    const to = prCommit(sb)
    writeFileSync(join(sb.fork, 'hooks', 'pre-receive'), '#!/bin/sh\nwhile read o n r; do [ "$r" = refs/heads/main ] && exit 1; done\nexit 0\n')
    chmodSync(join(sb.fork, 'hooks', 'pre-receive'), 0o755)
    const r = await runDeploy(sb, to)
    expect(r.stage).toMatchObject({ final: true, result: 'failed', reason: 'push_failed', prod: sb.from, fork: sb.from })
    expect(remoteMain(sb.brunella)).toBe(sb.from)
    expect(readFileSync(join(sb.install, 'dist', '.built-commit'), 'utf-8').trim()).toBe(sb.from)
    expect(existsSync(join(sb.install, 'restart-count'))).toBe(false)
  }, 60_000)

  it('npm ci failing on the new lockfile: back to FROM (its own npm ci passes), nothing pushed', async () => {
    const to = prCommit(sb, 'package-lock.json', '{ not json')
    const r = await runDeploy(sb, to, { lock: '1' })
    expect(r.stage).toMatchObject({ final: true, result: 'failed', reason: 'npm_ci_failed', prod: sb.from, fork: sb.from })
    expect(existsSync(join(sb.install, 'restart-count'))).toBe(false)
  }, 60_000)

  it('a build whose stamp is not the new SHA: back to FROM, nothing pushed', async () => {
    const to = prCommit(sb, 'STAMPBAD', 'x\n')
    const r = await runDeploy(sb, to)
    expect(r.stage).toMatchObject({ final: true, result: 'failed', reason: 'build_stamp_mismatch', prod: sb.from, fork: sb.from })
  }, 60_000)

  it.each([
    ['missing', (db: string) => rmSync(db)],
    ['not a database', (db: string) => writeFileSync(db, 'garbage, not sqlite '.repeat(50))],
  ])('the database %s: no backup, back to FROM, nothing pushed', async (_l, spoil) => {
    const to = prCommit(sb)
    spoil(join(sb.install, 'store', 'claudeclaw.db'))
    const r = await runDeploy(sb, to)
    expect(r.stage).toMatchObject({ final: true, result: 'failed', reason: 'backup_failed', prod: sb.from, fork: sb.from })
  }, 60_000)

  it('only the last three of the script\'s own backups are kept', async () => {
    const dir = join(sb.install, 'store', 'backups')
    mkdirSync(dir, { recursive: true })
    for (let i = 1; i <= 4; i++) {
      const f = join(dir, `fork-deploy-old${i}.db`)
      writeFileSync(f, 'x')
      utimesSync(f, new Date(Date.now() - (10 - i) * 60_000), new Date(Date.now() - (10 - i) * 60_000))
    }
    writeFileSync(join(dir, 'other.db'), 'kept, not ours')
    const r = await runDeploy(sb, prCommit(sb))
    expect(r.stage).toMatchObject({ result: 'deployed' })
    const left = execFileSync('ls', [dir], { encoding: 'utf-8' }).trim().split('\n').sort()
    expect(left).toHaveLength(4)
    expect(left).toContain('other.db')
    expect(left).toContain('fork-deploy-old4.db')
    expect(left).toContain('fork-deploy-old3.db')
    expect(left.filter((n) => n.startsWith(`fork-deploy-${sb.from.slice(0, 8)}-`))).toHaveLength(1)
  }, 60_000)

  it.each([
    ['a boot stamp from before the restart', { staleBoot: true }],
    ['a port that does not answer', { port: 1 }],
  ])('%s is not a healthy new dashboard: not deployed; the fork on TO, the install back on FROM', async (_l, opts) => {
    const to = prCommit(sb)
    const r = await runDeploy(sb, to, opts)
    expect(r.stage.result).not.toBe('deployed')
    expect(r.stage).toMatchObject({ final: true, prod: sb.from, fork: to })
    expect(git(sb.install, 'rev-parse', 'HEAD')).toBe(sb.from)
  }, 60_000)

  it('refuses malformed arguments before touching anything', () => {
    for (const args of [
      [ID, sb.from, 'not-a-sha', 'fork', 'brunella', 'main', 'l', '1', '0', '7'],
      [ID, sb.from, 'a'.repeat(40), 'fork', 'brunella', 'main', 'l', '1', '0', '7;x'],
      [ID, sb.from, 'a'.repeat(40), 'fork', 'brunella', 'main', 'l', '1', '0'],
    ]) {
      const r = spawnSync('/bin/bash', [join(sb.install, 'scripts', 'fork-deploy.sh'), ...args], { encoding: 'utf-8' })
      expect(r.status).toBe(2)
    }
    expect(existsSync(join(sb.install, 'store', 'fork-deploy'))).toBe(false)
  })
})
