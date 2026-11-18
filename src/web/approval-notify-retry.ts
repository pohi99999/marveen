// APPROVALNOTIFYRETRY1118: the owner's approval notification is sent again when the send fails for a
// passing reason.
//
// Measured 2026-11-18 15:00:17: an email_send request was filed, the one Telegram send answered
// "fetch failed: read ECONNRESET", and the request was written off as OWNER_UNREACHED at once. The
// owner got no message and no button, and asked why this one came without a button. One reset
// connection is not an owner who cannot be reached.
//
// What counts as passing is the fleet's existing rule (pending-retries.ts classifySendError): a
// network failure without a status, HTTP 429 and any 5xx. A 4xx other than 429 is configuration (a
// wrong chat id, a revoked token) and fails the same way every time, so it is not sent again.
//
// What a second send can cost: a send whose ANSWER was lost may have arrived, and then the owner
// gets the question twice. Both messages carry the same request; the first press decides it and a
// press on the other one is refused as already resolved (telegram-approval.ts). A question that
// arrives twice is the cheaper mistake than one that never arrives.
import { classifySendError } from '../pending-retries.js'

export interface RetryDeps {
  /** The wait before the 2nd, 3rd, ... attempt. Its length is the number of further attempts. */
  delaysMs: readonly number[]
  sleep: (ms: number) => Promise<void>
}

/** The longest wait one step may take, whatever the server asks for. */
export const MAX_WAIT_MS = 30_000

export type RetryOutcome<T> =
  | { ok: true; value: T; attempts: number }
  /** permanent: the error is configuration; exhausted: every attempt failed; unwanted: nobody waits for the send any more. */
  | { ok: false; why: 'permanent' | 'exhausted' | 'unwanted'; err: unknown; attempts: number }

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** True when sending again may help: see the rule at the top of the file. */
export function isPassingSendError(err: unknown): boolean {
  return classifySendError(messageOf(err)) === 'transient'
}

/**
 * How long the server asked the sender to wait, in milliseconds, or null when it named no time.
 * Telegram answers a 429 with "Too Many Requests: retry after 7" (and `parameters.retry_after: 7`);
 * sendTelegramMessage keeps the first 200 characters of that body in the error's message.
 */
export function retryAfterMs(err: unknown): number | null {
  const m = /retry[ _]after["':\s]+(\d{1,4})\b/i.exec(messageOf(err))
  return m ? Number(m[1]) * 1000 : null
}

/**
 * Calls `send`; after a passing failure waits and calls it again, as many more times as `deps.delaysMs`
 * has entries. Before every further attempt `stillWanted` is asked: a request that was decided on the
 * dashboard in the meantime gets no late question. `onRetry` is told about every failed attempt that
 * is followed by another, so no failure is silent.
 */
export async function sendWithRetry<T>(
  send: () => Promise<T>,
  deps: RetryDeps,
  opts: { stillWanted?: () => boolean; onRetry?: (err: unknown, attempt: number, waitMs: number) => void } = {},
): Promise<RetryOutcome<T>> {
  let attempts = 0
  for (;;) {
    attempts += 1
    let err: unknown
    try {
      return { ok: true, value: await send(), attempts }
    } catch (e) {
      err = e
    }
    if (!isPassingSendError(err)) return { ok: false, why: 'permanent', err, attempts }
    const planned = deps.delaysMs[attempts - 1]
    if (planned === undefined) return { ok: false, why: 'exhausted', err, attempts }
    const waitMs = Math.min(MAX_WAIT_MS, Math.max(planned, retryAfterMs(err) ?? 0))
    // Telling about the failed attempt is a log line: if it cannot be written, the sending still goes on. (A
    // logger that threw here made a timeout look like an owner who cannot be reached, second review of PR #56.)
    try {
      opts.onRetry?.(err, attempts, waitMs)
    } catch {
      // nothing to do: the next attempt is what matters
    }
    await deps.sleep(waitMs)
    if (opts.stillWanted && !opts.stillWanted()) return { ok: false, why: 'unwanted', err, attempts }
  }
}
