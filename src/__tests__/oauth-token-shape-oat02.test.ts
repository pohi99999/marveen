// OAT02TOKEN1127: Claude Code 2.1.332 (release notes, 2026-11-25) says the CLAUDE_CODE_OAUTH_TOKEN prefix can end in
// oat02- as well as oat01-. Every place that judges a setup-token by its shape must take both, and nothing else:
// the two TypeScript checks, the PTY extraction, the doctor line and the four installer gates. The shell patterns are
// read out of the files and run with the real grep, so the test measures what the script does, not a copy of it.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { looksLikeSetupToken } from '../web/claude-credentials-guard.js'
import { extractSetupToken } from '../web/setup-token-login.js'

// Fixtures, not tokens: a fixed filler of the token alphabet.
const BODY = 'Ab3_-x'.repeat(16)
const OAT01 = 'sk-ant-oat01-' + BODY
const OAT02 = 'sk-ant-oat02-' + BODY
const ACCEPTED = [OAT01, OAT02]
const REFUSED = [
  'sk-ant-oat03-' + BODY, // an unknown generation stays refused until it is named
  'sk-ant-oat00-' + BODY,
  'sk-ant-oat2-' + BODY,
  'oat02-' + BODY, // the bare suffix without the sk-ant- prefix
  'sk-ant-oat02-' + 'A'.repeat(10), // too short
  'sk-ant-oat02-' + 'A'.repeat(30) + '!' + 'A'.repeat(30), // a character outside the token alphabet
  'sk-ant-api03-' + BODY, // an API key is not a setup-token
  'SK-ANT-OAT02-' + BODY,
  '',
]

describe('looksLikeSetupToken (claude-credentials-guard.ts)', () => {
  for (const t of ACCEPTED) it(`accepts ${t.slice(0, 13)}`, () => expect(looksLikeSetupToken(t)).toBe(true))
  for (const t of REFUSED) it(`refuses ${JSON.stringify(t.slice(0, 16))}`, () => expect(looksLikeSetupToken(t)).toBe(false))
  it('refuses an oat02 token with surrounding whitespace, as it does an oat01 one', () => {
    expect(looksLikeSetupToken(OAT02 + '\n')).toBe(false)
    expect(looksLikeSetupToken('  ' + OAT02)).toBe(false)
  })
})

describe('extractSetupToken (setup-token-login.ts)', () => {
  it('cuts an oat02 token out of coloured CLI output', () => {
    const out = `\x1b[2GYour OAuth token (valid for 1 year):\r\r\n\r\r\n\x1b[2G\x1b[33m${OAT02}\x1b[39m\r\r\n\r\r\n\x1b[2GStore this token securely.\r\r\n`
    expect(extractSetupToken(out)).toBe(OAT02)
  })
  it('keeps taking an oat01 token', () => expect(extractSetupToken(`${OAT01}\r\r\nStore\r\r\n`)).toBe(OAT01))
  it('refuses the shapes the guard refuses', () => {
    for (const t of REFUSED.filter((s) => s.startsWith('sk-ant-'))) expect(extractSetupToken(`${t}\r\n`), t.slice(0, 16)).toBeNull()
  })
  it('agrees with the guard on every fixture (the two shapes are kept in step)', () => {
    for (const t of [...ACCEPTED, ...REFUSED]) {
      if (!t.startsWith('sk-ant-')) continue
      expect(extractSetupToken(t, true) === t, t.slice(0, 16)).toBe(looksLikeSetupToken(t))
    }
  })
})

/** The token patterns a shell file tests with `grep -Eq '<pattern>'`. */
function grepPatterns(file: string): string[] {
  const src = readFileSync(file, 'utf-8')
  return [...src.matchAll(/grep -Eq '(\^sk-ant-oat[^']*)'/g)].map((m) => m[1])
}

function shellAccepts(pattern: string, value: string): boolean {
  try {
    execFileSync('bash', ['-c', 'printf "%s" "$1" | grep -Eq "$2"', '_', value, pattern])
    return true
  } catch { return false }
}

describe('the installer gates', () => {
  for (const [file, count] of [['install-linux.sh', 2], ['install-macos.sh', 2]] as const) {
    it(`${file}: its ${count} token gates take oat01 and oat02, and refuse the rest`, () => {
      const patterns = grepPatterns(file)
      expect(patterns).toHaveLength(count)
      for (const p of patterns) {
        for (const t of ACCEPTED) expect(shellAccepts(p, t), `${p} on ${t.slice(0, 13)}`).toBe(true)
        for (const t of REFUSED) expect(shellAccepts(p, t), `${p} on ${JSON.stringify(t.slice(0, 16))}`).toBe(false)
      }
    })
  }
})

describe('scripts/doctor.sh', () => {
  const line = readFileSync('scripts/doctor.sh', 'utf-8').match(/if grep -qE '(\^CLAUDE_CODE_OAUTH_TOKEN=[^']*)' \.env/)
  it('names the setup-token check once', () => expect(line).not.toBeNull())
  it('calls an oat01 or oat02 .env line a setup-token, and not an API key or the bare suffix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oat02-doctor-'))
    try {
      const env = join(dir, '.env')
      const judged = (value: string) => {
        writeFileSync(env, `CLAUDE_CODE_OAUTH_TOKEN=${value}\n`)
        try { execFileSync('grep', ['-qE', line![1], env]); return true } catch { return false }
      }
      expect(judged(OAT01)).toBe(true)
      expect(judged(OAT02)).toBe(true)
      expect(judged(`"${OAT02}"`)).toBe(true)
      expect(judged('sk-ant-oat03-' + BODY)).toBe(false)
      expect(judged('oat02-' + BODY)).toBe(false)
      expect(judged('sk-ant-api03-' + BODY)).toBe(false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
