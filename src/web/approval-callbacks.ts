// Card 3558: the owner's approval button presses, read from the Telegram plugin's state dir.
//
// The native plugin (patched by scripts/patch-telegram-plugin.py, patch "apr") appends one JSON line
// per `apr:` callback_query to <STATE_DIR>/approval-callbacks.jsonl: callback id, data, from.id. That
// file is written only by the one process a real Telegram update reaches, like inbound-evidence.jsonl.
// This watcher reads new lines, checks the owner's id and the nonce (telegram-approval.ts), resolves
// on the server (routes/approvals.ts applyOwnerDecision) and answers the callback itself. The agent
// never sees the line: the press is not a message.
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { logger } from '../logger.js'
import { STORE_DIR, TELEGRAM_BOT_TOKEN } from '../config.js'
import { channelStateDir } from '../channel-provider.js'
import { resolveOwnerChatId } from '../owner-chat.js'
import { checkOwnerCallback } from './telegram-approval.js'
import { applyOwnerDecision, ownerDecisionRefusalText } from './routes/approvals.js'
import { answerTelegramCallbackQuery } from './telegram.js'

export interface CallbackLine { callback_query_id?: string; data?: string; from_id?: number | string; at?: number }
export interface CallbackOutcome { data: string; outcome: 'approved' | 'rejected' | 'refused' | 'malformed'; reason?: string }

/** Pure-ish core, exported for the tests: one line in, one outcome out; `apply` and `answer` are injected. */
export async function handleCallbackLine(
  line: CallbackLine,
  ownerId: string | null,
  deps: {
    apply: (id: string, nonce: string, decision: 'approved' | 'rejected') => ReturnType<typeof applyOwnerDecision>
    answer: (callbackQueryId: string, text: string) => Promise<unknown>
  },
): Promise<CallbackOutcome> {
  const data = typeof line.data === 'string' ? line.data : ''
  const check = checkOwnerCallback(data, line.from_id ?? null, ownerId)
  if (!check.ok) {
    if (line.callback_query_id && check.reason === 'not-owner') await deps.answer(line.callback_query_id, 'Nem jogosult.').catch(() => {})
    return { data, outcome: check.reason === 'malformed' ? 'malformed' : 'refused', reason: check.reason }
  }
  const r = deps.apply(check.parsed.approvalId, check.parsed.nonce, check.parsed.decision)
  const text = r.ok ? (check.parsed.decision === 'approved' ? 'Jóváhagyva.' : 'Elutasítva.') : ownerDecisionRefusalText(r.reason)
  if (line.callback_query_id) await deps.answer(line.callback_query_id, text).catch(() => {})
  return r.ok ? { data, outcome: check.parsed.decision } : { data, outcome: 'refused', reason: r.reason }
}

export function callbacksFile(): string { return join(channelStateDir('telegram'), 'approval-callbacks.jsonl') }
export function offsetFile(): string { return join(STORE_DIR, 'approval-callbacks-offset.json') }

function readOffset(path: string): number {
  try { return Number(JSON.parse(readFileSync(path, 'utf-8')).offset) || 0 } catch { return 0 }
}
function writeOffset(offset: number, path: string): void {
  try { writeFileSync(path, JSON.stringify({ offset, at: Date.now() })) } catch (err) { logger.warn({ err }, 'approval-callbacks: offset not saved') }
}

/** One poll: read the lines appended since the saved byte offset, handle each, advance the offset. */
export async function pollApprovalCallbacks(
  file = callbacksFile(),
  ownerId: string | null = resolveOwnerChatId(),
  offsetPath = offsetFile(),
  deps?: Parameters<typeof handleCallbackLine>[2],
): Promise<CallbackOutcome[]> {
  if (!existsSync(file)) return []
  let offset = readOffset(offsetPath)
  const size = statSync(file).size
  if (size < offset) offset = 0 // rotated
  if (size === offset) return []
  const chunk = readFileSync(file, 'utf-8').slice(offset)
  const lastNl = chunk.lastIndexOf('\n')
  if (lastNl < 0) return [] // a partial line: wait for the newline
  const complete = chunk.slice(0, lastNl + 1)
  const outcomes: CallbackOutcome[] = []
  for (const raw of complete.split('\n')) {
    if (!raw.trim()) continue
    let line: CallbackLine
    try { line = JSON.parse(raw) as CallbackLine } catch { outcomes.push({ data: raw.slice(0, 40), outcome: 'malformed' }); continue }
    const o = await handleCallbackLine(line, ownerId, deps ?? {
      apply: (id, nonce, decision) => applyOwnerDecision(id, nonce, decision, undefined, 'button'),
      answer: (cb, text) => TELEGRAM_BOT_TOKEN ? answerTelegramCallbackQuery(TELEGRAM_BOT_TOKEN, cb, text) : Promise.resolve(false),
    })
    logger.info({ data: o.data, outcome: o.outcome, reason: o.reason }, 'approval-callbacks: owner button press handled')
    outcomes.push(o)
  }
  writeOffset(offset + Buffer.byteLength(complete, 'utf-8'), offsetPath)
  return outcomes
}

export function startApprovalCallbackWatcher(intervalMs = 2000): NodeJS.Timeout {
  const t = setInterval(() => { void pollApprovalCallbacks().catch((err) => logger.warn({ err }, 'approval-callbacks: poll failed')) }, intervalMs)
  t.unref?.()
  return t
}
