import { describe, it, expect, afterAll, vi } from 'vitest'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The token test needs a .dashboard-token, and it must NOT be the checkout's own
// store/.dashboard-token: assert-not-live-install refuses to run any suite while
// that file exists, so writing it there knocked out suites starting in parallel.
// A private temp STORE_DIR keeps the checkout untouched.
const tmpStore = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join: j } = require('node:path') as typeof import('node:path')
  return mkdtempSync(j(tmpdir(), 'security-audit-store-'))
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, STORE_DIR: tmpStore }
})
import { agentDir, AGENTS_BASE_DIR } from '../web/agent-config.js'
import { isAllowedInboundSender } from '../channel-coordinator.js'
import { buildTtsDirective } from '../web/voice-directive.js'
import { STORE_DIR } from '../config.js'

// Regression pins for the High findings fixed in SECURITY_AUDIT.md.

describe('agentDir: an agent name is one path segment', () => {
  it('refuses names that resolve to the agents base dir or a sibling', () => {
    for (const bad of ['x/..', 'x/../bob', '..', '.', '', 'a\\b', 'a\0b', '$(id)/../bob']) {
      expect(() => agentDir(bad), JSON.stringify(bad)).toThrow()
    }
  })
  it('still resolves an ordinary name under the base dir', () => {
    expect(agentDir('bob')).toBe(join(AGENTS_BASE_DIR, 'bob'))
  })
})

describe('channel-coordinator backfill applies the Telegram allowlist', () => {
  const access = JSON.stringify({ allowFrom: ['111'], groups: { '-100': { allowFrom: [] }, '-200': { allowFrom: ['111'] } } })
  const read = () => access
  it('admits an allowlisted DM and allowed groups', () => {
    expect(isAllowedInboundSender({ chat_id: 111, user_id: 111 }, read, '')).toBe(true)
    expect(isAllowedInboundSender({ chat_id: -100, user_id: 999 }, read, '')).toBe(true)
    expect(isAllowedInboundSender({ chat_id: -200, user_id: 111 }, read, '')).toBe(true)
  })
  it('drops strangers, unknown groups and restricted-group outsiders', () => {
    expect(isAllowedInboundSender({ chat_id: 999, user_id: 999 }, read, '')).toBe(false)
    expect(isAllowedInboundSender({ chat_id: -300, user_id: 111 }, read, '')).toBe(false)
    expect(isAllowedInboundSender({ chat_id: -200, user_id: 999 }, read, '')).toBe(false)
  })
  it('fails closed on an unreadable allowlist, except for ALLOWED_CHAT_ID', () => {
    const broken = () => { throw new Error('ENOENT') }
    expect(isAllowedInboundSender({ chat_id: 111, user_id: 111 }, broken, '')).toBe(false)
    expect(isAllowedInboundSender({ chat_id: 222, user_id: 222 }, broken, '222')).toBe(true)
  })
})

describe('voice TTS directive never carries the dashboard token value', () => {
  const tokenPath = join(STORE_DIR, '.dashboard-token')
  const token = 'f'.repeat(64)
  writeFileSync(tokenPath, token + '\n', { mode: 0o600 })
  afterAll(() => { rmSync(tmpStore, { recursive: true, force: true }) })

  it('uses a private temp store, never the checkout store', () => {
    expect(STORE_DIR).toBe(tmpStore)
  })

  it('references the token file instead of embedding its contents', () => {
    const d = buildTtsDirective({ chatId: '1', stateDir: '/tmp/x', voiceModel: 'v' })
    expect(d).not.toBeNull()
    expect(d!).not.toContain(token)
    expect(d!).toContain(`Bearer $(cat '${tokenPath}')`)
  })
})
