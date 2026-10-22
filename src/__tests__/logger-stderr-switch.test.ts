// MARVEEN_LOG_STDERR=1 must route every log line to stderr, in both logger modes (pino-pretty transport when not
// production, plain pino when production); unset, the logger writes to stdout as before. The real logger runs in a
// child process (the transport is a worker thread writing to the fd itself, so only a separate process shows it).
// Why: vault-resolve.mjs's stdout is data for vault-env-wrapper.sh (Mac mini, 2026-10-22).
import { describe, it, expect } from 'vitest'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'

const LOGGER = join(process.cwd(), 'src', 'logger.ts')
const PROBE = 'logger-stderr-switch-probe-7c1'

// A script FILE, not -e: the pino-pretty transport is a worker thread that inherits execArgv, and
// --input-type (needed for -e) is refused there (ERR_INPUT_TYPE_NOT_ALLOWED).
const SCRIPT = join(mkdtempSync(join(tmpdir(), 'logger-stderr-')), 'probe.mjs')
writeFileSync(SCRIPT, `const m = await import(${JSON.stringify(LOGGER)}); m.logger.warn(${JSON.stringify(PROBE)}); setTimeout(() => process.exit(0), 800)\n`)

function run(env: Record<string, string | undefined>): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx', SCRIPT],
      { env: { ...process.env, LOG_LEVEL: 'info', MARVEEN_LOG_STDERR: undefined, ...env }, timeout: 20_000 },
      (_e, stdout, stderr) => resolve({ stdout, stderr }))
  })
}

describe('MARVEEN_LOG_STDERR', { timeout: 30_000 }, () => {
  for (const mode of ['development', 'production']) {
    it(`${mode}: =1 sends the log line to stderr, stdout stays clean`, async () => {
      const r = await run({ NODE_ENV: mode, MARVEEN_LOG_STDERR: '1' })
      expect(r.stdout).not.toContain(PROBE)
      expect(r.stderr).toContain(PROBE)
    })
    it(`${mode}: unset, the log line is on stdout as before`, async () => {
      const r = await run({ NODE_ENV: mode })
      expect(r.stdout).toContain(PROBE)
      expect(r.stderr).not.toContain(PROBE)
    })
  }
})
