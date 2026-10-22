import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argvBelongsToInstall } from '../process-lock.js'

// Measured 2026-10-22 23:12:56 on the Mac: a dashboard restart ("Previous
// dashboard instance(s) detected, taking over", byPort [], byBinary 5 pids)
// SIGTERMed five MCP servers of the main channels session -- context7,
// desktop-commander, sequential-thinking, cloudflare, meta-ads, each a
// `node /Users/pohi/.local/lib/node_modules/<pkg>/dist/index.js`. The
// binary pattern matches any ".../dist/index.js", and the attribution
// accepted them as this install's on their cwd alone: the main session runs
// from PROJECT_ROOT, so its MCP children do too. Sub-agents' MCPs (cwd
// agents/<name>) were left alone, which is why only the main session lost them.

const ROOT = '/Users/pohi/marveen'
const at = (cwd: string | null) => () => cwd

describe('argvBelongsToInstall: whose dist/index.js is it', () => {
  it('a foreign absolute dist/index.js is NOT ours, even with cwd = PROJECT_ROOT (the measured case)', () => {
    expect(argvBelongsToInstall('node /Users/pohi/.local/lib/node_modules/@upstash/context7-mcp/dist/index.js', ROOT, at(ROOT))).toBe(false)
    expect(argvBelongsToInstall('node /Users/pohi/.local/lib/node_modules/@cloudflare/mcp-server-cloudflare/dist/index.js run dd107933', ROOT, at(ROOT))).toBe(false)
  })

  it('a dependency under PROJECT_ROOT/node_modules is NOT the dashboard', () => {
    expect(argvBelongsToInstall(`node ${ROOT}/node_modules/some-mcp/dist/index.js`, ROOT, at(ROOT))).toBe(false)
  })

  it('our own dashboard by absolute path is ours (from any cwd)', () => {
    expect(argvBelongsToInstall(`/opt/homebrew/opt/node@22/bin/node ${ROOT}/dist/index.js`, ROOT, at('/'))).toBe(true)
    expect(argvBelongsToInstall(`node ${ROOT}/src/index.ts`, ROOT, at(null))).toBe(true)
  })

  it('a relative entry is decided by the cwd, as before', () => {
    expect(argvBelongsToInstall('node dist/index.js', ROOT, at(ROOT))).toBe(true)
    expect(argvBelongsToInstall('tsx src/index.ts', ROOT, at(`${ROOT}/agents/x`))).toBe(true)
    expect(argvBelongsToInstall('node dist/index.js', ROOT, at('/elsewhere'))).toBe(false)
    expect(argvBelongsToInstall('node dist/index.js', ROOT, at(null))).toBe(false)
  })

  it('a sibling checkout is not ours (boundary: /marveen vs /marveen2)', () => {
    expect(argvBelongsToInstall('node /Users/pohi/marveen2/dist/index.js', ROOT, at(ROOT))).toBe(false)
  })

  it('a non-entry argv keeps the old rule (argv under PROJECT_ROOT, or cwd under it)', () => {
    expect(argvBelongsToInstall(`node ${ROOT}/scripts/x.mjs`, ROOT, at('/'))).toBe(true)
    expect(argvBelongsToInstall('node /tmp/x.mjs', ROOT, at(`${ROOT}/agents/y`))).toBe(true)
    expect(argvBelongsToInstall('node /tmp/x.mjs', ROOT, at('/tmp'))).toBe(false)
  })
})

describe('index.ts attribution goes through argvBelongsToInstall', () => {
  it('both index.ts call sites (binary-pattern listing and port-holder check) use it', () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'index.ts'), 'utf-8')
    const fn = src.slice(src.indexOf('function argvBelongsToThisInstall('))
    const body = fn.slice(0, fn.indexOf('\n}\n'))
    expect(body).toMatch(/argvBelongsToInstall\(/)
  })
})
