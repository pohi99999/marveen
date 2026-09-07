import { describe, it, expect } from 'vitest'
import { getSettingDefinition } from '../config-registry.js'
import { resolveModelId, MODEL_ALIASES } from '../web/agent-config.js'
import { resolveAgentModelFromConfig } from '../model-profiles.js'
import { isValidModelId } from '../model-id.js'
import { contextLimitForModel } from '../context-guard.js'
import { nextFallbackModel, DEFAULT_MODEL_CHAIN } from '../model-fallback.js'

// Fable 5.1 (2026-09-01) is what the fleet is being measured on, and the 2.1.263
// binary knows it -- `strings` shows claude-fable-5-1 with its own price tier
// (tier_10_50_cache_read_0_25, the 75% cache-read cut) next to Fable 5's plain
// tier_10_50. Only our own lists were stale.
//
// The point of this file is NOT that a string appears in an array. It is that a
// model id set on an agent ARRIVES at the launch command unchanged. A
// measurement that silently runs on a different model would report numbers for
// something nobody chose -- and it would look exactly like a successful
// measurement.
const FABLE_51 = 'claude-fable-5-1'

describe('Fable 5.1 is selectable', () => {
  it('is offered as a default-agent-model value', () => {
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')
    expect(def?.valueSet).toContain(FABLE_51)
    // and Fable 5 is still there: this adds a choice, it does not replace one
    expect(def?.valueSet).toContain('claude-fable-5')
  })
})

describe('the id survives the path from config to launch', () => {
  it('resolveModelId passes it through untouched', () => {
    expect(resolveModelId(FABLE_51)).toBe(FABLE_51)
  })

  it('is not shadowed by an alias, now or later', () => {
    // An alias key equal to this id would silently remap every launch.
    expect(Object.keys(MODEL_ALIASES)).not.toContain(FABLE_51)
    // Nor may any alias TARGET the older Fable while claiming to be 5.1.
    expect(Object.values(MODEL_ALIASES)).not.toContain(FABLE_51)
  })

  it('an explicit agent-config model wins and is not rewritten', () => {
    const r = resolveAgentModelFromConfig({ model: FABLE_51 }, null, 'claude-sonnet-5', resolveModelId)
    expect(r.model).toBe(FABLE_51)
    expect(r.source).toBe('explicit_model')
  })

  it('passes the shell-safety validator that gates persistence', () => {
    expect(isValidModelId(FABLE_51)).toBe(true)
  })

  it('is treated as a 1M-context family, like Fable 5', () => {
    // Getting this wrong would make the context guard read a healthy session as
    // over-full and restart it mid-measurement.
    expect(contextLimitForModel(FABLE_51)).toBe(1_000_000)
  })
})

// Not a defect in this change, but the one live path that can still move an
// agent OFF the model it was set to. Pinned so the behaviour is visible rather
// than discovered mid-measurement; see the report on card 5ab43267 follow-up.
describe('the auto-downgrade chain does not know Fable at all', () => {
  it('downgrades an off-chain model to the chain runner-up, not to a Fable step', () => {
    const chain = [...DEFAULT_MODEL_CHAIN]
    expect(chain).not.toContain(FABLE_51)
    expect(nextFallbackModel(FABLE_51, chain)).toBe(chain[1])
  })

  it('and reverting would land on the chain primary, not back on Fable', () => {
    // chain[0] is where a revert goes. An agent set to Fable that downgrades and
    // then reverts ends up on a model nobody selected.
    expect(DEFAULT_MODEL_CHAIN[0]).not.toBe(FABLE_51)
  })
})
