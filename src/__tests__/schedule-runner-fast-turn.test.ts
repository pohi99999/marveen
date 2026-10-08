import { describe, expect, it } from 'vitest'
import {
  decideTaskTimeout,
  transcriptEvidenceSince,
  turnEvidenceSeen,
  TASK_FIRE_GRACE_MS,
} from '../web/schedule-runner.js'
import { OWNER_ESCALATION_EXTRA_MS } from '../pending-retries.js'

// FASTTURN1007 -- a round that finishes before the sweep's reference instant.
//
// Measured 2026-10-07 19:13 on the main agent's memoria-heartbeat (card 1d709a03): the first
// keystroke went in at ~19:13:0x, the transcript has real events 19:13:09-14 (the round ran and
// ended), 'Scheduled task fired' was logged 19:13:18 (sendPromptToSession returned -> submittedAt
// = injectedAt), the sweep found no busy sample in its 15 s ticks and no transcript event AFTER
// injectedAt, and recorded 'lost' at 19:13:48; the re-delivery ran a second, duplicate round
// 19:13:50-54. The evidence threshold must be the first keystroke, not the end of the send.

const opts = { graceMs: TASK_FIRE_GRACE_MS, timeoutMs: 2_700_000, maxTrackMs: 6 * 60 * 60_000, ownerExtraMs: OWNER_ESCALATION_EXTRA_MS }
const TYPED = 1_000       // first keystroke
const SUBMITTED = 10_000  // sendPromptToSession returned 9 s later (chunked send-keys + lock)
const entry = (extra: Partial<{ typedAt: number }> = {}) => ({ injectedAt: SUBMITTED, alerted: false, ownerAlerted: false, sawTurn: false, ...extra })

describe('transcriptEvidenceSince', () => {
  it('is the first keystroke when known, else the submit instant (remote agent)', () => {
    expect(transcriptEvidenceSince({ injectedAt: SUBMITTED, typedAt: TYPED })).toBe(TYPED)
    expect(transcriptEvidenceSince({ injectedAt: SUBMITTED })).toBe(SUBMITTED)
  })
})

describe('a 5-second round that ended before the send returned', () => {
  const fastRoundEnded = 6_000 // the newest real transcript event: after the keystroke, before submittedAt

  it('counts as our turn: idle pane + an event after the first keystroke', () => {
    expect(turnEvidenceSeen(entry({ typedAt: TYPED }), 'idle', fastRoundEnded)).toBe(true)
  })

  it('is therefore DONE at the end of the grace window, not lost (the 19:13 case)', () => {
    const e = entry({ typedAt: TYPED })
    if (turnEvidenceSeen(e, 'idle', fastRoundEnded)) e.sawTurn = true
    expect(decideTaskTimeout(e, 'idle', SUBMITTED + TASK_FIRE_GRACE_MS + 1, opts)).not.toBe('lost')
  })

  it('without a typedAt (remote agent) the old threshold stays: not evidence', () => {
    expect(turnEvidenceSeen(entry(), 'idle', fastRoundEnded)).toBe(false)
  })
})

describe('the other verdicts are unchanged', () => {
  it('a slow round: an event after submittedAt is evidence, and a busy sample is evidence on its own', () => {
    expect(turnEvidenceSeen(entry({ typedAt: TYPED }), 'idle', SUBMITTED + 2_000)).toBe(true)
    expect(turnEvidenceSeen(entry({ typedAt: TYPED }), 'busy', null)).toBe(true)
  })

  it('no event at all past the grace window is still lost', () => {
    const e = entry({ typedAt: TYPED })
    expect(turnEvidenceSeen(e, 'idle', null)).toBe(false)
    expect(turnEvidenceSeen(e, 'idle', TYPED - 1)).toBe(false) // an older, unrelated turn
    expect(decideTaskTimeout(e, 'idle', SUBMITTED + TASK_FIRE_GRACE_MS + 1, opts)).toBe('lost')
  })

  it("'typing' (our prompt parked unsent) is never evidence", () => {
    expect(turnEvidenceSeen(entry({ typedAt: TYPED }), 'typing', SUBMITTED + 2_000)).toBe(true) // the event decides, not the state
    expect(turnEvidenceSeen(entry({ typedAt: TYPED }), 'typing', null)).toBe(false)
  })
})
