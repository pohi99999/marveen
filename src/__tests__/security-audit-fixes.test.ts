import { describe, it, expect, afterAll } from 'vitest'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
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
  const created = !existsSync(tokenPath)
  if (created) {
    mkdirSync(STORE_DIR, { recursive: true })
    writeFileSync(tokenPath, 'f'.repeat(64) + '\n', { mode: 0o600 })
  }
  afterAll(() => { if (created) unlinkSync(tokenPath) })

  it('references the token file instead of embedding its contents', () => {
    const token = readFileSync(tokenPath, 'utf-8').trim()
    const d = buildTtsDirective({ chatId: '1', stateDir: '/tmp/x', voiceModel: 'v' })
    expect(d).not.toBeNull()
    expect(d!).not.toContain(token)
    expect(d!).toContain(`Bearer $(cat '${tokenPath}')`)
  })
})
