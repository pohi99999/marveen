// An approval button press read from a real Telegram update (card 3558). The patched plugin records a press in
// <STATE_DIR>/approval-callbacks.jsonl; the coordinator, when it is the one reading the updates, records it in the
// same place and the same shape, so the dashboard has one decision path (web/approval-callbacks.ts).
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROTATE_AT_BYTES = 262144

export interface ApprovalPress {
  data: string
  from_id: number | string | null
  callback_query_id?: unknown
  chat_id?: unknown
}

export function recordApprovalPress(stateDir: string, press: ApprovalPress, now: () => number = Date.now): void {
  mkdirSync(stateDir, { recursive: true })
  const file = join(stateDir, 'approval-callbacks.jsonl')
  try {
    if (statSync(file).size > ROTATE_AT_BYTES) renameSync(file, file + '.1')
  } catch {
    // no file yet
  }
  appendFileSync(file, JSON.stringify({
    callback_query_id: typeof press.callback_query_id === 'string' ? press.callback_query_id : null,
    data: press.data,
    from_id: press.from_id,
    chat_id: press.chat_id ?? null,
    at: now(),
  }) + '\n', { mode: 0o600 })
}
