// When a new approval request replaces an older one, the older one must not stay open with live Telegram buttons: on
// 2026-11-05 two buttons were open at once, and the owner's "approved" could be read as either. "The same subject" is
// deliberately narrow, because closing a request by mistake loses a decision the owner still owes: same agent, same
// category, and for a mail the same recipients and subject (its body is what changes), otherwise the same description.
// Anything looser goes through the explicit `supersedes` field.
import type { Approval } from '../db.js'

function emailKey(a: Approval): string | null {
  if (!a.action_payload) return null
  let p: Record<string, unknown>
  try { p = JSON.parse(a.action_payload) as Record<string, unknown> } catch { return null }
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : [])
  const to = [...list(p.to), ...list(p.recipients)].map((x) => x.trim().toLowerCase()).filter(Boolean).sort()
  const subject = typeof p.subject === 'string' ? p.subject.trim().toLowerCase() : ''
  return to.length && subject ? `mail:${to.join(',')}|${subject}` : null
}

export function approvalSubjectKey(a: Approval): string {
  const mail = a.category === 'email_send' ? emailKey(a) : null
  return mail ?? `text:${a.action_description.trim().replace(/\s+/g, ' ').toLowerCase()}`
}

/** The open requests the new one replaces: never another agent's or category's, never the new one itself. */
export function supersededApprovals(next: Approval, pending: readonly Approval[], explicitId: string | null): Approval[] {
  const key = approvalSubjectKey(next)
  return pending.filter((a) => a.id !== next.id && a.status === 'pending' && a.agent_id === next.agent_id
    && (a.id === explicitId || (a.category === next.category && approvalSubjectKey(a) === key)))
}

export const supersededResolver = (nextId: string): string => `superseded:${nextId}`
export const SUPERSEDED_NOTE = 'Lezárva: egy újabb kérés váltotta fel. Ez a gomb már nem él, az új üzenetben döntsön.'
