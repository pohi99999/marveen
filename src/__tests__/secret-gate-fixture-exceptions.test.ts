import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import {
  scanFileDetailed, fixtureExceptionReason, invalidFixtureExceptions,
  FIXTURE_EXCEPTIONS, type FixtureException,
} from '../security/secret-gate.js'

// A fixture exception clears ONE literal in ONE test file. These cases exist to
// prove the "one" in both halves of that sentence, because the whole reason the
// mechanism was built instead of adding two ALLOWLISTED_PATHS entries is that an
// allowlist entry blinds a whole file.
//
// The mechanism is exercised with SYNTHETIC entries. Testing it through the real
// ones would mean writing their literals here to reproduce the hashes, which
// would put the very secret-shaped strings this exists to contain into one more
// file -- and that file would then need its own exception.

/** Assembled at runtime so this test file carries no key-shaped literal. */
const KEY_A = `sk-${'A'.repeat(30)}`
const KEY_B = `sk-${'B'.repeat(30)}`
const AWS = `AKIA${'ABCDEFGHIJKLMNOP'}`

const hash = (s: string) => createHash('sha256').update(s, 'latin1').digest('hex')

const REASON = 'a synthetic fixture whose raw-secret shape is the subject under test'
const EXC: FixtureException[] = [
  { path: 'src/__tests__/fake-fixture.test.ts', sha256: hash(KEY_A), reason: REASON },
]

describe('fixture exceptions are narrow', () => {
  it('clears the named literal in the named file', () => {
    const r = scanFileDetailed({ path: 'src/__tests__/fake-fixture.test.ts', content: `const k = '${KEY_A}'\n` }, EXC)
    expect(r.findings).toHaveLength(0)
    expect(r.exceptions).toHaveLength(1)
    expect(r.exceptions[0].reason).toBe(REASON)
    expect(r.exceptions[0].line).toBe(1)
  })

  it('the REST of the same file is still scanned -- this is the whole point', () => {
    const content = `const ok = '${KEY_A}'\nconst notOk = '${AWS}'\n`
    const r = scanFileDetailed({ path: 'src/__tests__/fake-fixture.test.ts', content }, EXC)
    expect(r.exceptions).toHaveLength(1)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].reason).toContain('AWS access key id')
    expect(r.findings[0].line).toBe(2)
  })

  it('a DIFFERENT literal in the same file is not covered', () => {
    const r = scanFileDetailed({ path: 'src/__tests__/fake-fixture.test.ts', content: `const k = '${KEY_B}'\n` }, EXC)
    expect(r.exceptions).toHaveLength(0)
    expect(r.findings).toHaveLength(1)
  })

  it('the SAME literal in a different file is not covered', () => {
    const r = scanFileDetailed({ path: 'src/__tests__/other.test.ts', content: `const k = '${KEY_A}'\n` }, EXC)
    expect(r.exceptions).toHaveLength(0)
    expect(r.findings).toHaveLength(1)
  })

  it('editing the fixture invalidates its exception, so the gate goes red and a human looks', () => {
    // The hash is the point: an exception cannot drift onto text nobody approved.
    const r = scanFileDetailed({ path: 'src/__tests__/fake-fixture.test.ts', content: `const k = '${KEY_A}X'\n` }, EXC)
    expect(r.exceptions).toHaveLength(0)
    expect(r.findings).toHaveLength(1)
  })

  it('a non-test path can never carry an exception, even if the hash matches', () => {
    const prod: FixtureException[] = [{ path: 'src/costops/collectors/anthropic.ts', sha256: hash(KEY_A), reason: REASON }]
    expect(fixtureExceptionReason('src/costops/collectors/anthropic.ts', KEY_A, prod)).toBeNull()
    const r = scanFileDetailed({ path: 'src/costops/collectors/anthropic.ts', content: `const k = '${KEY_A}'\n` }, prod)
    expect(r.findings).toHaveLength(1)
    expect(r.exceptions).toHaveLength(0)
  })

  it('a malformed exception is reported rather than silently widening the gate', () => {
    expect(invalidFixtureExceptions([
      { path: 'src/costops/x.ts', sha256: hash(KEY_A), reason: REASON },
    ])[0].reason).toContain('TEST-ONLY')
    expect(invalidFixtureExceptions([
      { path: 'src/__tests__/x.test.ts', sha256: 'nothex', reason: REASON },
    ])[0].reason).toContain('64 lowercase hex')
    expect(invalidFixtureExceptions([
      { path: 'src/__tests__/x.test.ts', sha256: hash(KEY_A), reason: 'because' },
    ])[0].reason).toContain('reason')
  })

  it('the exceptions actually shipped are well formed and test-only', () => {
    expect(invalidFixtureExceptions()).toEqual([])
    for (const e of FIXTURE_EXCEPTIONS) expect(e.path).toMatch(/(^|\/)(__tests__|tests)\//)
  })
})

// The gate used to look at the FIRST occurrence of each pattern only. Once that
// one was excused, every later key of the same shape in the file went unscanned,
// and for the private-key pattern the excused text was the bare armor line, which
// every key of that type shares. These pin both halves of the fix.
const ARMOR = (kind: string, edge: 'BEGIN' | 'END') => `-----${edge} ${kind} PRIVATE KEY-----`
const BLOCK = (kind: string, body: string) => `${ARMOR(kind, 'BEGIN')}\n${body}\n${ARMOR(kind, 'END')}`
const FIXTURE_BLOCK = BLOCK('OPENSSH', '${lines}')
const KEYFILE = 'src/__tests__/fake-key-fixture.test.ts'
const KEY_EXC: FixtureException[] = [{ path: KEYFILE, sha256: hash(FIXTURE_BLOCK), reason: REASON }]
const scanKey = (content: string) => scanFileDetailed({ path: KEYFILE, content }, KEY_EXC)

describe('every occurrence is scanned, and an exception clears only its own', () => {
  it('a second literal of the SAME shape after an excused one is still found', () => {
    const r = scanFileDetailed({ path: 'src/__tests__/fake-fixture.test.ts', content: `const ok = '${KEY_A}'\nconst notOk = '${KEY_B}'\n` }, EXC)
    expect(r.exceptions).toHaveLength(1)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].line).toBe(2)
  })

  it('a closed private-key block is matched whole, so the exception names that one block', () => {
    const r = scanKey(`const pem = \`${FIXTURE_BLOCK}\`\n`)
    expect(r.findings).toHaveLength(0)
    expect(r.exceptions).toHaveLength(1)
  })

  it('another key block AFTER the excused one is found (2b)', () => {
    const r = scanKey(`const pem = \`${FIXTURE_BLOCK}\`\n// ${ARMOR('RSA', 'BEGIN')}\n`)
    expect(r.exceptions).toHaveLength(1)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].line).toBe(4)
  })

  it('a second armor line of the SAME type before the excused block is found (2c)', () => {
    const r = scanKey(`// ${ARMOR('OPENSSH', 'BEGIN')}\nconst pem = \`${FIXTURE_BLOCK}\`\n`)
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0].line).toBe(1)
  })

  it('an exception keyed on the bare armor line clears no closed block of that type (the root of 2c)', () => {
    // What the old gate needed for the vault-ssh fixture: the armor line was the whole match, so its
    // hash cleared every key of that type in the file.
    const headerOnly: FixtureException[] = [{ path: KEYFILE, sha256: hash(ARMOR('OPENSSH', 'BEGIN')), reason: REASON }]
    const r = scanFileDetailed({ path: KEYFILE, content: `const pem = \`${BLOCK('OPENSSH', 'b3BlbnNzaC1rZXktdjEAAAAA')}\`\n` }, headerOnly)
    expect(r.exceptions).toHaveLength(0)
    expect(r.findings).toHaveLength(1)
  })

  it('the same armor with a different body is a different block: not covered', () => {
    const r = scanKey(`const pem = \`${BLOCK('OPENSSH', 'b3BlbnNzaC1rZXktdjEAAAAA')}\`\n`)
    expect(r.exceptions).toHaveLength(0)
    expect(r.findings).toHaveLength(1)
  })

  it('a bare BEGIN line with no END is still a finding: the pattern did not loosen', () => {
    const r = scanFileDetailed({ path: 'src/__tests__/other.test.ts', content: `${ARMOR('EC', 'BEGIN')}\nMHcCAQEE\n` }, [])
    expect(r.findings).toHaveLength(1)
  })

})
