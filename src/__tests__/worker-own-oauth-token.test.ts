import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  applyWorkerCredentials,
  decideWorkerAuth,
  workerOauthTokenEnv,
  WORKER_OAUTH_TOKEN_PATH,
  type WorkerAuthDecision,
} from '../web/agent-worker.js'

// WORKERTOKEN1026: the worker copied the host login (refresh token included),
// so the worker and the main channels session raced on one rotating refresh
// token and the main session lost (10-25 06:40 and 23:13, "Login expired").
// With store/agent-tokens/worker.oauth-token the worker uses its own
// setup-token and the host login is never copied. Without it: unchanged.

const TOKEN = 'sk-ant-oat01-' + 'a'.repeat(40)
const HOST_LOGIN = '{"claudeAiOauth":{"accessToken":"host-access","refreshToken":"host-refresh"}}'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'worker-token-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function tokenFile(content: string, mode = 0o600): string {
  const p = join(dir, 'worker.oauth-token')
  writeFileSync(p, content)
  chmodSync(p, mode)
  return p
}
const uid = process.getuid!()
const noFleet = () => join(dir, 'no-fleet-token')

describe('decideWorkerAuth', () => {
  it('lives at store/agent-tokens/worker.oauth-token', () => {
    expect(WORKER_OAUTH_TOKEN_PATH.endsWith('/store/agent-tokens/worker.oauth-token')).toBe(true)
  })

  it('no token file -> host-login, nothing refused (the previous behaviour)', () => {
    expect(decideWorkerAuth({ tokenPath: join(dir, 'absent'), fleetTokenPath: noFleet(), uid })).toEqual({ kind: 'host-login' })
  })

  it('a valid 0600 setup-token -> worker-token with a fingerprint, never the value', () => {
    const p = tokenFile(TOKEN + '\n')
    const auth = decideWorkerAuth({ tokenPath: p, fleetTokenPath: noFleet(), uid })
    expect(auth.kind).toBe('worker-token')
    expect(auth).toMatchObject({ path: p })
    expect(JSON.stringify(auth)).not.toContain(TOKEN)
  })

  it.each([
    ['mode-too-open', () => tokenFile(TOKEN, 0o644)],
    ['bad-prefix', () => tokenFile('not-a-setup-token')],
    ['empty', () => tokenFile('')],
  ])('an unusable file (%s) -> host-login with the refusal reason', (reason, make) => {
    const auth = decideWorkerAuth({ tokenPath: make(), fleetTokenPath: noFleet(), uid })
    expect(auth.kind).toBe('host-login')
    expect(auth).toMatchObject({ refused: { reason } })
  })

  it('a copy of the fleet token is refused (it would share the fleet credential)', () => {
    const fleet = join(dir, 'fleet')
    writeFileSync(fleet, TOKEN)
    const auth = decideWorkerAuth({ tokenPath: tokenFile(TOKEN), fleetTokenPath: fleet, uid })
    expect(auth).toMatchObject({ kind: 'host-login', refused: { reason: 'same-as-fleet-token' } })
  })
})

describe('workerOauthTokenEnv', () => {
  const own: WorkerAuthDecision = { kind: 'worker-token', path: '/s/agent-tokens/worker.oauth-token', fingerprint: 'abcd1234' }
  const host: WorkerAuthDecision = { kind: 'host-login' }

  it('worker token -> exported by $(cat), the path quoted, no value in the line', () => {
    expect(workerOauthTokenEnv(own, false)).toBe(`export CLAUDE_CODE_OAUTH_TOKEN="$(cat '/s/agent-tokens/worker.oauth-token')"; `)
  })

  it('the worker token wins over a present fleet token', () => {
    expect(workerOauthTokenEnv(own, true, '/s/.claude-oauth-token')).toContain('worker.oauth-token')
    expect(workerOauthTokenEnv(own, true, '/s/.claude-oauth-token')).not.toContain('.claude-oauth-token')
  })

  it('no worker token -> exactly the previous clause (fleet token or nothing)', () => {
    expect(workerOauthTokenEnv(host, true, '/s/.claude-oauth-token')).toBe(`export CLAUDE_CODE_OAUTH_TOKEN="$(cat '/s/.claude-oauth-token')"; `)
    expect(workerOauthTokenEnv(host, false)).toBe('')
  })
})

describe('applyWorkerCredentials (both directions)', () => {
  function deps(platform: NodeJS.Platform) {
    const calls = { clear: 0, read: 0 }
    return {
      calls,
      deps: {
        platform,
        clearKeychain: () => { calls.clear++ },
        readHostLogin: () => { calls.read++; return HOST_LOGIN },
      },
    }
  }
  const credPath = () => join(dir, '.credentials.json')

  it('worker token: the host login is NOT read, and an earlier seeded copy is removed', () => {
    writeFileSync(credPath(), HOST_LOGIN)
    const { calls, deps: d } = deps('darwin')
    const r = applyWorkerCredentials(dir, { kind: 'worker-token', path: '/x', fingerprint: 'f' }, d)
    expect(r).toBe('token')
    expect(calls.read).toBe(0)
    expect(existsSync(credPath())).toBe(false)
    expect(calls.clear).toBe(1)
  })

  it('worker token with no earlier copy: nothing is written', () => {
    const { deps: d } = deps('darwin')
    expect(applyWorkerCredentials(dir, { kind: 'worker-token', path: '/x', fingerprint: 'f' }, d)).toBe('token')
    expect(existsSync(credPath())).toBe(false)
  })

  it('no worker token: the host login is copied as before (0600), Keychain entry cleared on darwin', () => {
    const { calls, deps: d } = deps('darwin')
    expect(applyWorkerCredentials(dir, { kind: 'host-login' }, d)).toBe('seeded')
    expect(readFileSync(credPath(), 'utf-8')).toBe(HOST_LOGIN)
    expect(statSync(credPath()).mode & 0o777).toBe(0o600)
    expect(calls).toEqual({ clear: 1, read: 1 })
  })

  it('a refused token file behaves like no token file (host login copied)', () => {
    const { deps: d } = deps('darwin')
    const r = applyWorkerCredentials(dir, { kind: 'host-login', refused: { path: '/x', reason: 'mode-too-open', detail: '' } }, d)
    expect(r).toBe('seeded')
  })

  it('off darwin the Keychain is not touched; no host login -> none', () => {
    const { calls, deps: d } = deps('linux')
    d.readHostLogin = () => { calls.read++; return null }
    expect(applyWorkerCredentials(dir, { kind: 'host-login' }, d)).toBe('none')
    expect(calls.clear).toBe(0)
    expect(existsSync(credPath())).toBe(false)
  })
})

// House idiom: the pure pieces cannot prove the launch path uses them.
describe('wiring (WORKERTOKEN1026)', () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../web/agent-worker.ts'), 'utf-8')
  const body = (fn: string) => {
    const start = src.indexOf(`function ${fn}(`)
    expect(start, `${fn} not found`).toBeGreaterThan(-1)
    return src.slice(start, src.indexOf('\n}\n', start))
  }

  it('one decision per launch feeds both the credential files and the launch env', () => {
    const fn = body('startWorkerSessionFor')
    expect(fn).toMatch(/const auth = resolveWorkerAuth\(ctx\)\n\s+ensureWorkerCwd\(ctx, auth\)/)
    expect(fn).toContain('workerOauthTokenEnv(auth, hasFleetOauthToken())')
    expect(fn).not.toMatch(/hasFleetOauthToken\(\) \? `export CLAUDE_CODE_OAUTH_TOKEN/)
  })

  it('ensureWorkerCwd seeds with that decision and skips the shared-creds symlink under the worker token', () => {
    const fn = body('ensureWorkerCwd')
    expect(fn).toContain('seedWorkerCredentials(ctx, auth)')
    expect(fn).toContain("hasFleetOauthToken() || auth.kind === 'worker-token'")
  })
})
