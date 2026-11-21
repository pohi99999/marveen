import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { PROJECT_ROOT, MAIN_AGENT_ID, TELEGRAM_BOT_TOKEN, CHANNEL_PROVIDER, CHANNEL_TOKEN, DASHBOARD_PUBLIC_URL, WEB_PORT } from '../../config.js'
import {
  consumeApproval, consumeCategoryApproval,
  CATEGORY_CONSUME_DEFAULT_WINDOW_S, CATEGORY_CONSUME_MAX_WINDOW_S,
  createApproval, getApproval, resolveApproval, listApprovals, expireTimedOutApprovals,
  createAgentMessage, setApprovalTelegramMessageId, resolveApprovalByOwner, decideApproval,
  HASH_BOUND_APPROVAL_CATEGORIES, OWNER_BUTTON_HASH_HEAD_LEN,
  type Approval,
} from '../../db.js'
import { logger } from '../../logger.js'
import { readBody, readBodyOrRefuse, json } from '../http-helpers.js'
import { approvalGranteeOf, approvalNotGrantedReason, identityDenialBody } from '../auth-gate.js'
import { ownerAlertChatOverride, resolveOwnerChatId } from '../../owner-chat.js'
import { sendOwnerMessage, sendOwnerSlackDm, slackTargetFor, noticeTargetDrift } from '../../notify.js'
import { getEffectiveSettingValue } from '../../settings-store.js'
import { mainBotToken, ownerDmVerdict, SLACK_CHUNK } from '../../slack-notify.js'
import { reactionRoute, reactionsOn, repliesOn, dashboardOnlyLine, postReactionPrompt, startApprovalSlackSweeper, type RouteDeps } from '../approval-slack-route.js'
import { OWNER_TEXT, formatExpiry, type ApprovalLang } from '../approval-texts.js'
import { approvalTextLang } from '../agent-text-lang.js'
import { sendTelegramMessage, editTelegramMessageText } from '../telegram.js'
import { sendWithRetry, type RetryDeps } from '../approval-notify-retry.js'
import { newApprovalNonce, ownerApprovalKeyboard, emailSummaryLines, decisionText, OWNER_RESOLVER, namesOwnerResolver, isButtonOnlyCategory, type OwnerDecision, type OwnerDecisionVia } from '../telegram-approval.js'
import { teamsCardRoute, teamsCardsOn, postApprovalCard, handleTeamsCardAction, type TeamsCardDeps } from '../approval-teams-card.js'
import { sendTeamsMessage } from '../../teams-send.js'
import { readTeamsCreds, channelStateDir } from '../../channel-provider.js'
import { mayActAsOwner, OWNER_SESSION_REQUIRED, refuseOwner } from './auth.js'
import { supersededApprovals, supersededResolver, SUPERSEDED_NOTE } from '../approval-supersede.js'
import type { RouteContext } from './types.js'
import { fileAgentSpecRequest } from '../agent-create-approval.js'
import { fileScheduleCommandRequest, SCHEDULE_COMMAND_CATEGORY } from '../schedule-command-approval.js'
import { readVaultAcl, isAgentReadableDecodedVaultId, claimedAgentOf } from '../vault-acl.js'

// Kanban 80d0e3c6: APPROVING is the owner's decision, so the two routes that make a row approved
// (the born-approved POST and PATCH status=approved) take an owner credential. Measured before:
// a caller with the shared token (every agent holds it) got an approved row on both routes, and
// the real email-approval-gate then let its letter through; through STANDING_CATEGORY the same
// row made every later letter to an address approval-free. The self-declared agent_id and
// resolved_by checks below stay, but they were never what stopped this.
// Who counts as the owner is the owner gate (mayActAsOwner, #2163): the owner's session, also when
// the browser sends the stored token alongside it; the bare token never, not even before the first
// dashboard login exists (OWNERGATE4-1104: every agent holds it, and could approve its own request).
// With no login yet, refuseOwner answers setup_required and says to create one.
const OWNER_ONLY = {
  ...OWNER_SESSION_REQUIRED,
  error: 'Approving needs the dashboard login (an owner session); the shared dashboard token can file, reject or time out a request, not approve one.',
}

const AUTONOMY_CONFIG_PATH = join(PROJECT_ROOT, 'store', 'autonomy-config.json')

// APPROVALVAK821: a pending approval with timeout_at NULL can never reach the
// 'timeout' status -- the sweeper's WHERE clause skips it forever, so an
// unanswered request leaves the asking agent polling into eternity. No
// category carried timeout_minutes in any real install, which made the state
// STRUCTURALLY unreachable. Every request therefore gets a timeout: the
// caller's explicit timeout_seconds wins, then the category's
// timeout_minutes, then this default.
export const DEFAULT_TIMEOUT_MINUTES = 1440
// Cap: a timeout past a week is indistinguishable from the old "never".
export const MAX_TIMEOUT_SECONDS = 7 * 24 * 3600

function readCategoryTimeoutMinutes(category: string): number | null {
  try {
    if (!existsSync(AUTONOMY_CONFIG_PATH)) return null
    const config = JSON.parse(readFileSync(AUTONOMY_CONFIG_PATH, 'utf-8')) as {
      categories: { key: string; timeout_minutes?: number | null }[]
    }
    const cat = config.categories.find(c => c.key === category)
    if (!cat || cat.timeout_minutes == null) return null
    return cat.timeout_minutes
  } catch {
    return null
  }
}

// Pure + exported for tests. `timeoutSeconds` is the request-body value as
// received (unknown): the scaffolded agent instructions have always told
// agents to send timeout_seconds, but the old handler never read it.
export function computeTimeoutAt(category: string, timeoutSeconds: unknown, nowMs: number = Date.now()): number {
  const now = Math.floor(nowMs / 1000)
  if (typeof timeoutSeconds === 'number' && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) {
    return now + Math.min(Math.floor(timeoutSeconds), MAX_TIMEOUT_SECONDS)
  }
  const catMinutes = readCategoryTimeoutMinutes(category)
  if (catMinutes != null && catMinutes > 0) return now + catMinutes * 60
  return now + DEFAULT_TIMEOUT_MINUTES * 60
}

// f2c5edb0: the window inside which an approved letter may still be consumed,
// counted from resolved_at. The SAME fixed value as the gate (APPROVAL_WINDOW_S
// in scripts/hooks/email-approval-gate.py; a test pins the two), so the two
// consume paths agree on when an approval has gone stale. No environment
// override on either side (ENVRELAXGATE1104): the hook cannot see the
// dashboard's launch environment, so an override here would split the two.
export const APPROVAL_WINDOW_S = 1800
export function approvalWindowSeconds(): number {
  return APPROVAL_WINDOW_S
}

// The consumer names the sending tool in the audit trail. Printable only (no
// control characters, checked by code point so the source carries no escape),
// 1-120 characters after trimming.
export function isConsumerName(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const t = v.trim()
  if (t.length < 1 || t.length > 120) return false
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    if (c < 32 || c === 127) return false
  }
  return true
}

// One RFC 5322 msg-id, angle brackets included: the sender generates it BEFORE
// the send and hands the same value to its mailer, so the approval row names the
// letter that used it.
export function isMessageId(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 250 && /^<[^<>\s@]+@[^<>\s@]+>$/.test(v)
}

// A category key as the autonomy config spells them (email_send, data_delete,
// external_message): lower-case ASCII letter first, then letters, digits, underscore.
export function isCategoryKey(v: unknown): v is string {
  return typeof v === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(v)
}

// What the acting tool names as the thing that used the approval (a plan id,
// a change-list id). Printable, 1-250 characters after trimming.
export function isConsumeRef(v: unknown): v is string {
  if (typeof v !== 'string') return false
  const t = v.trim()
  if (t.length < 1 || t.length > 250) return false
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i)
    if (c < 32 || c === 127) return false
  }
  return true
}

// for_agent names one fleet agent. Same alphabet as sanitizeAgentIdent
// (prompt-safety.ts) and the 64-char cap of the X-Agent-Id claim, so the stored
// value is exactly what an agent token resolves to.
export function isForAgentName(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
}

// The window the acting tool asks for, in seconds. Absent = the default;
// anything else must be a whole number inside 1..cap, or the call is refused
// (400) rather than silently clamped, so a tool learns its policy is not what
// it thinks.
export function categoryWindowSeconds(v: unknown): number | null {
  if (v === undefined || v === null) return CATEGORY_CONSUME_DEFAULT_WINDOW_S
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 1 || v > CATEGORY_CONSUME_MAX_WINDOW_S) return null
  return v
}

// The dashboard's Approvals page as the BROWSER reaches it (DASHBOARD_PUBLIC_URL, else this host's port), for the
// owner's message (APPROVALSLACK1030: the decision is one tap away). Exported for tests.
export function approvalsPageUrl(publicUrl: string = DASHBOARD_PUBLIC_URL, port: number = WEB_PORT): string {
  return `${publicUrl.trim().replace(/\/+$/, '') || `http://localhost:${port}`}/#approvals`
}

// Owner-facing text (Slack DM or the channel provider). Pure + exported for
// tests. Plain text (no markdown escaping concerns), proper accents: this is
// outgoing copy.
// APPROVALTAGEN1108 (upstream): in [lang] (approval-texts.ts), the install's AGENT_TEXT_LANG by default (hu).
// Fork card 3558 stays: the e-mail summary, and the Telegram decision line with this approval's nonce.
export function ownerDecisionLine(nonce: string, lang: ApprovalLang): string {
  return lang === 'en'
    ? `Decide: with the buttons below, or: /approvals <n> approve|reject ${nonce} (n: the number in the /approvals list)`
    : `Döntés: a gombokkal lent, vagy: /approvals <n> approve|reject ${nonce} (n: a sorszám a /approvals listában)`
}
export function buildOwnerApprovalText(approval: Approval, lang: ApprovalLang = approvalTextLang()): string {
  const t = OWNER_TEXT[lang]
  const lines = [
    `${t.requestTag} ${approval.agent_id} | ${approval.category}`,
    approval.action_description,
    ...(approval.category === 'email_send' ? emailSummaryLines(approval) : []),
    `${t.expires}: ${formatExpiry(approval.timeout_at, lang)}`,
  ]
  if (approval.owner_nonce) lines.push(ownerDecisionLine(approval.owner_nonce, lang))
  lines.push(t.decideOnDashboard(approval.id), approvalsPageUrl())
  return lines.join('\n')
}

// Card 3558: ONE server-side resolution for every Telegram entry point (button callback, /approvals
// command). Identity and nonce are checked by the caller's path (callback: from.id == owner; command:
// the dispatcher's owner-chat + write-evidence gates); the state check and the write are one
// conditional UPDATE in the DB. The notification is rewritten with the outcome, best effort.
export type OwnerDecisionResult =
  | { ok: true; approval: Approval }
  | { ok: false; reason: 'not_found' | 'no_nonce' | 'wrong_nonce' | 'already_resolved' | 'expired' | 'button_only' | 'content_changed'; approval?: Approval }
export function applyOwnerDecision(id: string, nonce: string, decision: OwnerDecision, nowS = Math.floor(Date.now() / 1000), via: OwnerDecisionVia = 'command', hashHead?: string): OwnerDecisionResult {
  if (via !== 'button') {
    const target = getApproval(id)
    // SCHEDCMDAPPROVAL1121: a hash-bound request (agent_create, schedule_command) is decided on Telegram by its button
    // only: the button carries the head of the content hash its message showed, a typed command does not.
    if (target && (isButtonOnlyCategory(target.category) || HASH_BOUND_APPROVAL_CATEGORIES.has(target.category))) {
      logger.warn({ id, category: target.category, via }, 'owner decision refused: this category is decided by the Telegram button only')
      return { ok: false, reason: 'button_only', approval: target }
    }
  }
  // A hash-bound request goes through the decision core with the hash head the button carried, and its consumer runs.
  const r = resolveApprovalByOwner({ id, nonce, decision, resolvedBy: OWNER_RESOLVER, nowS, shownHashHead: hashHead })
  if (r.ok) {
    logger.info({ id, decision, resolved_by: OWNER_RESOLVER }, 'Approval resolved by the owner on Telegram')
    const a = r.approval
    if (TELEGRAM_BOT_TOKEN && a.telegram_message_id != null) {
      const ownerChat = resolveOwnerChatId()
      if (ownerChat) {
        void editTelegramMessageText(TELEGRAM_BOT_TOKEN, ownerChat, a.telegram_message_id, `${buildOwnerApprovalText(a)}\n\n${decisionText(a, decision, new Date(nowS * 1000))}`)
          .catch((err) => logger.warn({ err, id }, 'approval decision: notification rewrite failed (decision is saved)'))
      }
    }
  }
  return r
}

// A new request closes the older open one on the same subject, so the owner never has two live buttons for one decision.
// A late press on the old button gets "already resolved"; the agent polling it sees rejected and who replaced it.
function closeSupersededApprovals(next: Approval, explicitId: string | null): void {
  const pending = listApprovals({ agent_id: next.agent_id, status: 'pending', limit: 500 })
  for (const old of supersededApprovals(next, pending, explicitId)) {
    if (!resolveApproval(old.id, 'rejected', supersededResolver(next.id))) continue
    logger.info({ id: old.id, supersededBy: next.id }, 'Approval closed: a newer request replaced it')
    if (TELEGRAM_BOT_TOKEN && old.telegram_message_id != null) {
      const ownerChat = resolveOwnerChatId()
      if (ownerChat) {
        void editTelegramMessageText(TELEGRAM_BOT_TOKEN, ownerChat, old.telegram_message_id, `${buildOwnerApprovalText(old)}\n\n${SUPERSEDED_NOTE}`)
          .catch((err) => logger.warn({ err, id: old.id }, 'superseded approval: notification rewrite failed (the row is closed)'))
      }
    }
  }
}

// The nonce goes to the owner in the Telegram message and nowhere else: no API answer carries it, for any category.
export function redactOwnerNonce<T extends Pick<Approval, 'owner_nonce'> | undefined>(a: T): T {
  return a?.owner_nonce ? ({ ...a, owner_nonce: null } as T) : a
}

export function ownerDecisionRefusalText(reason: string): string {
  switch (reason) {
    case 'not_found': return 'Nincs ilyen jóváhagyás.'
    case 'no_nonce': return 'Ehhez a jóváhagyáshoz nincs Telegram-kód; a dashboardon dönthető el.'
    case 'wrong_nonce': return 'A kód nem ehhez a jóváhagyáshoz tartozik; nem változtattam semmit.'
    case 'already_resolved': return 'Ez a jóváhagyás már eldőlt; nem változtattam semmit.'
    case 'expired': return 'Ez a jóváhagyás lejárt; nem változtattam semmit.'
    case 'button_only': return 'Ezt csak a Telegram-üzenet gombjával lehet eldönteni; nem változtattam semmit.'
    case 'content_changed': return 'A gomb nem ehhez a tartalomhoz tartozik (az ellenőrző kód nem egyezik); nem változtattam semmit.'
    default: return 'Nem sikerült feloldani; nem változtattam semmit.'
  }
}

// The informative variant, for a row the owner already approved in the chat
// before it was filed. Pure + exported for tests. It must NOT read as a
// question -- the owner answering "mehet" a second time to a done deal is
// exactly the noise this replaces -- but it keeps the action visible in the
// owner's chat.
export function buildOwnerChatApprovedText(approval: Approval, ownerMessageId: number | string, lang: ApprovalLang = approvalTextLang()): string {
  const t = OWNER_TEXT[lang]
  return [
    `${t.chatApprovedTag} ${approval.agent_id} | ${approval.category}`,
    approval.action_description,
    t.chatApprovedBy(String(ownerMessageId)),
    t.nothingToDo,
    t.logOnDashboard(approval.id),
  ].join('\n')
}

// When the owner send is suppressed or fails AND the requester is the main
// agent, there is no in-band signal left at all: the leg-2 short-circuit
// below skips the main-agent message unconditionally. The old self-notify was
// useless but VISIBLE -- losing even that would rebuild the closed loop this
// card documents, one layer deeper (Marveen's review finding on #1026).
// Everyone else already got the normal main-agent notify, so the fallback is
// main-requester-only. The marker names the reason so the reader knows this
// is a degraded delivery, not the normal path.
function fallbackInBand(approval: Approval, reason: string): void {
  if (approval.agent_id !== MAIN_AGENT_ID) return
  try {
    const content = [
      `[APPROVAL_REQUEST][OWNER_UNREACHED ${reason}]`,
      `id=${approval.id}`,
      `agent=${approval.agent_id}`,
      `category=${approval.category}`,
      `action=${approval.action_description}`,
      `timeout_at=${approval.timeout_at ?? 'null'}`,
    ].join(' ')
    createAgentMessage('system', MAIN_AGENT_ID, content)
  } catch (err) {
    logger.warn({ err, approvalId: approval.id }, 'approval in-band fallback failed too -- the request is only visible on the dashboard')
  }
}

// APPROVALVAK821 (a) -- the request must reach the OWNER, not only the main
// agent's inter-agent queue. Fire-and-forget on purpose: the POST response
// must not wait on the Telegram round-trip, and a failed send must not fail
// the request -- but it must be LOUD in the logs, because a silently
// undelivered approval is exactly the closed loop this fixes.
//
// With `chatApprovedMessageId` set, the row is already approved (the owner said
// yes in that chat message) and the owner gets the informative note instead of
// the question. Two things differ on that path: the note's own message id is
// NOT stamped (telegram_message_id already names the owner's approving
// message), and a failed note does NOT fall back in-band -- the only requester
// allowed on this path is the main agent, which already knows the action is
// approved; an [APPROVAL_REQUEST] marker would mislead it.
// APPROVALSLACK1030 (2): what the reaction path reads, in one place (tests replace it).
export const reactionDeps: RouteDeps = {
  setting: (key) => String(getEffectiveSettingValue(key) ?? ''),
  token: () => mainBotToken(),
  ownerTarget: async () => (await slackTargetFor('owner')) || '',
  verdict: (channel, owner) => ownerDmVerdict(channel, owner),
  drift: (current) => noticeTargetDrift(current),
  chunk: SLACK_CHUNK,
  lang: () => approvalTextLang(),
}

// TEAMSAPPROVECARD1118: what the Teams approval card reads, in one place (tests replace it).
export const teamsCardDeps: TeamsCardDeps = {
  setting: (key) => String(getEffectiveSettingValue(key) ?? ''),
  creds: () => (CHANNEL_PROVIDER === 'teams' && CHANNEL_TOKEN ? readTeamsCreds(CHANNEL_TOKEN) : null),
  stateDir: () => channelStateDir('teams'),
  send: sendTeamsMessage,
  alert: (text) => { void sendOwnerMessage(text) },
}

// APPROVALNOTIFYRETRY1118: the re-send route's brake, per request. The route puts a message in front of the owner, so
// a caller in a loop must not be able to fill the owner's chat: one attempt in RESEND_MIN_GAP_MS whatever came of it,
// and RESEND_MAX_SENT delivered re-sends for one request. In memory: a restart forgets it, and a request lives for
// hours at most.
export const RESEND_MIN_GAP_MS = 30_000
export const RESEND_MAX_SENT = 5
const resendLog = new Map<string, { lastAt: number; sent: number }>()

function noteResent(id: string): void {
  const seen = resendLog.get(id)
  if (seen) seen.sent += 1
}

/** Why a re-send is refused now, or null when it may go. An attempt that may go is noted at once. */
export function resendRefusal(id: string, now: number): { error: 'too_soon'; retry_after_s: number } | { error: 'too_many'; sent: number } | null {
  const seen = resendLog.get(id) ?? { lastAt: 0, sent: 0 }
  if (seen.sent >= RESEND_MAX_SENT) return { error: 'too_many', sent: seen.sent }
  const waitMs = seen.lastAt + RESEND_MIN_GAP_MS - now
  if (waitMs > 0) return { error: 'too_soon', retry_after_s: Math.ceil(waitMs / 1000) }
  resendLog.set(id, { ...seen, lastAt: now })
  if (resendLog.size > 2000) for (const [key, value] of resendLog) if (now - value.lastAt > 24 * 3_600_000) resendLog.delete(key)
  return null
}

/** APPROVALNOTIFYRETRY1118: when the Telegram send is repeated after a passing failure (approval-notify-retry.ts has
 *  the why): three more attempts, 13 seconds of waiting in all. Tests replace it. */
export const ownerNotifyRetry: RetryDeps = {
  delaysMs: [1_000, 3_000, 9_000],
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

/**
 * Resolves true when the owner's notification went out, false on every other path. Fire-and-forget for a request
 * that was just filed (the POST answer does not wait for the channel); the re-send route awaits it.
 * `resend` (APPROVALNOTIFYRETRY1118) is that route's one more send of a pending request's question: one attempt,
 * answered to the caller, with no in-band OWNER_UNREACHED message on a failure (the caller reads the answer).
 */
function notifyOwner(approval: Approval, chatApprovedMessageId: number | string | null = null, serverFiled = false, filedLang?: ApprovalLang, resend = false): Promise<boolean> {
  const informative = chatApprovedMessageId != null
  const inBand = !informative && !resend
  // APPROVALTAGEN1108: the language is read ONCE per request: the text, the Slack DM, its expiry and the language
  // stored with the post (the words its replies are checked with) are the same one. A server-filed request passes the
  // language its description was worded in (Samu 73350), so the description and the post never differ.
  const lang = filedLang ?? (reactionDeps.lang ?? approvalTextLang)()
  let text = informative
    ? buildOwnerChatApprovedText(approval, chatApprovedMessageId, lang)
    : buildOwnerApprovalText(approval, lang)
  return (async (): Promise<boolean> => {
    // APPROVALSLACK1030 (2): the owner decides with a Slack reaction the server itself checks, when this request may
    // (approval-slack-route.ts); otherwise the normal DM below, saying the decision is on the dashboard.
    // APPROVALSLACK1030 B: with APPROVAL_SLACK_REPLIES on, the same one-message path, and the owner's typed reply decides.
    // TEAMSAPPROVECARD1118: on a Teams install with the card switch on, an email_send request whose envelope the server
    // can verify goes out as the server-rendered card; anything else gets the normal message saying where to decide.
    if (!informative && CHANNEL_PROVIDER === 'teams' && teamsCardsOn(teamsCardDeps.setting)) {
      const route = teamsCardRoute(approval, teamsCardDeps)
      if (route.ok && await postApprovalCard(approval, route, formatExpiry(approval.timeout_at, lang), lang, teamsCardDeps)) return true
      text += '\n' + OWNER_TEXT[lang].teamsCardOnly(route.ok ? 'teams_post_failed' : route.reason)
    }
    if (!informative && (reactionsOn(reactionDeps.setting) || repliesOn(reactionDeps.setting))) {
      const expires = formatExpiry(approval.timeout_at, lang)
      const route = await reactionRoute(approval, serverFiled, reactionDeps, expires, approvalsPageUrl(), lang)
      if (route.ok && await postReactionPrompt(approval, route)) return true
      text += '\n' + dashboardOnlyLine(route.ok ? 'slack_post_failed' : route.reason, lang)
    }
    // APPROVALSLACK1030: an owner who moved to Slack (NOTIFY_SLACK_TARGET set) while the channel provider stays
    // Telegram got the request on Telegram (measured 2026-10-30: both of the day's requests logged this function's
    // Telegram branch, its messageId and no provider). The owner asked for Slack only: the request goes to the owner's
    // Slack DM, and a miss falls back in-band, never to Telegram.
    const slack = await sendOwnerSlackDm(text)
    if (slack.attempted) {
      if (slack.sent) {
        logger.info({ approvalId: approval.id, provider: 'slack', informative }, 'approval owner notification sent')
        return true
      }
      if (slack.error === 'no_slack_token') {
        logger.warn({ approvalId: approval.id, provider: 'slack', informative }, 'approval owner notification suppressed: no channel token')
        if (inBand) fallbackInBand(approval, 'no-token')
        return false
      }
      if (slack.error?.startsWith('unresolved_target')) {
        logger.warn({ approvalId: approval.id, provider: 'slack', informative }, 'approval owner notification suppressed: no owner chat')
        if (inBand) fallbackInBand(approval, 'no-owner-chat')
        return false
      }
      logger.warn({ approvalId: approval.id, provider: 'slack', error: slack.error, informative },
        'approval owner notification FAILED -- the request is only visible on the dashboard')
      if (inBand) fallbackInBand(approval, 'send-failed')
      return false
    }

    // APPROVALVAK821 fixed this path so the request reaches the OWNER and not
    // only the main agent's queue -- but the fix went out Telegram-only, so on
    // any install that speaks another provider the old silence came straight
    // back. Measured on a Discord install 2026-09-26: every approval request
    // logged `owner notification suppressed: no TELEGRAM_BOT_TOKEN`, the owner
    // was told nothing, and the only notification went to the main agent, i.e.
    // to the very agent whose request it was. An approval gate whose owner
    // never hears about it is not a gate.
    //
    // The Telegram branch is kept for Telegram installs ONLY because it also
    // records the message id (setApprovalTelegramMessageId); every other
    // provider goes through sendOwnerMessage, which resolves provider, token
    // and owner chat the same way every other owner message does.
    if (CHANNEL_PROVIDER === 'telegram' && TELEGRAM_BOT_TOKEN) {
      const ownerChat = ownerAlertChatOverride('telegram') ?? resolveOwnerChatId()
      if (!ownerChat) {
        logger.warn({ approvalId: approval.id, informative }, 'approval owner notification suppressed: no owner chat')
        if (inBand) fallbackInBand(approval, 'no-owner-chat')
        return false
      }
      try {
        // the fork's one-tap owner decision (PR #18): the Approve / Reject buttons ride on the Telegram message,
        // but not on the informative note (that row was already approved in the chat, nothing is left to press)
        // SCHEDCMDAPPROVAL1121: a hash-bound request's buttons carry the head of the content hash the text shows
        // (its "check code"), and the press is decided with it (resolveApprovalByOwner -> the decision core).
        const hashHead = HASH_BOUND_APPROVAL_CATEGORIES.has(approval.category) && typeof approval.content_hash === 'string'
          ? approval.content_hash.slice(0, OWNER_BUTTON_HASH_HEAD_LEN) : undefined
        const extra = !informative && approval.owner_nonce ? { reply_markup: ownerApprovalKeyboard(approval.id, approval.owner_nonce, hashHead) } : {}
        // APPROVALNOTIFYRETRY1118: a passing failure (a reset connection, a timeout, 429, 5xx) is sent again a few
        // times before the request is written off as OWNER_UNREACHED. Before each further send the row is read
        // again: a request decided on the dashboard in the meantime gets no late question.
        const outcome = await sendWithRetry(
          () => sendTelegramMessage(TELEGRAM_BOT_TOKEN, ownerChat, text, extra),
          resend ? { ...ownerNotifyRetry, delaysMs: [] } : ownerNotifyRetry,
          {
            stillWanted: () => informative || getApproval(approval.id)?.status === 'pending',
            onRetry: (err, attempt, waitMs) =>
              logger.warn({ err, approvalId: approval.id, informative, attempt, waitMs }, 'approval owner notification attempt failed -- sending again'),
          },
        )
        if (outcome.ok) {
          const messageId = outcome.value
          if (!informative && messageId != null) setApprovalTelegramMessageId(approval.id, messageId)
          logger.info({ approvalId: approval.id, messageId, informative, attempts: outcome.attempts }, 'approval owner notification sent')
          return true
        }
        if (outcome.why === 'unwanted') {
          logger.info({ approvalId: approval.id, attempts: outcome.attempts }, 'approval owner notification dropped: the request was decided while the send was being repeated')
          return false
        }
        logger.warn({ err: outcome.err, approvalId: approval.id, informative, attempts: outcome.attempts, why: outcome.why },
          'approval owner notification FAILED -- the request is only visible on the dashboard')
        if (inBand) fallbackInBand(approval, 'send-failed')
      } catch (err) {
        logger.warn({ err, approvalId: approval.id, informative }, 'approval owner notification FAILED -- the request is only visible on the dashboard')
        if (inBand) fallbackInBand(approval, 'send-failed')
      }
      return false
    }

    // sendOwnerMessage REPORTS whether it went out (PR1655 review, ask 2). The
    // funnel it wraps swallows every provider exception, so a `catch` here
    // would be unreachable and a failed Discord send would be recorded as a
    // delivered notification. The result is read instead.
    // The literals below are deliberate, not a computed reason string: the
    // delivery contract test (approvals-delivery.test.ts) reads this function's
    // SOURCE and requires every failure path to name its fallback explicitly.
    // That test exists so a refactor cannot quietly drop a fallback -- and it
    // caught exactly that when this branch first used a template string.
    const r = await sendOwnerMessage(text)
    if (r.sent) {
      logger.info({ approvalId: approval.id, provider: CHANNEL_PROVIDER, informative }, 'approval owner notification sent')
      return true
    }
    if (r.reason === 'no-token') {
      logger.warn({ approvalId: approval.id, provider: CHANNEL_PROVIDER, informative },
        'approval owner notification suppressed: no channel token')
      if (inBand) fallbackInBand(approval, 'no-token')
      return false
    }
    if (r.reason === 'no-owner-chat') {
      logger.warn({ approvalId: approval.id, provider: CHANNEL_PROVIDER, informative },
        'approval owner notification suppressed: no owner chat')
      if (inBand) fallbackInBand(approval, 'no-owner-chat')
      return false
    }
    logger.warn({ approvalId: approval.id, provider: CHANNEL_PROVIDER, reason: r.reason, informative },
      'approval owner notification FAILED -- the request is only visible on the dashboard')
    if (inBand) fallbackInBand(approval, 'send-failed')
    return false
  })()
}

function notifyMainAgent(approval: Approval): void {
  // APPROVALVAK821 (b): when the requester IS the main agent, this used to
  // deliver the notification back to the requester itself -- which counted as
  // "notified" while no human ever saw it. The owner Telegram above is the
  // real notification; a self-addressed message is noise that hides the gap.
  if (approval.agent_id === MAIN_AGENT_ID) {
    logger.info({ approvalId: approval.id }, 'approval main-agent notify skipped: requester is the main agent (owner is notified on Telegram)')
    return
  }
  try {
    const content = [
      `[APPROVAL_REQUEST]`,
      `id=${approval.id}`,
      `agent=${approval.agent_id}`,
      `category=${approval.category}`,
      `action=${approval.action_description}`,
      `timeout_at=${approval.timeout_at ?? 'null'}`,
    ].join(' ')
    createAgentMessage('system', MAIN_AGENT_ID, content)
  } catch (err) {
    // Non-fatal: the approval is created regardless; main-agent notification is best-effort
    logger.warn({ err, approvalId: approval.id }, 'Failed to notify main agent of approval request')
  }
}

// MARVEENGAPS1020 (a): a route that needs an approval files it itself, with a
// description it built from the real object, on the same path as POST
// /api/approvals: same row, same timeout rule, same owner and main-agent
// notification. The requester cannot word the request the owner reads.
export function fileServerApproval(params: {
  agent_id: string
  category: string
  /** APPROVALTAGEN1108 (Samu 73350): a function words it in the language the owner's post goes out in, read once here. */
  action_description: string | ((lang: ApprovalLang) => string)
  action_payload?: string | null
  content_hash: string
}): Approval {
  const lang = (reactionDeps.lang ?? approvalTextLang)()
  const description = typeof params.action_description === 'function' ? params.action_description(lang) : params.action_description
  const approval = createApproval({
    id: randomUUID(),
    agent_id: params.agent_id,
    category: params.category,
    action_description: description,
    action_payload: params.action_payload ?? null,
    timeout_at: computeTimeoutAt(params.category, undefined),
    content_hash: params.content_hash,
  })
  // serverFiled: the description is the server's own words, so the reaction path may show it (APPROVALSLACK1030 (2)).
  void notifyOwner(approval, null, true, lang)
  notifyMainAgent(approval)
  logger.info({ id: approval.id, agent_id: approval.agent_id, category: approval.category }, 'Approval request filed by the server')
  return approval
}

/** APPROVALSLACK1030 (2) and B: the owner's Slack reactions and typed replies, read by the server (idle while both switches are off). */
export function startApprovalReactionSweeper(): NodeJS.Timeout {
  return startApprovalSlackSweeper({
    setting: reactionDeps.setting,
    token: reactionDeps.token,
    pageUrl: approvalsPageUrl(),
    alert: (t) => { void sendOwnerSlackDm(t).catch(() => {}) },
  })
}

export function startApprovalTimeoutSweeper(): NodeJS.Timeout {
  return setInterval(() => {
    try {
      const expired = expireTimedOutApprovals()
      if (expired > 0) logger.info({ expired }, 'Approval timeout sweep: expired pending approvals')
    } catch (err) {
      logger.warn({ err }, 'Approval timeout sweep failed')
    }
  }, 60_000)
}

// POST /api/approvals/:id/consume with a category other than email_send. The
// acting tool calls it right BEFORE its first irreversible write and acts only
// on 200; 409 means do NOT act (used, unapproved, another plan, another
// category, stale). Same answer shapes as the letter path. email_send and
// data_delete rows are refused here (wrong_category): the server consumes
// those on their own paths.
function handleCategoryConsume(ctx: RouteContext, id: string, body: Record<string, unknown>): void {
  const { res } = ctx
  const { category, content_hash, consumer, ref, max_age_seconds } = body
  if (!isCategoryKey(category)) {
    json(res, { error: 'category must be a category key (lower-case letters, digits, underscore; max 64)' }, 400)
    return
  }
  if (content_hash !== undefined && content_hash !== null && (typeof content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(content_hash))) {
    json(res, { error: 'content_hash, if given, must be the 64-char lowercase sha256 hex anchor the approval was requested with' }, 400)
    return
  }
  if (!isConsumerName(consumer)) {
    json(res, { error: 'consumer is required: 1-120 printable characters naming the acting tool' }, 400)
    return
  }
  if (ref !== undefined && ref !== null && !isConsumeRef(ref)) {
    json(res, { error: 'ref, if given, must be 1-250 printable characters' }, 400)
    return
  }
  const windowSeconds = categoryWindowSeconds(max_age_seconds)
  if (windowSeconds === null) {
    json(res, { error: `max_age_seconds, if given, must be a whole number of seconds between 1 and ${CATEGORY_CONSUME_MAX_WINDOW_S}` }, 400)
    return
  }
  const result = consumeCategoryApproval({
    id,
    category,
    contentHash: typeof content_hash === 'string' ? content_hash : null,
    consumer: consumer.trim(),
    ref: typeof ref === 'string' ? ref.trim() : null,
    windowSeconds,
  })
  if (result.ok) {
    logger.info({ id, category, consumer: consumer.trim(), ref: ref ?? null }, 'Approval consumed by the acting tool')
    json(res, { ok: true, approval: redactOwnerNonce(result.approval) })
    return
  }
  if (result.reason === 'not_found') {
    json(res, { ok: false, reason: 'not_found' }, 404)
    return
  }
  const a = result.approval
  logger.warn({ id, category, consumer: consumer.trim(), reason: result.reason }, 'Approval consume refused')
  json(res, {
    ok: false,
    reason: result.reason,
    approval: a ? { id: a.id, status: a.status, consumed_at: a.consumed_at, consumed_by: a.consumed_by, consumed_ref: a.consumed_ref } : null,
  }, 409)
}

export async function tryHandleApprovals(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  // POST /api/approvals/teams-card-action -- TEAMSAPPROVECARD1118: an approval-card click forwarded by the Teams
  // plugin. No dashboard token is taken here (auth-gate requiresAuth): the handler checks the Bot Framework channel
  // token itself, and only a click on the server-posted card by the owner decides (web/approval-teams-card.ts).
  if (path === '/api/approvals/teams-card-action' && method === 'POST') {
    const raw = await readBodyOrRefuse(req, res, { maxBytes: 64 * 1024 })
    if (!raw) return true
    let activity: unknown
    try { activity = JSON.parse(raw.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const auth = req.headers.authorization
    const answer = await handleTeamsCardAction(typeof auth === 'string' ? auth : undefined, activity, teamsCardDeps)
    json(res, answer.body, answer.status)
    return true
  }

  // POST /api/agent-specs -- AGENTCREATEPR2-1119: an agent files an agent_create REQUEST (the shared token too: nothing
  // is created here). The server validates and stores the spec, and opens an approval bound to its hash. Off unless
  // AGENT_CREATE_VIA_APPROVAL=on. Who asked is informational (a per-agent token's name, else the self-declared header).
  if (path === '/api/agent-specs' && method === 'POST') {
    const raw = await readBodyOrRefuse(req, res, { maxBytes: 64 * 1024 })
    if (!raw) return true
    let body: unknown
    try { body = JSON.parse(raw.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const header = req.headers['x-agent-id']
    const declared = typeof header === 'string' && /^[a-z0-9_-]{1,64}$/i.test(header) ? header : 'unknown'
    const requestedBy = ctx.auth?.kind === 'token' ? (ctx.auth.tokenAgent ?? claimedAgentOf(ctx.auth) ?? declared) : declared
    // Dani #2922 B1: the requester may name only a vault entry it may read (the floor and the allowlist, strictly)
    const auth = ctx.auth
    const reader = auth?.kind === 'token' ? (auth.tokenAgent ?? claimedAgentOf(auth)) : null
    const acl = readVaultAcl()
    const vaultReadable = (id: string): boolean => {
      // the floor holds for the owner's session too: SSH material or a vault sub-resource is never a bot token (Dani 81221)
      if (!isAgentReadableDecodedVaultId(id)) return false
      if (auth?.kind === 'session') return true
      if (!reader) return false
      const listed = Object.prototype.hasOwnProperty.call(acl, id) && Array.isArray(acl[id]) ? acl[id] : []
      return listed.includes(reader)
    }
    const r = await fileAgentSpecRequest(body, requestedBy, { setting: (k) => String(getEffectiveSettingValue(k) ?? ''), lang: approvalTextLang(), vaultReadable })
    json(res, r.body, r.status)
    return true
  }

  // POST /api/schedule-command-specs -- SCHEDCMDAPPROVAL1121 (Péter GO 17598): the MAIN agent files a schedule_command
  // REQUEST, the whole scheduled shell command as a spec (the shared token too: nothing is created here). The server
  // validates and stores the spec, opens an approval bound to its hash, and sends the owner the text rendered from the
  // stored spec (the command verbatim), on Telegram with the buttons. Only the owner's approval (the Telegram button or
  // the dashboard, both with the hash shown) makes the server create exactly that task, once. Who asked is
  // self-declared (a per-agent token's name, else the claimed agent, else the header): anyone but the main agent is
  // refused, and a sub-agent's own token never gets this far (the agent-token route list). On unless
  // SCHEDULE_COMMAND_VIA_APPROVAL=off.
  if (path === '/api/schedule-command-specs' && method === 'POST') {
    const raw = await readBodyOrRefuse(req, res, { maxBytes: 64 * 1024 })
    if (!raw) return true
    let body: unknown
    try { body = JSON.parse(raw.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
    const header = req.headers['x-agent-id']
    const declared = typeof header === 'string' && /^[a-z0-9_-]{1,64}$/i.test(header) ? header : 'unknown'
    const requestedBy = ctx.auth?.kind === 'token' ? (ctx.auth.tokenAgent ?? claimedAgentOf(ctx.auth) ?? declared) : declared
    const lang = (reactionDeps.lang ?? approvalTextLang)()
    // Ellenőr #59 J1: the owner's text says whether the name came from the agent's own token or was only claimed.
    const requesterSource = ctx.auth?.kind === 'token' && ctx.auth.tokenAgent ? 'agent-token' as const : 'self-declared' as const
    const r = fileScheduleCommandRequest(body, requestedBy, { setting: (k) => String(getEffectiveSettingValue(k) ?? ''), lang, requesterSource })
    if (r.approval) {
      // serverFiled: the description is the server's own rendering of the stored spec
      void notifyOwner(r.approval, null, true, lang)
      notifyMainAgent(r.approval)
    }
    json(res, r.body, r.status)
    return true
  }

  // POST /api/approvals -- create new approval request
  if (path === '/api/approvals' && method === 'POST') {
    let body: { supersedes?: unknown; agent_id?: unknown; category?: unknown; action_description?: unknown; action_payload?: unknown; timeout_seconds?: unknown; content_hash?: unknown; owner_approved_message_id?: unknown; for_agent?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const { agent_id, category, action_description, action_payload, timeout_seconds, content_hash, owner_approved_message_id, for_agent } = body
    if (typeof agent_id !== 'string' || !agent_id.trim()) {
      json(res, { error: 'agent_id is required' }, 400)
      return true
    }
    if (typeof category !== 'string' || !category.trim()) {
      json(res, { error: 'category is required' }, 400)
      return true
    }
    if (isButtonOnlyCategory(category.trim())) {
      json(res, { error: 'this category is raised by the dashboard itself, not over the API' }, 403)
      return true
    }
    // D3(b): second_review rows are filed by the server only (routes/review-action.ts), with the
    // exact call as payload. A caller-filed row could carry a call's hash under a harmless text.
    if (category.trim() === 'second_review') {
      json(res, { error: 'category second_review is reserved for the server' }, 403)
      return true
    }
    // SCHEDCMDAPPROVAL1121: a schedule_command request is filed only with its stored spec (POST /api/schedule-command-specs).
    if (category.trim() === SCHEDULE_COMMAND_CATEGORY) {
      json(res, { error: 'category schedule_command is filed through POST /api/schedule-command-specs, with its spec' }, 403)
      return true
    }
    if (typeof action_description !== 'string' || !action_description.trim()) {
      json(res, { error: 'action_description is required' }, 400)
      return true
    }
    if (action_payload !== undefined && typeof action_payload !== 'string') {
      json(res, { error: 'action_payload must be a string (JSON) if provided' }, 400)
      return true
    }
    // EMAILKAPU901 PR2: the email-approval-gate hook hands the requesting
    // agent this exact sha256 anchor (to+cc+subject+body); a malformed value
    // could never match the gate's recomputation, so reject it loudly here
    // instead of storing a row that silently authorizes nothing.
    if (content_hash !== undefined && (typeof content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(content_hash))) {
      json(res, { error: 'content_hash must be a 64-char lowercase sha256 hex string if provided' }, 400)
      return true
    }

    // for_agent grants the row to ONE sub-agent, whose own token (AGENT_TOKENS)
    // may then consume it (auth-gate.ts binding on POST /api/approvals/:id/consume).
    // Granting is the main agent's lane: the gate already refuses the field from
    // a sub-agent token (owner-lane field, 403); this repeats it at the route so
    // the grant never rests on the gate table alone.
    let forAgent: string | null = null
    if (for_agent !== undefined && for_agent !== null) {
      if (ctx.auth?.kind === 'token' && ctx.auth.tokenAgent) {
        json(res, { error: 'for_agent is set only by the main agent; a sub-agent token cannot grant an approval' }, 403)
        return true
      }
      if (!isForAgentName(for_agent)) {
        json(res, { error: 'for_agent, if given, must be one agent name (1-64 chars: letters, digits, _ or -)' }, 400)
        return true
      }
      forAgent = for_agent
    }

    // The main agent may file an approval for an action the
    // owner ALREADY approved in the chat, naming the owner's approving
    // message. Such a row is born approved and the owner is told, not asked.
    // Only the main agent: it is the one reading the owner's chat. Any other
    // requester sending the field is refused outright (not silently ignored),
    // so a caller relying on the field learns at once that it does not apply.
    // A sub-agent that declares its own name is refused; the check rests on
    // the self-declared agent_id, and any holder of the shared dashboard token
    // can send the main agent's name and get a row born approved.
    //
    // The server does not verify the id: it does not check that the message
    // exists, came from the owner, is recent, or refers to this action. Any
    // value of the right shape passes. Whether the owner approved this action
    // in the chat is the main agent's judgement, not a server check.
    //
    // The id is the owner's approving chat message: a positive integer
    // (Telegram), or a short id string for providers whose message ids are not
    // safe integers (a Slack ts, a Discord snowflake). Only an integer id is
    // stored in the row's telegram_message_id column (INTEGER, the same column
    // PATCH writes); a string id is kept in the owner note and the log line.
    let chatApprovedMessageId: number | string | null = null
    if (owner_approved_message_id !== undefined && owner_approved_message_id !== null) {
      if (!mayActAsOwner(ctx.auth, req)) {
        logger.warn({ agent_id, category, auth: ctx.auth?.kind, agent: ctx.auth?.agent }, 'born-approved approval refused: no owner session')
        refuseOwner(res, OWNER_ONLY.error)
        return true
      }
      if (agent_id.trim() !== MAIN_AGENT_ID) {
        json(res, { error: 'owner_approved_message_id is only accepted from the main agent; a requesting agent cannot pre-approve its own request' }, 400)
        return true
      }
      const okInt = typeof owner_approved_message_id === 'number' && Number.isSafeInteger(owner_approved_message_id) && owner_approved_message_id > 0
      const okStr = typeof owner_approved_message_id === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(owner_approved_message_id)
      if (!okInt && !okStr) {
        json(res, { error: 'owner_approved_message_id must be the owner\'s approving chat message id (a positive integer, or an id string of 1-64 [A-Za-z0-9._:-] characters) if provided' }, 400)
        return true
      }
      chatApprovedMessageId = owner_approved_message_id as number | string
    }

    const id = randomUUID()
    const timeout_at = computeTimeoutAt(category, timeout_seconds)
    let approval = createApproval({
      id,
      agent_id: agent_id.trim(),
      category: category.trim(),
      action_description: action_description.trim(),
      action_payload: typeof action_payload === 'string' ? action_payload : null,
      timeout_at,
      content_hash: typeof content_hash === 'string' ? content_hash : null,
      owner_nonce: newApprovalNonce(),
      for_agent: forAgent,
    })
    if (chatApprovedMessageId != null) {
      // Same resolve path as PATCH, so the row is indistinguishable from a
      // PATCH-approved one for every reader (e.g. the email-approval-gate).
      resolveApproval(id, 'approved', `${CHANNEL_PROVIDER}_text`,
        typeof chatApprovedMessageId === 'number' ? chatApprovedMessageId : null)
      approval = getApproval(id) ?? approval
    }

    closeSupersededApprovals(approval, typeof body.supersedes === 'string' ? body.supersedes : null)
    void notifyOwner(approval, chatApprovedMessageId)
    notifyMainAgent(approval)
    logger.info({ id, agent_id, category, chatApprovedMessageId, forAgent }, chatApprovedMessageId != null ? 'Approval created as already approved in chat' : 'Approval request created')
    json(res, redactOwnerNonce(approval), 201)
    return true
  }

  // GET /api/approvals -- list with filters
  if (path === '/api/approvals' && method === 'GET') {
    const agent_id = url.searchParams.get('agent') ?? undefined
    const category = url.searchParams.get('category') ?? undefined
    const status = url.searchParams.get('status') ?? undefined
    const limitRaw = url.searchParams.get('limit')
    const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 100, 500) : 100

    const items = listApprovals({ agent_id, category, status, limit })
    json(res, items.map(redactOwnerNonce))
    return true
  }

  // POST /api/approvals/:id/consume -- f2c5edb0: one-shot consumption on the
  // SEND path. A sender the gate cannot see (a script that mails from another
  // host) calls this right BEFORE the letter goes out and sends only on 200.
  // 409 means do NOT send: the approval is used, unapproved, for another letter,
  // or stale -- and a second attempt on a used approval is the double send this
  // exists to stop.
  // With "category": "<key>" (anything but email_send) the same route consumes
  // an approval of that category once, for the tool about to act on it
  // (handleCategoryConsume above).
  const consumeMatch = path.match(/^\/api\/approvals\/([^/]+)\/consume$/)
  if (consumeMatch && method === 'POST') {
    // A sub-agent's own token (AGENT_TOKENS) reaches this route only for its
    // own request or a row the main agent granted to it with for_agent (the
    // gate's identity binding). The route repeats the check so the rule never
    // rests on the gate table alone; agent_id and for_agent are written once at
    // creation and never updated. Same uniform 403 as the gate: no consume,
    // and nothing said about whether the id exists.
    const caller = ctx.auth?.kind === 'token' ? ctx.auth.tokenAgent : undefined
    if (caller && approvalGranteeOf(getApproval(consumeMatch[1])) !== caller) {
      json(res, identityDenialBody(caller, MAIN_AGENT_ID, approvalNotGrantedReason(caller)), 403)
      return true
    }
    let body: { content_hash?: unknown; consumer?: unknown; message_id?: unknown; category?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      json(res, { error: 'body must be a JSON object' }, 400)
      return true
    }
    // A body naming any category other than email_send is the generic one-shot
    // path. No category (or email_send, or null) is the letter path below,
    // exactly as before.
    if (body.category !== undefined && body.category !== null && body.category !== 'email_send') {
      handleCategoryConsume(ctx, consumeMatch[1], body as Record<string, unknown>)
      return true
    }
    const { content_hash, consumer, message_id } = body
    if (typeof content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(content_hash)) {
      json(res, { error: 'content_hash must be the 64-char lowercase sha256 hex anchor of the letter being sent' }, 400)
      return true
    }
    if (!isConsumerName(consumer)) {
      json(res, { error: 'consumer is required: 1-120 printable characters naming the sending tool' }, 400)
      return true
    }
    if (message_id !== undefined && message_id !== null && !isMessageId(message_id)) {
      json(res, { error: 'message_id, if given, must be one RFC 5322 id like <local@domain> (max 250 chars)' }, 400)
      return true
    }
    const result = consumeApproval({
      id: consumeMatch[1],
      contentHash: content_hash,
      consumer: consumer.trim(),
      messageId: typeof message_id === 'string' ? message_id : null,
      windowSeconds: approvalWindowSeconds(),
    })
    if (result.ok) {
      logger.info({ id: consumeMatch[1], consumer: consumer.trim(), ref: message_id ?? null }, 'Approval consumed by the send path')
      json(res, { ok: true, approval: redactOwnerNonce(result.approval) })
      return true
    }
    if (result.reason === 'not_found') {
      json(res, { ok: false, reason: 'not_found' }, 404)
      return true
    }
    const a = result.approval
    logger.warn({ id: consumeMatch[1], consumer: consumer.trim(), reason: result.reason }, 'Approval consume refused')
    json(res, {
      ok: false,
      reason: result.reason,
      approval: a ? { id: a.id, status: a.status, consumed_at: a.consumed_at, consumed_by: a.consumed_by, consumed_ref: a.consumed_ref } : null,
    }, 409)
    return true
  }

  // GET /api/approvals/:id -- status poll
  const idMatch = path.match(/^\/api\/approvals\/([^/]+)$/)
  if (idMatch && method === 'GET') {
    const approval = getApproval(idMatch[1])
    if (!approval) {
      json(res, { error: 'Not found' }, 404)
      return true
    }
    json(res, redactOwnerNonce(approval))
    return true
  }

  // POST /api/approvals/:id/telegram-decision decides nothing, for any caller. Only the process that reads a Telegram
  // update knows who pressed what, and that process records the press (approval-callbacks.ts). The owner's own
  // command is the other path (builtin-commands.ts). A request body here is not evidence of either.
  const decMatch = path.match(/^\/api\/approvals\/([^/]+)\/telegram-decision$/)
  if (decMatch && method === 'POST') {
    logger.warn({ id: decMatch[1], auth: ctx.auth?.kind, agent: ctx.auth?.agent }, 'telegram-decision refused: this route does not decide')
    json(res, { error: 'owner_decision_only_from_telegram', text: 'A döntés csak Péter Telegram-gombjáról vagy parancsából jöhet.' }, 403)
    return true
  }

  // POST /api/approvals/:id/notify -- APPROVALNOTIFYRETRY1118: the owner's question for a request that is still
  // pending goes out once more, with its buttons. For the request whose first notification was lost (measured
  // 2026-11-18: a reset connection, and the owner asked why there was no button). It decides nothing and returns no
  // nonce; the message goes where the first one went. An earlier message that did arrive keeps its buttons: the first
  // press decides, a press on the other one is answered as already resolved (telegram-approval.ts).
  const notifyMatch = path.match(/^\/api\/approvals\/([^/]+)\/notify$/)
  if (notifyMatch && method === 'POST') {
    const approval = getApproval(notifyMatch[1]!)
    if (!approval) {
      json(res, { error: 'Not found' }, 404)
      return true
    }
    if (approval.status !== 'pending') {
      json(res, { error: 'not_pending', status: approval.status }, 409)
      return true
    }
    if (approval.timeout_at != null && approval.timeout_at * 1000 <= Date.now()) {
      json(res, { error: 'expired' }, 409)
      return true
    }
    const refusal = resendRefusal(approval.id, Date.now())
    if (refusal) {
      json(res, refusal, 429)
      return true
    }
    const sent = await notifyOwner(approval, null, false, undefined, true)
    if (sent) noteResent(approval.id)
    logger.info({ approvalId: approval.id, sent, auth: ctx.auth?.kind, agent: ctx.auth?.agent }, 'approval owner notification re-send asked for')
    json(res, { ok: sent, sent }, sent ? 200 : 502)
    return true
  }

  // PATCH /api/approvals/:id -- resolve (approve/reject/timeout)
  if (idMatch && method === 'PATCH') {
    let body: { status?: unknown; resolved_by?: unknown; telegram_message_id?: unknown; content_hash?: unknown }
    try {
      body = JSON.parse((await readBody(req)).toString())
    } catch {
      json(res, { error: 'Invalid JSON' }, 400)
      return true
    }

    const { status, resolved_by, telegram_message_id } = body
    if (status !== 'approved' && status !== 'rejected' && status !== 'timeout') {
      json(res, { error: 'status must be approved, rejected, or timeout' }, 400)
      return true
    }
    if (typeof resolved_by !== 'string' || !resolved_by.trim()) {
      json(res, { error: 'resolved_by is required' }, 400)
      return true
    }
    const msgId = typeof telegram_message_id === 'number' ? telegram_message_id : null

    // Approving takes the owner (see OWNER_ONLY); rejecting or timing out does not, since
    // an agent that cancels a request gains nothing by it.
    if (status === 'approved' && !mayActAsOwner(ctx.auth, req)) {
      logger.warn({ id: idMatch[1], resolved_by, auth: ctx.auth?.kind, agent: ctx.auth?.agent }, 'approval approve refused: no owner session')
      refuseOwner(res, OWNER_ONLY.error)
      return true
    }

    // Self-approval guard: the requesting agent cannot approve its own request.
    // This is a best-effort check on the self-declared resolved_by value (all fleet
    // agents share the same bearer token, so server-side identity is not enforceable).
    // It catches naive/accidental self-approvals; the real control lives on the
    // main-agent side (approval-request-handling skill).
    const target = getApproval(idMatch[1])
    if (target && isButtonOnlyCategory(target.category)) {
      json(res, { error: 'this approval is decided by the owner\'s Telegram button only' }, 403)
      return true
    }
    // AGENTCREATEPR2-1119 (Samu 81167): an agent_create request is approved here only by the owner's session (the owner
    // gate above), and only through the decision core with the hash the dashboard showed the owner: never by a plain
    // status write. Rejecting it stays a status write. SCHEDCMDAPPROVAL1121: the same for every hash-bound category
    // (schedule_command too), so none of them can be approved by a plain status write.
    if (target && HASH_BOUND_APPROVAL_CATEGORIES.has(target.category) && status === 'approved') {
      const shown = body.content_hash
      if (typeof shown !== 'string' || !/^[0-9a-f]{64}$/.test(shown)) {
        json(res, { error: `content_hash (the hash the owner was shown) is required to approve this ${target.category} request` }, 400)
        return true
      }
      const d = decideApproval({ approvalId: target.id, status: 'approved', evidence: { channel: 'dashboard', mode: 'owner' }, expectedContentHash: shown })
      if (d.outcome !== 'decided') { json(res, { error: `Not approved: ${d.outcome}` }, 409); return true }
      logger.info({ id: target.id, category: target.category }, 'hash-bound request approved by the owner on the dashboard')
      json(res, redactOwnerNonce(d.approval))
      return true
    }
    if (target && resolved_by.trim() === target.agent_id) {
      json(res, { error: 'The requesting agent cannot approve its own request' }, 403)
      return true
    }
    // This name means a recorded press or the owner's command. The server writes it on those paths, nothing else may.
    if (namesOwnerResolver(resolved_by)) {
      json(res, { error: `resolved_by ${OWNER_RESOLVER} is written by the server only` }, 403)
      return true
    }

    const updated = resolveApproval(idMatch[1], status, resolved_by.trim(), msgId)
    if (!updated) {
      // Either not found or already resolved
      const existing = getApproval(idMatch[1])
      if (!existing) {
        json(res, { error: 'Not found' }, 404)
      } else {
        json(res, { error: `Already resolved as ${existing.status}` }, 409)
      }
      return true
    }

    const approval = getApproval(idMatch[1])
    logger.info({ id: idMatch[1], status, resolved_by }, 'Approval resolved')
    json(res, redactOwnerNonce(approval))
    return true
  }

  return false
}
