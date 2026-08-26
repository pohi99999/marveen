import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// SANDBOX ISOLATION -- read before touching the order of the statements below.
//
// agent-config.ts resolves AGENTS_BASE_DIR ONCE, at module-evaluation time
// (`export const AGENTS_BASE_DIR = join(PROJECT_ROOT, 'agents')`). The mock
// factory for ../config.js is likewise evaluated the first time that module is
// requested -- which happens during the `await import('../web/agent-config.js')`
// below, i.e. BEFORE any beforeEach/beforeAll hook has run.
//
// The first version of this file assigned SANDBOX in `beforeEach`, so the
// factory closed over an empty string, fell back to the real PROJECT_ROOT, and
// every fixture was written into the REAL repo's agents/ directory --
// agents/engine-test-{a,b,c}/agent-config.json were left behind on disk,
// uncleaned, looking like real fleet agents.
//
// The fix is ordering, not hooks: mint the sandbox HERE, in module body, before
// the dynamic import that triggers the factory. `assertIsolated` below fails
// loudly if that invariant is ever broken again, so this can never silently
// regress into writing to the real agents/ tree.
const SANDBOX = mkdtempSync(join(tmpdir(), 'engine-'))

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return {
    ...actual,
    PROJECT_ROOT: SANDBOX,
  }
})

// Import after mocking so it gets the test PROJECT_ROOT
const { AGENTS_BASE_DIR, readAgentEngine } = await import('../web/agent-config.js')

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

function writeAgentConfig(name: string, config: object) {
  const dir = join(AGENTS_BASE_DIR, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(config))
}

describe('test sandbox', () => {
  it('resolves AGENTS_BASE_DIR inside the temp sandbox, not the real repo', () => {
    // Guard for the pollution bug described at the top of this file: if this
    // ever fails, the fixtures below are writing into the real agents/ tree.
    expect(AGENTS_BASE_DIR).toBe(join(SANDBOX, 'agents'))
    expect(existsSync(SANDBOX)).toBe(true)
  })
})

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

  it('returns antigravity when explicitly set', () => {
    writeAgentConfig('engine-test-antigravity', { engine: 'antigravity' })
    expect(readAgentEngine('engine-test-antigravity')).toBe('antigravity')
  })

  it('falls back to claude for an unrecognized value (typo-safety)', () => {
    writeAgentConfig('engine-test-c', { engine: 'gpt-whatever' })
    expect(readAgentEngine('engine-test-c')).toBe('claude')
  })

  it('falls back to claude for "bogus" value (regression guard)', () => {
    writeAgentConfig('engine-test-bogus', { engine: 'bogus' })
    expect(readAgentEngine('engine-test-bogus')).toBe('claude')
  })
})
