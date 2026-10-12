// Context-guard shadow measurement (kanban 5f3617d9, step 3): it records the guard's
// transcript estimate next to the observer mod's own context %, decides nothing, and
// never writes the guard's high-water file.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { modContextFrom, guardEstimate, shadowEntry, sampleShadow, MOD_MAX_AGE_MS } from '../web/context-guard-shadow.js'
import { calibrateLimit, contextLimitForModel } from '../context-guard.js'

const NOW = Date.parse('2026-10-12T13:30:00Z')

describe('context-guard shadow', () => {
  it('reads the mod context percentage and its time; anything else is null', () => {
    expect(modContextFrom({ usage: { context_percent: 12, read_at: NOW } })).toEqual({ percent: 12, readAt: NOW })
    expect(modContextFrom({ usage: { context_percent: null, read_at: NOW } })).toBeNull()
    expect(modContextFrom({ usage: null })).toBeNull()
    expect(modContextFrom(null)).toBeNull()
  })

  it('the guard estimate is the same tokens / calibrated limit as measurePct, with the high-water prior only read', () => {
    const model = 'claude-opus-5-5[1m]'
    const g = guardEstimate(120_000, model, 0)!
    expect(g.limit).toBe(calibrateLimit(120_000, contextLimitForModel(model)))
    expect(g.pct).toBeCloseTo(120_000 / g.limit, 10)
    // a bigger proven window (prior) can only widen the denominator, never shrink it
    const withPrior = guardEstimate(120_000, model, 900_000)!
    expect(withPrior.limit).toBeGreaterThanOrEqual(g.limit)
    expect(guardEstimate(null, model, 0)).toBeNull()
    expect(guardEstimate(0, model, 0)).toBeNull()
  })

  it('one comparison line: guard %, mod %, the difference in points and the reading age', () => {
    const e = shadowEntry('aura', 'claude-opus-5-5[1m]', 120_000, 0, { percent: 12, readAt: NOW - 30_000 }, NOW)!
    expect(e.agent).toBe('aura')
    expect(e.mod_pct).toBe(12)
    expect(e.mod_age_s).toBe(30)
    expect(e.diff_pts).toBeCloseTo(e.guard_pct - 12, 1)
    expect(e.ts).toBe('2026-10-12T13:30:00.000Z')
  })

  it('a stale mod reading or an unmeasurable transcript gives no line (no false comparison)', () => {
    expect(shadowEntry('aura', 'm', 120_000, 0, { percent: 12, readAt: NOW - MOD_MAX_AGE_MS - 1 }, NOW)).toBeNull()
    expect(shadowEntry('aura', 'm', null, 0, { percent: 12, readAt: NOW }, NOW)).toBeNull()
    expect(shadowEntry('aura', 'm', 120_000, 0, null, NOW)).toBeNull()
  })

  it('an agent without a mod-state file is not sampled and nothing is written', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadow-'))
    const log = join(dir, 'shadow.jsonl')
    expect(sampleShadow('no-such-agent', NOW, dir, log)).toBeNull()
    expect(existsSync(log)).toBe(false)
  })

  it('a half-written mod-state file is skipped, not thrown', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadow-'))
    writeFileSync(join(dir, 'aura.json'), '{"usage": {"context_perc')
    const log = join(dir, 'shadow.jsonl')
    expect(sampleShadow('aura', NOW, dir, log)).toBeNull()
    expect(existsSync(log)).toBe(false)
  })

  it('the module has no write path to the guard high-water file', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'context-guard-shadow.ts'), 'utf-8')
    // the only writes are the shadow log append and its one-step rotation
    expect(src).not.toMatch(/writeFileSync/)
    expect(src.match(/appendFileSync\(/g)?.length).toBe(1)
  })
})
