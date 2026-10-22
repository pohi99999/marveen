// Cold standby (card 3301e6cf): with store/.standby present no entry point may start the
// scheduler, a channel poller or the services; without it everything behaves as before.
// Every case is measured in both directions. The real scripts run in a throwaway copy of
// the install tree with tmux / systemctl / launchctl stubs that record every call, so
// nothing on this host is touched.
import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backgroundServicesOff, isStandby, standbyFile, STANDBY_NOTICE } from '../standby.js'

const ROOT = join(__dirname, '..', '..')
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function sandbox(standby: boolean): { root: string; calls: string; bin: string } {
  const root = mkdtempSync(join(tmpdir(), 'marveen-standby-'))
  dirs.push(root)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'store'), { recursive: true })
  for (const f of ['channels.sh', 'start.sh']) copyFileSync(join(ROOT, 'scripts', f), join(root, 'scripts', f))
  if (standby) writeFileSync(join(root, 'store', '.standby'), '')
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const calls = join(root, 'calls.log')
  for (const tool of ['tmux', 'systemctl', 'launchctl', 'claude', 'pidof']) {
    writeFileSync(join(bin, tool), `#!/bin/bash\necho "${tool} $*" >> "${calls}"\nexit 0\n`)
    chmodSync(join(bin, tool), 0o755)
  }
  return { root, calls, bin }
}
const recorded = (calls: string) => (existsSync(calls) ? readFileSync(calls, 'utf-8').trim().split('\n').filter(Boolean) : [])

describe('src/standby.ts: the dashboard decision', () => {
  it('no marker and no WEB_ONLY: background services run (the live WSL host is unchanged)', () => {
    const store = mkdtempSync(join(tmpdir(), 'standby-store-')); dirs.push(store)
    expect(isStandby(store)).toBe(false)
    expect(backgroundServicesOff({}, store)).toEqual({ off: false, reason: null })
  })
  it('the marker turns them off, and says it is the standby', () => {
    const store = mkdtempSync(join(tmpdir(), 'standby-store-')); dirs.push(store)
    writeFileSync(standbyFile(store), '')
    expect(isStandby(store)).toBe(true)
    expect(backgroundServicesOff({}, store)).toEqual({ off: true, reason: 'standby' })
    expect(STANDBY_NOTICE).toContain('[standby]')
  })
  it('WEB_ONLY=true still works on its own', () => {
    const store = mkdtempSync(join(tmpdir(), 'standby-store-')); dirs.push(store)
    expect(backgroundServicesOff({ WEB_ONLY: 'true' }, store)).toEqual({ off: true, reason: 'web-only' })
  })
})

describe('scripts/channels.sh and scripts/start.sh in cold standby', () => {
  it('channels.sh exits 0 before it touches tmux or claude (no second Telegram poller)', () => {
    const s = sandbox(true)
    const r = spawnSync('bash', [join(s.root, 'scripts', 'channels.sh')], { encoding: 'utf-8', timeout: 20_000, env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}`, MARVEEN_STANDBY_EXIT_DELAY: '0' } })
    expect(r.status).toBe(0)
    expect(r.stderr).toContain('[standby]')
    expect(recorded(s.calls)).toEqual([])
  })
  it('start.sh refuses to start the services (exit 1) and calls no service manager', () => {
    const s = sandbox(true)
    const r = spawnSync('bash', [join(s.root, 'scripts', 'start.sh')], { encoding: 'utf-8', timeout: 20_000, env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}` } })
    expect(r.status).toBe(1)
    expect(r.stderr).toMatch(/^\[standby\] .*store\/\.standby is present: .*the dashboard and channels services are NOT started/)
    expect(recorded(s.calls)).toEqual([])
  })
  it('without the marker start.sh goes on to the service manager, as before', () => {
    const s = sandbox(false)
    const r = spawnSync('bash', [join(s.root, 'scripts', 'start.sh')], { encoding: 'utf-8', timeout: 20_000, env: { ...process.env, PATH: `${s.bin}:${process.env.PATH}` } })
    expect(r.stderr).not.toContain('[standby]')
    expect(recorded(s.calls).some((c) => /^(systemctl|launchctl) /.test(c)), recorded(s.calls).join(' | ')).toBe(true)
  })
})

// The installer's real launchagent step, run in a sandbox HOME with a stubbed service starter.
const MACOS = readFileSync(join(ROOT, 'install-macos.sh'), 'utf-8')
function sliceFn(name: string): string {
  const start = MACOS.indexOf(`${name}() {`); let i = MACOS.indexOf('{', start) + 1; let depth = 1
  while (depth > 0 && i < MACOS.length) { if (MACOS[i] === '{') depth++; else if (MACOS[i] === '}') depth--; i++ }
  return MACOS.slice(start, i)
}
function runLaunchagentStep(standby: boolean): { out: string; code: number; home: string; root: string; starts: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'marveen-standby-inst-')); dirs.push(root)
  const home = join(root, 'home'); mkdirSync(home)
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'store'))
  const starts = join(root, 'starts.log')
  writeFileSync(join(root, 'scripts', 'launchd-unit.sh'), `start_launchd_unit() { echo "$1" >> "${starts}"; echo 4242; }\n`)
  const node = join(root, 'node22'); writeFileSync(node, '#!/bin/bash\necho v22\n'); chmodSync(node, 0o755)
  const block = MACOS.slice(MACOS.indexOf('INSTALL_STEP="launchagent"'), MACOS.indexOf('# ISSUE1891 (#1891)'))
  const script = [
    'set -e', 'GREEN=""; ORANGE=""; RED=""; NC=""; DIM=""; BOLD=""; BLUE=""', '_t() { echo "$1"; }', 'warn() { echo "warn: $*"; }',
    `INSTALL_DIR="${root}"`, `HOME="${home}"`, 'SERVICE_ID="marveen"', 'MAIN_AGENT_ID="marveen"', `STANDBY="${standby ? 1 : 0}"`,
    `SERVICE_NODE_PATH="${node}"`, 'resolve_service_node() { NODE_BIN_DIR="$(dirname "$SERVICE_NODE_PATH")"; }',
    block, 'echo REACHED_THE_SERVICE_START_SECTION_END',
  ].join('\n')
  const file = join(root, 'step.sh'); writeFileSync(file, script)
  let out = '', code = 0
  try { out = execFileSync('/bin/bash', [file], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }) }
  catch (e: unknown) { const err = e as { status?: number; stdout?: string; stderr?: string }; code = err.status ?? -1; out = `${err.stdout ?? ''}${err.stderr ?? ''}` }
  return { out, code, home, root, starts: existsSync(starts) ? readFileSync(starts, 'utf-8').trim().split('\n').filter(Boolean) : [] }
}
const plist = (home: string, name: string) => readFileSync(join(home, 'Library', 'LaunchAgents', `com.marveen.${name}.plist`), 'utf-8')
const autostart = (xml: string) => [...xml.matchAll(/<key>(RunAtLoad|KeepAlive)<\/key>\s*<(true|false)\/>/g)].map((m) => `${m[1]}=${m[2]}`)

describe('install-macos.sh launchagent step', () => {
  it('a normal install still writes autostarting units and starts both services', () => {
    expect(sliceFn('resolve_service_node')).not.toBe('')
    const r = runLaunchagentStep(false)
    expect(r.code, r.out).toBe(0)
    for (const n of ['dashboard', 'channels']) expect(autostart(plist(r.home, n))).toEqual(['RunAtLoad=true', 'KeepAlive=true'])
    expect(r.starts).toEqual(['com.marveen.dashboard', 'com.marveen.channels'])
    expect(existsSync(join(r.root, 'store', '.standby'))).toBe(false)
  })
  it('--standby writes the units switched off, creates store/.standby and starts nothing', () => {
    const r = runLaunchagentStep(true)
    expect(r.code, r.out).toBe(0)
    for (const n of ['dashboard', 'channels']) expect(autostart(plist(r.home, n))).toEqual(['RunAtLoad=false', 'KeepAlive=false'])
    expect(r.starts).toEqual([])
    expect(existsSync(join(r.root, 'store', '.standby'))).toBe(true)
    expect(r.out).toContain('STANDBY')
    expect(r.out).not.toContain('REACHED_THE_SERVICE_START_SECTION_END')
  })
  it('the flag is parsed and documented', () => {
    expect(MACOS).toContain('--standby)')
    const help = spawnSync('bash', [join(ROOT, 'install-macos.sh'), '--help'], { encoding: 'utf-8' })
    expect(help.stdout).toContain('--standby')
  })
})
