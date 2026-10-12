// Context-guard SHADOW measurement (kanban 5f3617d9, step 3; owner GO 2026-10-12).
//
// The guard estimates an agent's context fill from its transcript (tokens over
// a calibrated window). That estimate was once read as 106% for a session that
// was really at 21%. The agent-state-observer mod (plugins/agent-state-observer)
// writes Claude Code's OWN context percentage ($.session.usage().context.percent)
// to store/mod-state/<agent>.json. Before the guard may ever act on the mod's
// number, this module only RECORDS both numbers side by side, one JSON line per
// sweep, for a week:
//   store/context-guard-shadow.jsonl
// It decides nothing, restarts nothing and never touches the guard's state:
// the guard estimate here is computed WITHOUT writing the high-water file
// (measurePct persists it; this reads it). Only agents with a mod-state file
// are sampled (the observer is opt-in and never runs in the main session), and
// a reading older than MOD_MAX_AGE_MS is skipped instead of compared.

import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, STORE_DIR } from '../config.js'
import { calibrateLimit, contextLimitForModel } from '../context-guard.js'
import { agentDir, readAgentModel } from './agent-config.js'
import { readContextTokensFromProjectDir } from './active-model.js'
import { configDirFor } from './main-transcript-root.js'

export const SHADOW_LOG_PATH = join(STORE_DIR, 'context-guard-shadow.jsonl')
export const MOD_STATE_DIR = join(STORE_DIR, 'mod-state')
const HIGHWATER_PATH = join(PROJECT_ROOT, 'store', 'context-guard-highwater.json')
/** A mod reading older than this is not compared: the transcript may have moved on. */
export const MOD_MAX_AGE_MS = 10 * 60_000
/** The log is rotated once (to .1) past this size, so a forgotten week cannot fill the disk. */
export const SHADOW_LOG_MAX_BYTES = 5 * 1024 * 1024

export type ModContext = { percent: number; readAt: number }

/** The mod's context reading from a mod-state snapshot, or null when there is none. */
export function modContextFrom(snapshot: unknown): ModContext | null {
  const u = (snapshot as { usage?: { context_percent?: unknown; read_at?: unknown } } | null)?.usage
  if (!u || typeof u.context_percent !== 'number' || !Number.isFinite(u.context_percent)) return null
  if (typeof u.read_at !== 'number' || !Number.isFinite(u.read_at)) return null
  return { percent: u.context_percent, readAt: u.read_at }
}

/**
 * The guard's estimate without side effects: the same tokens / calibrated
 * limit as measurePct, with the high-water prior READ, never written.
 */
export function guardEstimate(tokens: number | null, model: string, highwaterPrior: number): { pct: number; limit: number } | null {
  if (tokens === null || !(tokens > 0)) return null
  const limit = calibrateLimit(Math.max(tokens, highwaterPrior), contextLimitForModel(model))
  return { pct: tokens / limit, limit }
}

export type ShadowEntry = {
  ts: string
  agent: string
  model: string
  guard_pct: number
  mod_pct: number
  diff_pts: number
  guard_tokens: number
  guard_limit: number
  mod_age_s: number
}

/** One comparison line, or null when either side is missing or the mod reading is stale. */
export function shadowEntry(
  agent: string,
  model: string,
  tokens: number | null,
  highwaterPrior: number,
  mod: ModContext | null,
  nowMs: number,
): ShadowEntry | null {
  if (!mod || nowMs - mod.readAt > MOD_MAX_AGE_MS) return null
  const g = guardEstimate(tokens, model, highwaterPrior)
  if (!g) return null
  const guardPct = Math.round(g.pct * 1000) / 10
  return {
    ts: new Date(nowMs).toISOString(),
    agent,
    model,
    guard_pct: guardPct,
    mod_pct: mod.percent,
    diff_pts: Math.round((guardPct - mod.percent) * 10) / 10,
    guard_tokens: tokens as number,
    guard_limit: g.limit,
    mod_age_s: Math.round((nowMs - mod.readAt) / 1000),
  }
}

function highwaterPriorFor(name: string, model: string): number {
  try {
    const map = JSON.parse(readFileSync(HIGHWATER_PATH, 'utf-8')) as Record<string, { model?: string; tokens?: number }>
    const e = map?.[name]
    return e && e.model === model && typeof e.tokens === 'number' ? e.tokens : 0
  } catch {
    return 0
  }
}

/**
 * Sample one agent: append a comparison line when the agent has a fresh mod
 * reading and a measurable transcript. Never throws to the caller's decision
 * path (the runner wraps it as well) and returns what it wrote, for tests.
 */
export function sampleShadow(name: string, nowMs: number, dir: string = MOD_STATE_DIR, logPath: string = SHADOW_LOG_PATH): ShadowEntry | null {
  const file = join(dir, `${name}.json`)
  if (!existsSync(file)) return null
  let snapshot: unknown
  try {
    snapshot = JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return null // a half-written file: the next sweep reads it whole
  }
  const model = readAgentModel(name) ?? ''
  const tokens = readContextTokensFromProjectDir(agentDir(name), configDirFor(name))
  const entry = shadowEntry(name, model, tokens, highwaterPriorFor(name, model), modContextFrom(snapshot), nowMs)
  if (!entry) return null
  try {
    if (existsSync(logPath) && statSync(logPath).size > SHADOW_LOG_MAX_BYTES) renameSync(logPath, `${logPath}.1`)
    appendFileSync(logPath, JSON.stringify(entry) + '\n')
  } catch {
    return null
  }
  return entry
}
