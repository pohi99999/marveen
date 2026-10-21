/**
 * CMDTASKKILL1772 (#1772): a command task's timeout must end the WHOLE process
 * tree it started, not only the `bash -lc` child. The old kill sent SIGKILL to
 * bash alone; what bash had started (a `&` job, a pipeline member, a curl, a
 * sleep) was re-parented to init and kept running past the task's deadline.
 * The pre-check had the same gap and got the same fix in #1759 (detached +
 * process-group kill).
 *
 * The tests go through runCommandTask, the scheduler's entry point, so they
 * also pin the binding: a fix in a helper nobody calls would not pass.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, TELEGRAM_BOT_TOKEN: '', STORE_DIR: '/tmp' }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const mod = await import('../web/command-task.js')
const { logger } = await import('../logger.js')

// A killed process whose parent is gone is re-parented to PID 1 and stays a
// zombie until PID 1 reaps it. kill(pid, 0) still succeeds on a zombie, so on a
// host whose init reaps late (measured 2026-10-21 in a gVisor container: PID 1
// reaped ~1.2s after the kill, longer under a loaded full-suite run) a process
// that is already dead reads as alive. A zombie runs no code and holds nothing
// but its pid, so it counts as dead here; a sleeping process (state S) is alive.
const alive = (pid: number): boolean => {
  try { process.kill(pid, 0) } catch { return false }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf-8')
    // the state is the first field after the ")" that closes the comm field
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z'
  } catch {
    // no /proc (macOS) or the pid vanished between the two reads: kill(0) is the answer
    return existsSync(`/proc/${pid}`) || process.platform !== 'linux'
  }
}

const leftovers: number[] = []
afterEach(() => {
  for (const pid of leftovers.splice(0)) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  vi.restoreAllMocks()
})

async function runToTimeout(name: string, cmd: string, timeoutMs: number): Promise<void> {
  mod.runCommandTask({ name, type: 'command', command: cmd, agent: 'system', timeoutMs } as never, Math.floor(Date.now() / 1000))
  await vi.waitFor(() => {
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ task: name, ok: false, detail: `timeout ${timeoutMs}ms` }), 'command task ran')
  }, { timeout: timeoutMs + 4000 })
}

describe('command task timeout ends the whole process tree', () => {
  it('a background grandchild (sleep 300 &) does not outlive the timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmdtaskkill-'))
    const pidFile = join(dir, 'grandchild.pid')
    try {
      await runToTimeout('grandchild-probe', `sleep 300 & echo $! > '${pidFile}'; wait`, 1000)
      expect(existsSync(pidFile)).toBe(true)
      const pid = Number(readFileSync(pidFile, 'utf-8').trim())
      expect(pid).toBeGreaterThan(1)
      leftovers.push(pid)
      // The kill is asynchronous to the kernel; give it a moment, then the
      // grandchild must be gone (it was alive when the pid file was written).
      await vi.waitFor(() => { expect(alive(pid)).toBe(false) }, { timeout: 2000 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a pipeline member started by bash does not outlive the timeout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmdtaskkill-'))
    const pidFile = join(dir, 'member.pid')
    try {
      await runToTimeout('pipeline-probe', `sh -c 'echo $$ > "${pidFile}"; exec sleep 300' | cat`, 1000)
      const pid = Number(readFileSync(pidFile, 'utf-8').trim())
      leftovers.push(pid)
      await vi.waitFor(() => { expect(alive(pid)).toBe(false) }, { timeout: 2000 })
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  it('a group kill that fails for another reason than "already gone" is logged, and bash itself is still killed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cmdtaskkill-'))
    const pidFile = join(dir, 'bash.pid')
    const sleepFile = join(dir, 'sleep.pid')
    const realKill = process.kill.bind(process)
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (typeof pid === 'number' && pid < 0) {
        const e = new Error('operation not permitted') as NodeJS.ErrnoException
        e.code = 'EPERM'
        throw e
      }
      return realKill(pid, sig as NodeJS.Signals)
    }) as typeof process.kill)
    try {
      // $$ is bash's own pid (the direct child); the sleep's pid is recorded too,
      // so the cleanup kills exactly this test's orphan and nobody else's.
      await runToTimeout('eperm-probe', `echo $$ > '${pidFile}'; sleep 300 & echo $! > '${sleepFile}'; wait`, 800)
      const bashPid = Number(readFileSync(pidFile, 'utf-8').trim())
      leftovers.push(bashPid, Number(readFileSync(sleepFile, 'utf-8').trim()))
      expect(spy.mock.calls.some(([p, sig]) => typeof p === 'number' && p < 0 && sig === 'SIGKILL')).toBe(true)
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ task: 'eperm-probe', error: 'operation not permitted' }),
        expect.stringContaining('process group'),
      )
      // The fallback: the direct child is killed even though the group kill failed.
      await vi.waitFor(() => { expect(alive(bashPid)).toBe(false) }, { timeout: 2000 })
    } finally {
      spy.mockRestore()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
