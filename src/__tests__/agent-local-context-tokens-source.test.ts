// AGENT_LOCAL_CONTEXT_TOKENS: where the number comes from.
//
// The setting is a registry key that needs a restart, so it has to resolve the way every such key
// does: store/config-overrides.json (what the Settings page saves) first, then the install .env,
// then the default. A read from process.env instead would look right in a unit test and be wrong on
// the host: the dashboard's process environment does not carry the install .env keys, and a value
// saved on the Settings page would never reach the launch command.
//
// config.ts resolves the value at import time, so each case re-imports it after pointing the two
// sources at test data: the .env through CLAUDECLAW_ENV_DIR (env.ts's test seam), the overrides file
// by answering the two fs calls config.ts makes for that one path.
import { describe, it, expect, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const saved = {
  dir: process.env.CLAUDECLAW_ENV_DIR,
  own: process.env.AGENT_LOCAL_CONTEXT_TOKENS,
}

function restore(key: 'CLAUDECLAW_ENV_DIR' | 'AGENT_LOCAL_CONTEXT_TOKENS', value: string | undefined) {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

// overrides: undefined = the overrides file does not exist; an object = its parsed content.
async function load(envFile: string, overrides: Record<string, unknown> | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'local-ctx-env-'))
  writeFileSync(join(dir, '.env'), envFile)
  process.env.CLAUDECLAW_ENV_DIR = dir
  vi.resetModules()
  vi.doMock('node:fs', async (importOriginal) => {
    const real = await importOriginal<typeof import('node:fs')>()
    const isOverrides = (p: unknown) => typeof p === 'string' && p.endsWith(join('store', 'config-overrides.json'))
    return {
      ...real,
      existsSync: (p: Parameters<typeof real.existsSync>[0]) => (isOverrides(p) ? overrides !== undefined : real.existsSync(p)),
      readFileSync: ((p: unknown, ...rest: unknown[]) =>
        isOverrides(p) && overrides !== undefined
          ? JSON.stringify(overrides)
          : (real.readFileSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.readFileSync,
    }
  })
  return await import('../config.js')
}

describe('AGENT_LOCAL_CONTEXT_TOKENS resolves from the Settings overrides and the install .env, not from process.env', () => {
  afterEach(() => {
    vi.doUnmock('node:fs')
    restore('AGENT_LOCAL_CONTEXT_TOKENS', saved.own)
  })
  afterAll(() => {
    restore('CLAUDECLAW_ENV_DIR', saved.dir)
    vi.resetModules()
  })

  it('a value in the install .env is the value', async () => {
    delete process.env.AGENT_LOCAL_CONTEXT_TOKENS
    const config = await load('AGENT_LOCAL_CONTEXT_TOKENS=65536\n', undefined)
    expect(config.AGENT_LOCAL_CONTEXT_TOKENS).toBe(65536)
  })

  it('a value saved on the Settings page (config-overrides.json) wins over the .env', async () => {
    delete process.env.AGENT_LOCAL_CONTEXT_TOKENS
    const config = await load('AGENT_LOCAL_CONTEXT_TOKENS=65536\n', { AGENT_LOCAL_CONTEXT_TOKENS: 98304 })
    expect(config.AGENT_LOCAL_CONTEXT_TOKENS).toBe(98304)
  })

  it('an unusable saved value falls back to the default, it does not fall through to the .env or reach the shell line', async () => {
    delete process.env.AGENT_LOCAL_CONTEXT_TOKENS
    const config = await load('AGENT_LOCAL_CONTEXT_TOKENS=65536\n', { AGENT_LOCAL_CONTEXT_TOKENS: '131072; id' })
    expect(config.AGENT_LOCAL_CONTEXT_TOKENS).toBe(config.AGENT_LOCAL_CONTEXT_TOKENS_DEFAULT)
  })

  it('with neither source set it is the default', async () => {
    delete process.env.AGENT_LOCAL_CONTEXT_TOKENS
    const config = await load('WEB_PORT=3420\n', undefined)
    expect(config.AGENT_LOCAL_CONTEXT_TOKENS).toBe(config.AGENT_LOCAL_CONTEXT_TOKENS_DEFAULT)
  })

  it('a process environment variable of the same name does not count: not instead of the .env, and not on its own', async () => {
    process.env.AGENT_LOCAL_CONTEXT_TOKENS = '77777'
    const withEnvFile = await load('AGENT_LOCAL_CONTEXT_TOKENS=65536\n', undefined)
    expect(withEnvFile.AGENT_LOCAL_CONTEXT_TOKENS).toBe(65536)
    const alone = await load('WEB_PORT=3420\n', undefined)
    expect(alone.AGENT_LOCAL_CONTEXT_TOKENS).toBe(alone.AGENT_LOCAL_CONTEXT_TOKENS_DEFAULT)
  })

  it('the launcher exports the resolved value: the number saved on the Settings page is the number in the shell line', async () => {
    delete process.env.AGENT_LOCAL_CONTEXT_TOKENS
    await load('WEB_PORT=3420\n', { AGENT_LOCAL_CONTEXT_TOKENS: 98304 })
    const { resolveProviderEnv } = await import('../web/agent-process.js')
    expect(resolveProviderEnv('gemma4:12b', () => null).exportsStr).toContain(
      ' && export CLAUDE_CODE_MAX_CONTEXT_TOKENS=98304 && export CLAUDE_CODE_DISABLE_1M_CONTEXT=1 && ',
    )
  })
})
