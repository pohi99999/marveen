// FORKDEPLOY1121 (Péter GO 17701, Marveen 8631): the spec behind a fork_deploy approval. One owner press is both the
// merge GO and the deploy: the reviewed PR head (ONE commit on top of the fork's main) is fast-forwarded onto the fork's
// main and its mirrors, pulled into the running install, built, and the dashboard restarted, all on exactly the SHA the
// owner's message showed. The server builds the spec from git itself (the request names only the PR and the SHA), so
// every field the owner reads was measured, not claimed:
//   - from_sha: the install's HEAD, which must also be the fork's main and every mirror's main when the request is filed
//     (and again when the deploy starts);
//   - to_sha: the PR's head on the fork (refs/pull/<pr>/head), whose ONE parent is from_sha: a fast-forward of one
//     commit, so the SHA the owner approves is the SHA that goes live (no squash commit born after the press);
//   - subject, the diff's size and whether package-lock.json changed: read from that commit.
// The canonical object is the ONE source of both the owner's text and the hash, as in schedule-command-spec.ts. The
// subject is shown as written, so it may hold printable ASCII and the Hungarian accented letters only; anything else (a
// look-alike letter, a bidi or zero-width character) is refused, not escaped.
import { createHash } from 'node:crypto'

export const FORK_DEPLOY_SPEC_VERSION = 1
export const FORK_DEPLOY_REMOTE = 'fork'
export const FORK_DEPLOY_MIRRORS: readonly string[] = ['brunella']
export const FORK_DEPLOY_BRANCH = 'main'
export const MAX_SUBJECT_LEN = 200
export const MAX_PR_NUMBER = 1_000_000

export interface ForkDeploySpecV1 {
  spec_version: 1
  pr: number
  subject: string
  from_sha: string
  to_sha: string
  to_tree: string
  remote: string
  mirrors: string[]
  branch: string
  files_changed: number
  insertions: number
  deletions: number
  lockfile_changed: boolean
  service_label: string
}

/** What the request carries: the PR and the head SHA the reviewer measured. Everything else the server reads from git. */
export interface ForkDeployRequest { pr: number; sha: string }

export type ForkDeployRequestResult = { ok: true; req: ForkDeployRequest } | { ok: false; status: number; error: string }

const SHA_RE = /^[0-9a-f]{40}$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex')

export function isFullSha(v: unknown): v is string {
  return typeof v === 'string' && SHA_RE.test(v)
}

/** The request body -> { pr, sha }, or the refusal. */
export function parseForkDeployRequest(body: unknown): ForkDeployRequestResult {
  if (!isObj(body)) return { ok: false, status: 400, error: 'the request must be a JSON object' }
  const extra = Object.keys(body).find((k) => !['spec_version', 'pr', 'sha'].includes(k))
  if (extra !== undefined) return { ok: false, status: 400, error: `unknown field: ${extra}` }
  if (body.spec_version !== FORK_DEPLOY_SPEC_VERSION) return { ok: false, status: 400, error: `spec_version must be ${FORK_DEPLOY_SPEC_VERSION}` }
  if (typeof body.pr !== 'number' || !Number.isSafeInteger(body.pr) || body.pr < 1 || body.pr > MAX_PR_NUMBER) {
    return { ok: false, status: 400, error: 'pr must be a positive whole number (the pull request number on the fork)' }
  }
  if (!isFullSha(body.sha)) return { ok: false, status: 400, error: 'sha must be the full 40-character lower-case commit SHA of the PR head' }
  return { ok: true, req: { pr: body.pr, sha: body.sha } }
}

// Printable ASCII plus the Hungarian accented letters: the subject is shown as written, so nothing else may be in it.
const SUBJECT_ALLOWED = /^[\x20-\x7eáéíóöőúüűÁÉÍÓÖŐÚÜŰ]*$/u

/** Why a commit subject cannot be shown as written, or null when it can. */
export function unshowableSubject(s: string): string | null {
  if (!s.trim()) return 'the commit subject is empty'
  if (s.length > MAX_SUBJECT_LEN) return `the commit subject is longer than ${MAX_SUBJECT_LEN} characters`
  if (s !== s.trim()) return 'the commit subject starts or ends with whitespace'
  if (SUBJECT_ALLOWED.test(s)) return null
  for (const ch of s) {
    if (!SUBJECT_ALLOWED.test(ch)) return `the commit subject contains U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}, which is not printable ASCII or a Hungarian letter`
  }
  return 'the commit subject cannot be shown as written'
}

/** The checks a stored or freshly built spec must pass (types, shapes, the one-commit fast-forward shape is git's). */
export function validForkDeploySpec(spec: unknown): spec is ForkDeploySpecV1 {
  if (!isObj(spec)) return false
  const keys = ['spec_version', 'pr', 'subject', 'from_sha', 'to_sha', 'to_tree', 'remote', 'mirrors', 'branch',
    'files_changed', 'insertions', 'deletions', 'lockfile_changed', 'service_label']
  if (Object.keys(spec).length !== keys.length || !keys.every((k) => k in spec)) return false
  const whole = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  return spec.spec_version === FORK_DEPLOY_SPEC_VERSION
    && typeof spec.pr === 'number' && Number.isSafeInteger(spec.pr) && spec.pr >= 1 && spec.pr <= MAX_PR_NUMBER
    && typeof spec.subject === 'string' && unshowableSubject(spec.subject) === null
    && isFullSha(spec.from_sha) && isFullSha(spec.to_sha) && isFullSha(spec.to_tree) && spec.from_sha !== spec.to_sha
    && spec.remote === FORK_DEPLOY_REMOTE
    && Array.isArray(spec.mirrors) && spec.mirrors.length === FORK_DEPLOY_MIRRORS.length
    && spec.mirrors.every((m, i) => m === FORK_DEPLOY_MIRRORS[i])
    && spec.branch === FORK_DEPLOY_BRANCH
    && whole(spec.files_changed) && whole(spec.insertions) && whole(spec.deletions)
    && typeof spec.lockfile_changed === 'boolean'
    && typeof spec.service_label === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(spec.service_label)
}

/** Sorted keys at every level, no whitespace: one byte string per spec (the rule of schedule-command-spec.ts). */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`
  return JSON.stringify(v)
}

export function forkDeploySpecHash(spec: ForkDeploySpecV1): string {
  return sha256(canonicalJson(spec))
}

/** How many hex characters of the hash the owner's text shows; the Telegram buttons carry the same head. */
export const CHECK_CODE_LEN = 10

export type RequesterSource = 'agent-token' | 'self-declared'

/** The owner's text, rendered from the canonical spec and nothing else. Every hashed field is on a line. */
export function renderForkDeploySpec(spec: ForkDeploySpecV1, hash: string, lang: 'hu' | 'en', requester?: { name: string; source: RequesterSource }): string {
  const hu = lang === 'hu'
  const targets = [spec.remote, ...spec.mirrors].join(', ')
  return [
    hu ? `Élesítés egy gombbal: PR #${spec.pr} merge és a vezérlőpult újraindítása, jóváhagyásra:` : `One-press deploy: merge PR #${spec.pr} and restart the dashboard, for approval:`,
    `- PR #${spec.pr}: ${spec.subject}`,
    `- ${hu ? 'a(z) ' : ''}${spec.remote}/${spec.branch} ${hu ? 'és az éles telepítés' : 'and the running install'}: ${spec.from_sha}`,
    `- ${hu ? 'erre lép (fast-forward, egy commit, a PR feje)' : 'moves to (fast-forward, one commit, the PR head)'}: ${spec.to_sha}`,
    `- ${hu ? 'változás' : 'change'}: ${spec.files_changed} ${hu ? 'fájl' : 'files'}, +${spec.insertions} -${spec.deletions}${spec.lockfile_changed ? (hu ? ', a package-lock.json is változik (npm ci)' : ', package-lock.json changes too (npm ci)') : ''}`,
    `- ${hu ? 'push ide' : 'pushed to'}: ${targets} (${spec.branch})`,
    hu
      ? `- utána: build, és a vezérlőpult (${spec.service_label}) ÚJRAINDUL; várható kiesés kb. 5-15 mp. Ha a build vagy az indulás elbukik, a telepítés visszaáll a régi SHA-ra, és jelentés megy.`
      : `- then: build, and the dashboard (${spec.service_label}) RESTARTS; expected outage about 5-15 s. If the build or the start fails, the install goes back to the old SHA and a report is sent.`,
    hu
      ? '- Ha a gombnyomásig a fork main, egy tükör, az éles telepítés vagy a PR feje elmozdul, nem történik semmi, és új kérés kell.'
      : '- If the fork main, a mirror, the running install or the PR head moves before the press, nothing happens and a new request is needed.',
    ...(requester
      ? [`- ${hu ? 'kérő' : 'requested by'}: ${requester.name} (${requester.source === 'agent-token'
        ? (hu ? 'saját tokennel azonosítva' : 'identified by its own token')
        : (hu ? 'a közös tokennel, ÖNBEVALLOTT név: bármelyik ügynök írhatta, csak a jóváhagyásod véd' : 'on the shared token, a SELF-DECLARED name: any agent could have written it, only your approval protects')})`]
      : []),
    `- ${hu ? 'spec-verzió' : 'spec version'}: ${spec.spec_version}`,
    `- ${hu ? 'ellenőrző kód' : 'check code'}: ${hash.slice(0, CHECK_CODE_LEN)}`,
  ].join('\n')
}

/** The consumer's re-check: the stored JSON is canonical, hashes to the approved hash, and is still a valid spec. */
export function recheckStoredForkDeploySpec(specJson: string, approvedHash: string): { ok: true; spec: ForkDeploySpecV1 } | { ok: false; reason: string } {
  let spec: unknown
  try { spec = JSON.parse(specJson) } catch { return { ok: false, reason: 'spec_unreadable' } }
  if (!isObj(spec) || canonicalJson(spec) !== specJson) return { ok: false, reason: 'spec_not_canonical' }
  if (sha256(specJson) !== approvedHash) return { ok: false, reason: 'hash_mismatch' }
  if (!validForkDeploySpec(spec)) return { ok: false, reason: 'spec_invalid' }
  return { ok: true, spec }
}
