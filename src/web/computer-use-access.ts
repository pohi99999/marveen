// The computer-use `request_access` dialog, answered by the OWNER from Telegram (Péter GO 10142).
//
// In a Telegram-only session the dialog (pane-state.ts parseComputerUseAccessDialog) waits for a
// terminal click nobody makes; the channel is deaf meanwhile, and the generic menu recovery used
// to answer it with Escape, i.e. deny (2026-10-22 22:02:58). Here the dialog becomes an approval
// row (category computer_use_access) with Engedélyezem / Elutasítom buttons under a message to the
// owner, and the pane gets a keystroke ONLY after that row is decided:
//   - approved by the owner's button -> Down, re-read the pane, Enter only with the focus on
//     "Allow for this session" and the SAME grant (apps + flags) on screen;
//   - rejected, or no decision in CU_ACCESS_TIMEOUT_S -> Escape, which the dialog maps to deny;
//   - the dialog gone or changed meanwhile -> the row is cancelled, no keystroke;
//   - a shape the parser does not know (a new CLI version) -> no keystroke, a loud alert.
// The decision itself never passes through an agent: this category is button-only
// (telegram-approval.ts BUTTON_ONLY_CATEGORIES), so the approval-callbacks watcher -- the owner's
// from.id, as the patched plugin recorded it from the real Telegram update -- is the one path that
// can flip the row. The text command, the HTTP decision route and the dashboard PATCH refuse it.
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { logger } from '../logger.js'
import { CHANNEL_PROVIDER, TELEGRAM_BOT_TOKEN } from '../config.js'
import { createApproval, getApproval, resolveApproval, setApprovalTelegramMessageId, type Approval } from '../db.js'
import { resolveOwnerChatId } from '../owner-chat.js'
import { exactTmuxTarget } from '../tmux-target.js'
import { parseComputerUseAccessDialog, computerUseAccessSignature, type ComputerUseAccessDialog, type ComputerUseAccessParse } from '../pane-state.js'
import { sendTelegramMessage } from './telegram.js'
import { newApprovalNonce, buildCallbackData, OWNER_RESOLVER, COMPUTER_USE_ACCESS_CATEGORY } from './telegram-approval.js'

export const CU_ACCESS_TIMEOUT_S = 10 * 60
const UNKNOWN_ALERT_EVERY_MS = 15 * 60 * 1000
// The dialog drops input that arrives within 150 ms of mounting or of a refused key (2.1.306
// bundle: rH=150); these waits are well above that and give the TUI time to redraw.
const KEY_SETTLE_MS = 800
const CLOSE_SETTLE_MS = 1500

export interface CuAccessPending {
  label: string
  approvalId: string
  signature: string
  apps: string[]
  timeoutAt: number
}

export type CuAccessAction =
  | { kind: 'idle' }
  | { kind: 'request'; dialog: ComputerUseAccessDialog }
  | { kind: 'wait' }
  | { kind: 'allow' }
  | { kind: 'deny'; why: 'rejected' | 'timeout' | 'not-owner' }
  | { kind: 'cancel'; why: 'gone' | 'changed' | 'unknown-shape' }
  | { kind: 'unknown'; why: string }

/** Pure: what to do with one pane reading, given the pending request (if any) and its row. */
export function decideComputerUseAccess(
  pending: CuAccessPending | null,
  parse: ComputerUseAccessParse,
  row: Pick<Approval, 'status' | 'resolved_by'> | null,
  nowS: number,
): CuAccessAction {
  if (!pending) {
    if (parse.kind === 'dialog') return { kind: 'request', dialog: parse.dialog }
    if (parse.kind === 'unknown') return { kind: 'unknown', why: parse.why }
    return { kind: 'idle' }
  }
  if (parse.kind === 'none') return { kind: 'cancel', why: 'gone' }
  if (parse.kind === 'unknown') return { kind: 'cancel', why: 'unknown-shape' }
  if (computerUseAccessSignature(parse.dialog) !== pending.signature) return { kind: 'cancel', why: 'changed' }
  if (row?.status === 'approved') return row.resolved_by === OWNER_RESOLVER ? { kind: 'allow' } : { kind: 'deny', why: 'not-owner' }
  if (row?.status === 'rejected') return { kind: 'deny', why: 'rejected' }
  if (!row || row.status === 'timeout' || nowS >= pending.timeoutAt) return { kind: 'deny', why: 'timeout' }
  return { kind: 'wait' }
}

/** The owner's message. Plain text, proper accents: outgoing copy. */
export function buildComputerUseAccessText(label: string, d: ComputerUseAccessDialog, timeoutAt: number): string {
  const lines = [
    `🖥️ ${label}: a Computer Use engedélyt kér ezekhez az appokhoz (csak erre a munkamenetre):`,
    ...d.apps.map((a) => `• ${a}`),
  ]
  if (d.alsoRequested.length) lines.push(`Ezzel együtt: ${d.alsoRequested.join(', ')}`)
  if (d.notShown) lines.push(`(${d.notShown} további app nem látszik, azok NEM kapnak engedélyt.)`)
  if (d.willHide) lines.push(`Munka közben ${d.willHide} másik app el lesz rejtve.`)
  lines.push(`Ha ${Math.round(CU_ACCESS_TIMEOUT_S / 60)} percen belül nem döntesz, elutasítom. Lejárat: ${new Date(timeoutAt * 1000).toLocaleTimeString('hu-HU', { hour: '2-digit', minute: '2-digit' })}.`)
  return lines.join('\n')
}

export function computerUseAccessKeyboard(approvalId: string, nonce: string): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: [[
      { text: 'Engedélyezem', callback_data: buildCallbackData(approvalId, nonce, 'approved') },
      { text: 'Elutasítom', callback_data: buildCallbackData(approvalId, nonce, 'rejected') },
    ]],
  }
}

export interface CuAccessDeps {
  capture: (session: string) => string | null
  sendKey: (session: string, key: 'Down' | 'Enter' | 'Escape') => void
  sleep: (ms: number) => Promise<void>
  /** Create the row and ask the owner; null when the owner cannot be asked. */
  createRequest: (label: string, d: ComputerUseAccessDialog, timeoutAt: number) => Promise<string | null>
  getRow: (id: string) => Pick<Approval, 'status' | 'resolved_by'> | null
  /** Close a row nobody decided (dialog gone/changed, or timed out). */
  closeRow: (id: string) => void
  alert: (text: string) => void
  nowMs: () => number
}

export class ComputerUseAccessGuard {
  private pending = new Map<string, CuAccessPending>()
  private unknownAlertedAt = new Map<string, number>()
  private busy = new Set<string>()

  constructor(private deps: CuAccessDeps) {}

  hasPending(session: string): boolean { return this.pending.has(session) }
  pendingSessions(): Array<[session: string, label: string]> { return [...this.pending].map(([s, p]) => [s, p.label]) }

  /**
   * One look at a session. Returns true when the pane is this dialog (or a request for it is
   * still open), so the caller must NOT apply its generic menu recovery to it.
   */
  async tick(session: string, label: string, paneIn?: string | null): Promise<boolean> {
    if (this.busy.has(session)) return true
    this.busy.add(session)
    try {
      const pane = paneIn === undefined ? this.deps.capture(session) : paneIn
      const parse: ComputerUseAccessParse = pane == null ? { kind: 'none' } : parseComputerUseAccessDialog(pane)
      const pending = this.pending.get(session) ?? null
      const row = pending ? this.deps.getRow(pending.approvalId) : null
      const nowMs = this.deps.nowMs()
      const action = decideComputerUseAccess(pending, parse, row, Math.floor(nowMs / 1000))
      switch (action.kind) {
        case 'idle':
          this.unknownAlertedAt.delete(session)
          return false
        case 'wait':
          return true
        case 'unknown': {
          const last = this.unknownAlertedAt.get(session)
          if (last == null || nowMs - last >= UNKNOWN_ALERT_EVERY_MS) {
            this.unknownAlertedAt.set(session, nowMs)
            logger.warn({ session, why: action.why }, 'computer-use access dialog in an unrecognised shape -- NO keystrokes sent')
            this.deps.alert(`🛑 A(z) ${label} session egy Computer Use engedélykérésen áll, de a dialógus alakját nem ismerem fel (${action.why}), ezért NEM nyomtam meg semmit. Döntsd el kézzel: tmux attach -t ${session}`)
          }
          return true
        }
        case 'request': {
          const timeoutAt = Math.floor(nowMs / 1000) + CU_ACCESS_TIMEOUT_S
          const id = await this.deps.createRequest(label, action.dialog, timeoutAt)
          if (!id) {
            // Nobody can be asked: deny now rather than keep the channel deaf for the whole window.
            logger.warn({ session }, 'computer-use access: the owner could not be asked -- denying')
            await this.answerDeny(session, label, null)
            return true
          }
          this.pending.set(session, { label, approvalId: id, signature: computerUseAccessSignature(action.dialog), apps: action.dialog.apps, timeoutAt })
          logger.info({ session, approvalId: id, apps: action.dialog.apps }, 'computer-use access: owner asked on Telegram, waiting for the button')
          return true
        }
        case 'cancel': {
          const p = pending!
          this.pending.delete(session)
          this.deps.closeRow(p.approvalId)
          logger.warn({ session, approvalId: p.approvalId, why: action.why }, 'computer-use access: dialog gone or changed before the decision -- request closed, no keystroke')
          if (action.why !== 'gone') this.deps.alert(`⚠️ A(z) ${label} Computer Use engedélykérése megváltozott, mielőtt döntöttél volna (${action.why === 'changed' ? 'más appok' : 'ismeretlen alak'}). A korábbi gombok érvénytelenek, billentyűt nem küldtem.`)
          return parse.kind !== 'none'
        }
        case 'allow':
          this.pending.delete(session)
          await this.answerAllow(session, label, pending!)
          return true
        case 'deny':
          this.pending.delete(session)
          if (action.why !== 'rejected') this.deps.closeRow(pending!.approvalId)
          await this.answerDeny(session, label, action.why)
          return true
      }
    } finally {
      this.busy.delete(session)
    }
  }

  private async answerAllow(session: string, label: string, p: CuAccessPending): Promise<void> {
    let now = parseComputerUseAccessDialog(this.deps.capture(session) ?? '')
    if (now.kind === 'dialog' && computerUseAccessSignature(now.dialog) === p.signature && now.dialog.focus === 'deny') {
      this.deps.sendKey(session, 'Down')
      await this.deps.sleep(KEY_SETTLE_MS)
      now = parseComputerUseAccessDialog(this.deps.capture(session) ?? '')
    }
    if (now.kind !== 'dialog' || computerUseAccessSignature(now.dialog) !== p.signature || now.dialog.focus !== 'allow') {
      logger.warn({ session, approvalId: p.approvalId, seen: now.kind }, 'computer-use access: focus not on Allow after Down -- NO Enter sent')
      this.deps.alert(`🛑 Jóváhagytad a(z) ${label} Computer Use kérését (${p.apps.join(', ')}), de a fókusz nem állt az "Allow for this session" soron, ezért Entert NEM küldtem. Döntsd el kézzel: tmux attach -t ${session}`)
      return
    }
    this.deps.sendKey(session, 'Enter')
    await this.deps.sleep(CLOSE_SETTLE_MS)
    const after = parseComputerUseAccessDialog(this.deps.capture(session) ?? '')
    if (after.kind !== 'none') {
      logger.warn({ session, approvalId: p.approvalId }, 'computer-use access: dialog still up after Enter')
      this.deps.alert(`⚠️ A(z) ${label} Computer Use dialógusa az Enter után is látszik. Nézd meg: tmux attach -t ${session}`)
      return
    }
    logger.info({ session, approvalId: p.approvalId, apps: p.apps }, 'computer-use access: allowed on the owner\'s button')
    this.deps.alert(`✅ Engedélyezve erre a munkamenetre: ${p.apps.join(', ')}.`)
  }

  private async answerDeny(session: string, label: string, why: 'rejected' | 'timeout' | 'not-owner' | null): Promise<void> {
    // Escape is the dialog's own cancel, mapped to deny (onCancel -> deny in 2.1.306); re-checked
    // first, so a pane that already moved on gets no key at all.
    if (parseComputerUseAccessDialog(this.deps.capture(session) ?? '').kind !== 'dialog') return
    this.deps.sendKey(session, 'Escape')
    await this.deps.sleep(CLOSE_SETTLE_MS)
    const gone = parseComputerUseAccessDialog(this.deps.capture(session) ?? '').kind === 'none'
    logger.info({ session, why, gone }, 'computer-use access: denied')
    const reason = why === 'rejected' ? 'elutasítottad' : why === 'timeout' ? `${Math.round(CU_ACCESS_TIMEOUT_S / 60)} percen belül nem jött döntés` : why === 'not-owner' ? 'nem a te gombod döntött' : 'nem tudtalak megkérdezni'
    this.deps.alert(gone
      ? `🚫 A(z) ${label} Computer Use kérését elutasítottam (${reason}).`
      : `⚠️ A(z) ${label} Computer Use kérését elutasítottam volna (${reason}), de a dialógus az Escape után is látszik. Nézd meg: tmux attach -t ${session}`)
  }
}

// --- live wiring ----------------------------------------------------------

async function askOwner(label: string, d: ComputerUseAccessDialog, timeoutAt: number): Promise<string | null> {
  if (CHANNEL_PROVIDER !== 'telegram' || !TELEGRAM_BOT_TOKEN) return null
  const ownerChat = resolveOwnerChatId()
  if (!ownerChat) return null
  const id = randomUUID()
  const nonce = newApprovalNonce()
  createApproval({
    id,
    agent_id: label,
    category: COMPUTER_USE_ACCESS_CATEGORY,
    action_description: `Computer Use: ${d.apps.join(', ')}${d.alsoRequested.length ? ` + ${d.alsoRequested.join(', ')}` : ''}`,
    action_payload: JSON.stringify(d),
    timeout_at: timeoutAt,
    owner_nonce: nonce,
  })
  try {
    const messageId = await sendTelegramMessage(TELEGRAM_BOT_TOKEN, ownerChat, buildComputerUseAccessText(label, d, timeoutAt), { reply_markup: computerUseAccessKeyboard(id, nonce) })
    if (messageId != null) setApprovalTelegramMessageId(id, messageId)
    return id
  } catch (err) {
    logger.warn({ err, id }, 'computer-use access: owner message FAILED')
    resolveApproval(id, 'timeout', 'computer-use-guard')
    return null
  }
}

export function liveComputerUseAccessDeps(capture: (session: string) => string | null, tmuxBin: () => string, alert: (text: string) => void): CuAccessDeps {
  return {
    capture,
    // Piped stderr: a vanished session's tmux error must not land on the dashboard's stderr (TMUXWINDOWATTR920).
    sendKey: (session, key) => { execFileSync(tmuxBin(), ['send-keys', '-t', exactTmuxTarget(session), key], { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }) },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    createRequest: askOwner,
    getRow: (id) => getApproval(id) ?? null,
    closeRow: (id) => { resolveApproval(id, 'timeout', 'computer-use-guard') },
    alert,
    nowMs: () => Date.now(),
  }
}
