// vault-resolve.mjs's stdout is DATA (KEY=value lines that vault-env-wrapper.sh exports), so it must set
// MARVEEN_LOG_STDERR=1 BEFORE it imports the vault module: the module's logger is created on import. The stub
// vault.js below writes a log-like line to stdout when the switch is missing -- exactly what the macOS Keychain
// migration did on the Mac mini (2026-10-22). Same harness as vault-resolve-loud-failures.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = mkdtempSync(join(tmpdir(), 'vault-resolve-clean-'))
const VALUE = 'sv-9b2d-not-a-real-secret'

function run(stdin: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [join(ROOT, 'scripts', 'vault-resolve.mjs')], (_e, stdout, stderr) => resolve({ stdout, stderr }))
    child.stdin!.end(stdin)
  })
}

beforeAll(() => {
  mkdirSync(join(ROOT, 'scripts'), { recursive: true })
  mkdirSync(join(ROOT, 'dist', 'web'), { recursive: true })
  copyFileSync(join(process.cwd(), 'scripts', 'vault-resolve.mjs'), join(ROOT, 'scripts', 'vault-resolve.mjs'))
  writeFileSync(join(ROOT, 'dist', 'web', 'vault.js'), [
    `const line = '[2026-10-22 16:58:16.060 +0200] WARN (1): Keychain migration failed, keeping file-based key\\n'`,
    `if (process.env.MARVEEN_LOG_STDERR === '1') process.stderr.write(line); else process.stdout.write(line)`,
    `export function getSecret(id) { return id === 'KNOWN' ? '${VALUE}' : null }`,
  ].join('\n') + '\n')
})
afterAll(() => rmSync(ROOT, { recursive: true, force: true }))

describe('vault-resolve.mjs keeps its stdout to KEY=value lines', () => {
  it('a log line written while the vault module loads goes to stderr, not stdout', async () => {
    const r = await run('TOKEN_A=KNOWN\n')
    expect(r.stdout).toBe(`TOKEN_A=${VALUE}\n`)
    expect(r.stderr).toContain('Keychain migration failed')
  })
  it('every stdout line is KEY=value (what vault-env-wrapper.sh exports)', async () => {
    const r = await run('TOKEN_A=KNOWN\nTOKEN_B=KNOWN\n')
    for (const line of r.stdout.trim().split('\n')) expect(line).toMatch(/^[A-Za-z_][A-Za-z0-9_]*=/)
  })
})
