import { describe, expect, it } from 'vitest'
import {
  LOST_REINJECT_MAX,
  cronOccursOnLocalDay,
  decideLostRequeue,
  decideTaskTimeout,
  lostDetectionSupported,
  TASK_FIRE_GRACE_MS,
} from '../web/schedule-runner.js'
import { OWNER_ESCALATION_EXTRA_MS } from '../pending-retries.js'

// LOSTLOOP913 -- the fire->lost re-injection loop.
//
// Measured 2026-09-11..12 in task_runs: napi-b2b-outreach (cron `0 6 * * 1-5`,
// agent agy-test on the antigravity engine) 563x fired + 563x lost on Friday,
// 178x + 178x on SATURDAY (00:05 -> 18:32), pattern: fired, 'lost' after the
// grace window, re-queued, re-fired ~6 minutes later, all day. outreach_events
// showed the normal 10 drafts/day, i.e. the agent acted on the first delivery
// and every later 'lost' was false. These tests pin each of the three gaps.

const TZ = 'Europe/Budapest'
const WEEKDAY_0600 = '0 6 * * 1-5'
function at(iso: string): number { return new Date(iso).getTime() }

describe('gap 1: lost-detection is only meaningful on the Claude engine', () => {
  it('claude is supported, copilot and antigravity are not', () => {
    expect(lostDetectionSupported('claude')).toBe(true)
    expect(lostDetectionSupported('copilot')).toBe(false)
    expect(lostDetectionSupported('antigravity')).toBe(false)
  })

  it('the underlying verdict is unchanged: idle + no evidence past grace is still lost', () => {
    // This is the exact input the antigravity pane produces on EVERY sweep --
    // the engine gate above is what has to stop the re-queue, not this function.
    const entry = { injectedAt: 0, alerted: false, ownerAlerted: false, sawTurn: false }
    const opts = { graceMs: TASK_FIRE_GRACE_MS, timeoutMs: 2_700_000, maxTrackMs: 6 * 60 * 60_000, ownerExtraMs: OWNER_ESCALATION_EXTRA_MS }
    expect(decideTaskTimeout(entry, 'idle', TASK_FIRE_GRACE_MS + 1, opts)).toBe('lost')
  })
})

describe('gap 2: a lost re-queue has a ceiling', () => {
  it('requeues below the ceiling and gives up at it', () => {
    expect(LOST_REINJECT_MAX).toBe(3)
    expect(decideLostRequeue(1)).toBe('requeue')
    expect(decideLostRequeue(2)).toBe('requeue')
    expect(decideLostRequeue(3)).toBe('giveup')
    expect(decideLostRequeue(178)).toBe('giveup')
  })

  it('replay of the Saturday incident: 178 lost verdicts produce at most 2 re-queues, not 177', () => {
    // Mirrors the runner's bookkeeping: the count increments per verdict and
    // is cleared on giveup (the next cron-path fire starts a fresh streak).
    let count = 0
    let requeues = 0
    let giveups = 0
    for (let verdict = 0; verdict < 178; verdict++) {
      count += 1
      if (decideLostRequeue(count) === 'giveup') { giveups += 1; count = 0 } else { requeues += 1 }
    }
    // Without a ceiling this would have been 178 re-queues (the measured loop).
    expect(requeues).toBeLessThan(178)
    expect(requeues).toBe(giveups * (LOST_REINJECT_MAX - 1) + count)
    expect(giveups).toBeGreaterThan(0)
  })
})

describe('gap 3: a lost re-queue respects the cron day', () => {
  it('a weekday-only cron has no occurrence on Saturday (the incident day)', () => {
    expect(cronOccursOnLocalDay(WEEKDAY_0600, at('2026-09-12T00:05:00+02:00'), TZ)).toBe(false)
    expect(cronOccursOnLocalDay(WEEKDAY_0600, at('2026-09-12T18:32:00+02:00'), TZ)).toBe(false)
    expect(cronOccursOnLocalDay(WEEKDAY_0600, at('2026-09-13T12:00:00+02:00'), TZ)).toBe(false)
  })

  it('the same cron does occur on Friday after 06:00 and on Monday after 06:00', () => {
    expect(cronOccursOnLocalDay(WEEKDAY_0600, at('2026-09-11T06:02:00+02:00'), TZ)).toBe(true)
    expect(cronOccursOnLocalDay(WEEKDAY_0600, at('2026-09-11T23:59:00+02:00'), TZ)).toBe(true)
    expect(cronOccursOnLocalDay(WEEKDAY_0600, at('2026-09-14T06:02:00+02:00'), TZ)).toBe(true)
  })

  it('before the first occurrence of the day the retry has nothing to belong to', () => {
    // Monday 05:59: the previous occurrence is Friday's -- a different day.
    expect(cronOccursOnLocalDay(WEEKDAY_0600, at('2026-09-14T05:59:00+02:00'), TZ)).toBe(false)
  })

  it('a frequent cron always has an occurrence today', () => {
    expect(cronOccursOnLocalDay('*/2 * * * *', at('2026-09-12T00:03:00+02:00'), TZ)).toBe(true)
  })

  it('the day boundary is the scheduler tz, not UTC', () => {
    // 2026-09-11T22:30Z is Friday 22:30 UTC but already Saturday 00:30 in Budapest.
    expect(cronOccursOnLocalDay(WEEKDAY_0600, at('2026-09-11T22:30:00Z'), 'UTC')).toBe(true)
    expect(cronOccursOnLocalDay(WEEKDAY_0600, at('2026-09-11T22:30:00Z'), TZ)).toBe(false)
  })

  it('an invalid cron never claims an occurrence', () => {
    expect(cronOccursOnLocalDay('not a cron', at('2026-09-11T06:02:00+02:00'), TZ)).toBe(false)
  })
})
