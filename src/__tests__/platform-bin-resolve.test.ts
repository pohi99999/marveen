import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Two regressions live here.
//
// The 04:00 auto-update boot crash: a transient PATH gap makes `which claude`
// fail, and a module-level `resolveFromPath('claude')` then threw at import
// time, taking the whole dashboard (and the scheduler that lives in it) down.
// tryResolveFromPath must find known install dirs, and makeLazyBinResolver must
// not resolve (or throw) until first use.
//
// And the PATH-order dependence found on 2026-09-07: with claude installed both
// at ~/.local/bin (2.1.263) and /usr/bin (2.1.228, orphaned npm-global), the
// resolved binary depended on the CALLING process's PATH -- the dashboard got
// the right one, an agent session got the August one. KNOWN_BIN_DIRS already
// ranked user installs above system ones, but only ran when `which` failed, so
// the ranking never applied while a wrong answer was available.

const mockExecSync = vi.fn()
const mockExistsSync = vi.fn()

vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, existsSync: (p: string) => mockExistsSync(p) }
})

import { tryResolveFromPath, resolveFromPath, makeLazyBinResolver } from '../platform.js'

beforeEach(() => {
  mockExecSync.mockReset()
  mockExistsSync.mockReset()
  mockExistsSync.mockReturnValue(false)
})

describe('tryResolveFromPath', () => {
  it('uses which for an install in a dir this list does not rank', () => {
    // `which` is the last resort, not the first answer: it only decides when no
    // known dir holds the binary.
    mockExecSync.mockReturnValue('/opt/custom/bin/claude\n')
    mockExistsSync.mockReturnValue(false)
    expect(tryResolveFromPath('claude')).toBe('/opt/custom/bin/claude')
  })

  it('prefers a known dir over whatever the caller PATH resolves to', () => {
    // The 2026-09-07 finding, stated directly: same machine, same two installs,
    // and the answer must not change with the caller's PATH order.
    const home = homedir()
    mockExecSync.mockReturnValue('/usr/bin/claude\n')          // an agent session's PATH
    mockExistsSync.mockImplementation((p: string) =>
      p === join(home, '.local', 'bin', 'claude') || p === '/usr/bin/claude')
    expect(tryResolveFromPath('claude')).toBe(join(home, '.local', 'bin', 'claude'))
    // and it never had to ask the shell at all
    expect(mockExecSync).not.toHaveBeenCalled()
  })

  it('gives the same answer whatever the caller PATH says', () => {
    const home = homedir()
    mockExistsSync.mockImplementation((p: string) =>
      p === join(home, '.local', 'bin', 'claude') || p === '/usr/bin/claude')
    const answers = new Set<string | null>()
    for (const whichSays of ['/usr/bin/claude\n', join(home, '.local', 'bin', 'claude') + '\n', '/bin/claude\n']) {
      mockExecSync.mockReturnValue(whichSays)
      answers.add(tryResolveFromPath('claude'))
    }
    expect(answers).toEqual(new Set([join(home, '.local', 'bin', 'claude')]))
  })

  it('treats an empty which result as not-found rather than as an empty path', () => {
    mockExecSync.mockReturnValue('\n')
    mockExistsSync.mockReturnValue(false)
    expect(tryResolveFromPath('claude')).toBeNull()
  })

  it('falls back to a known install dir when which fails (transient PATH gap)', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which: no claude in PATH') })
    mockExistsSync.mockImplementation((p: string) => p === '/opt/homebrew/bin/claude')
    expect(tryResolveFromPath('claude')).toBe('/opt/homebrew/bin/claude')
  })

  it('probes /usr/local/bin when /opt/homebrew/bin has no binary', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockImplementation((p: string) => p === '/usr/local/bin/tmux')
    expect(tryResolveFromPath('tmux')).toBe('/usr/local/bin/tmux')
  })

  it('probes the user-level install dirs (~/.local/bin native, ~/.bun/bin bun) -- the bootcamp/AVX-fallback layout', () => {
    const home = homedir()
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockImplementation((p: string) => p === join(home, '.local', 'bin', 'claude'))
    expect(tryResolveFromPath('claude')).toBe(join(home, '.local', 'bin', 'claude'))
    mockExistsSync.mockImplementation((p: string) => p === join(home, '.bun', 'bin', 'claude'))
    expect(tryResolveFromPath('claude')).toBe(join(home, '.bun', 'bin', 'claude'))
  })

  it('user-level dirs win over system dirs (PATH-precedence parity)', () => {
    const home = homedir()
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockImplementation((p: string) =>
      p === join(home, '.local', 'bin', 'claude') || p === '/usr/bin/claude')
    expect(tryResolveFromPath('claude')).toBe(join(home, '.local', 'bin', 'claude'))
  })

  it('returns null (does NOT throw) when the binary is absent everywhere', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockReturnValue(false)
    expect(tryResolveFromPath('claude')).toBeNull()
  })

  it('rejects an invalid binary name before touching the shell', () => {
    expect(() => tryResolveFromPath('claude; rm -rf /')).toThrow(/Invalid binary name/)
    expect(mockExecSync).not.toHaveBeenCalled()
  })
})

describe('resolveFromPath', () => {
  it('throws only when the binary is truly unresolvable', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockReturnValue(false)
    expect(() => resolveFromPath('claude')).toThrow(/Required binary not found/)
  })
})

describe('makeLazyBinResolver', () => {
  it('does not resolve at construction time (safe during a boot-time PATH gap)', () => {
    makeLazyBinResolver('claude')
    expect(mockExecSync).not.toHaveBeenCalled()
    expect(mockExistsSync).not.toHaveBeenCalled()
  })

  // Memoisation used to be asserted as "did not re-run `which`". That proxy died
  // when known dirs moved ahead of `which`: a binary in a known dir now resolves
  // without ever shelling out, so the execSync count is 0 both times and the
  // assertion passed vacuously. Counting the PROBE instead states the same thing
  // about the thing that actually costs something -- the directory sweep.
  it('resolves on first call and memoises while the cached path still exists', () => {
    mockExistsSync.mockImplementation((p: string) => p === '/opt/homebrew/bin/tmux')
    const tmuxBin = makeLazyBinResolver('tmux')
    expect(tmuxBin()).toBe('/opt/homebrew/bin/tmux')
    const probeCalls = mockExistsSync.mock.calls.length
    expect(probeCalls).toBeGreaterThan(1)          // it did search

    mockExistsSync.mockClear()
    expect(tmuxBin()).toBe('/opt/homebrew/bin/tmux')
    // Second call only re-validates the cached path; it does not search again.
    expect(mockExistsSync.mock.calls).toEqual([['/opt/homebrew/bin/tmux']])
  })

  it('re-resolves when the cached path disappears (binary moved / symlink repointed)', () => {
    const stale = join(homedir(), '.local', 'bin', 'claude')
    const fresh = '/opt/homebrew/bin/claude'
    mockExistsSync.mockImplementation((p: string) => p === stale)
    const claudeBin = makeLazyBinResolver('claude')
    expect(claudeBin()).toBe(stale)

    // The cached path vanishes: the next call must search again instead of
    // returning the dead path -- no restart needed.
    mockExistsSync.mockClear()
    mockExistsSync.mockImplementation((p: string) => p === fresh)
    expect(claudeBin()).toBe(fresh)
    expect(mockExistsSync.mock.calls.length).toBeGreaterThan(1)
  })

  it('surfaces the not-found error on first use, not at import', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockReturnValue(false)
    const claudeBin = makeLazyBinResolver('claude')
    expect(() => claudeBin()).toThrow(/Required binary not found/)
  })
})
