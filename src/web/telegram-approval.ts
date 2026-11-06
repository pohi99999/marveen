// Owner decisions on approvals from Telegram, decided on the SERVER (card 3558, Péter 7913).
//
// Two entry points, one resolver: the inline buttons under the owner notification (callback_data
// carries the approval id, its nonce and the decision) and the owner's `/approvals <n> approve|reject
// <nonce>` command. Neither path lets an agent turn an owner's text into an approval: the decision
// is taken here from identity Telegram itself asserts (callback_query.from.id, or the owner chat the
// command dispatcher already verifies) plus the per-approval nonce only the owner's message carries.
import { randomBytes } from 'node:crypto'
import type { Approval } from '../db.js'
import { APP_TZ } from '../config.js'

export const OWNER_RESOLVER = 'telegram-owner'
export const CALLBACK_PREFIX = 'apr'
export type OwnerDecision = 'approved' | 'rejected'

// A category decided ONLY by the owner's button press as the patched plugin recorded it
// (approval-callbacks.jsonl): not by the /approvals text command, not by the HTTP decision route
// (its from_id is whatever the caller sends), not by the dashboard PATCH, and its nonce is never
// served by the GET routes. computer_use_access: a yes there sends a keystroke that grants an app
// to the main session (computer-use-access.ts).
export const COMPUTER_USE_ACCESS_CATEGORY = 'computer_use_access'
export const BUTTON_ONLY_CATEGORIES: ReadonlySet<string> = new Set([COMPUTER_USE_ACCESS_CATEGORY])
export function isButtonOnlyCategory(category: string | null | undefined): boolean {
  return typeof category === 'string' && BUTTON_ONLY_CATEGORIES.has(category)
}
/** Which Telegram path a decision came through. */
export type OwnerDecisionVia = 'button' | 'command' | 'http'

/** 8 url-safe chars: short enough to type, 47 bits against a guess inside the window. */
export function newApprovalNonce(bytes = 6): string {
  return randomBytes(bytes).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).padEnd(8, 'x')
}

/** `apr:<id>:<nonce>:a|r`; Telegram caps callback_data at 64 bytes, our ids (uuid, 36) + nonce (8) fit. */
export function buildCallbackData(approvalId: string, nonce: string, decision: OwnerDecision): string {
  const d = `${CALLBACK_PREFIX}:${approvalId}:${nonce}:${decision === 'approved' ? 'a' : 'r'}`
  if (Buffer.byteLength(d) > 64) throw new Error('callback_data over 64 bytes')
  return d
}

export interface ParsedCallback { approvalId: string; nonce: string; decision: OwnerDecision }

export function parseCallbackData(data: string | null | undefined): ParsedCallback | null {
  if (typeof data !== 'string') return null
  const m = /^apr:([0-9a-fA-F-]{8,36}):([A-Za-z0-9]{6,16}):([ar])$/.exec(data)
  if (!m) return null
  return { approvalId: m[1], nonce: m[2], decision: m[3] === 'a' ? 'approved' : 'rejected' }
}

export type OwnerCheck =
  | { ok: true; parsed: ParsedCallback }
  | { ok: false; reason: 'malformed' | 'not-owner' | 'no-owner-configured' }

/** Identity first: only the configured owner's Telegram user id may decide; everything else is ignored. */
export function checkOwnerCallback(data: string | null | undefined, fromId: number | string | null | undefined, ownerId: string | null): OwnerCheck {
  const parsed = parseCallbackData(data)
  if (!parsed) return { ok: false, reason: 'malformed' }
  if (!ownerId) return { ok: false, reason: 'no-owner-configured' }
  if (fromId == null || String(fromId) !== String(ownerId)) return { ok: false, reason: 'not-owner' }
  return { ok: true, parsed }
}

export type ResolveRefusal = 'not_found' | 'wrong_nonce' | 'already_resolved' | 'expired' | 'no_nonce'

/** The state check the resolver applies, pure for the tests: pending, nonce matches, inside the window. */
export function resolvableByOwner(a: Pick<Approval, 'status' | 'timeout_at'> & { owner_nonce?: string | null } | undefined, nonce: string, nowS: number): ResolveRefusal | null {
  if (!a) return 'not_found'
  if (!a.owner_nonce) return 'no_nonce'
  if (a.owner_nonce !== nonce) return 'wrong_nonce'
  if (a.status !== 'pending') return 'already_resolved'
  if (a.timeout_at != null && a.timeout_at <= nowS) return 'expired'
  return null
}

/** The inline keyboard under the owner notification. */
export function ownerApprovalKeyboard(approvalId: string, nonce: string): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: [[
      { text: 'Jóváhagyom', callback_data: buildCallbackData(approvalId, nonce, 'approved') },
      { text: 'Elutasítom', callback_data: buildCallbackData(approvalId, nonce, 'rejected') },
    ]],
  }
}

/** The letter's summary for the owner: recipients, subject, attachments, the anchor's head. */
export function emailSummaryLines(a: Approval): string[] {
  const lines: string[] = []
  let p: Record<string, unknown> = {}
  if (a.action_payload) { try { p = JSON.parse(a.action_payload) as Record<string, unknown> } catch { /* raw */ } }
  const list = (v: unknown) => Array.isArray(v) ? v.map(String) : typeof v === 'string' && v ? [v] : []
  const to = [...list(p.to), ...list(p.recipients)]; const cc = list(p.cc); const bcc = list(p.bcc)
  if (to.length || cc.length || bcc.length) {
    lines.push(`Címzett: ${to.join(', ') || '-'}${cc.length ? ` | cc: ${cc.join(', ')}` : ''}${bcc.length ? ` | bcc: ${bcc.join(', ')}` : ''}`)
  }
  if (typeof p.subject === 'string' && p.subject) lines.push(`Tárgy: ${p.subject}`)
  const atts = Array.isArray(p.attachments) ? p.attachments : []
  if (atts.length) lines.push(`Csatolmány: ${atts.map((x) => (x && typeof x === 'object' && 'name' in x ? String((x as { name: unknown }).name) : String(x))).join(', ')}`)
  if (a.content_hash) lines.push(`Horgony: ${a.content_hash.slice(0, 12)}...`)
  return lines
}

export function decisionText(a: Approval, decision: OwnerDecision, when: Date): string {
  const stamp = when.toLocaleString('hu-HU', { timeZone: APP_TZ })
  return `${decision === 'approved' ? 'JÓVÁHAGYVA' : 'ELUTASÍTVA'} Telegramon, ${stamp} (id: ${a.id})`
}
