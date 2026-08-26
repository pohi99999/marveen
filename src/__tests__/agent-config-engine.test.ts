import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

let SANDBOX = ''

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return {
    ...actual,
    PROJECT_ROOT: SANDBOX || actual.PROJECT_ROOT,
  }
})

// Import after mocking so it gets the test PROJECT_ROOT
const { AGENTS_BASE_DIR, readAgentEngine } = await import('../web/agent-config.js')

beforeEach(() => {
  SANDBOX = mkdtempSync(join(tmpdir(), 'engine-'))
})

afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

function writeAgentConfig(name: string, config: object) {
  const dir = join(AGENTS_BASE_DIR, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(config))
}

describe('readAgentEngine', () => {
  it('defaults to claude when agent-config.json has no engine field', () => {
    writeAgentConfig('engine-test-a', { model: 'claude-sonnet-5' })
    expect(readAgentEngine('engine-test-a')).toBe('claude')
  })

  it('defaults to claude when agent-config.json is missing entirely', () => {
    expect(readAgentEngine('engine-test-nonexistent')).toBe('claude')
  })

  it('returns copilot when explicitly set', () => {
    writeAgentConfig('engine-test-b', { engine: 'copilot' })
    expect(readAgentEngine('engine-test-b')).toBe('copilot')
  })

  it('falls back to claude for an unrecognized value (typo-safety)', () => {
    writeAgentConfig('engine-test-c', { engine: 'gpt-whatever' })
    expect(readAgentEngine('engine-test-c')).toBe('claude')
  })
})
