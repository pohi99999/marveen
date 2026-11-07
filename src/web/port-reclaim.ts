// Who may be taken off the dashboard port when listen() answers EADDRINUSE.
//
// index.ts has the same rule at startup (process-lock.ts findOwnNodeHolders, #1870). This is the later path: a
// listener that appears between that check and listen(), or a holder the startup check left alone because it belongs
// to another install. Without the install check here, a second checkout started on the same port stopped the live
// dashboard, although the startup path had just logged "belongs to a different install, leaving alone".
//
// A holder is taken over only when it is proven ours: this UID, a node or tsx process, and this install by its argv and
// cwd. What cannot be read is left alone: a port we fail to get ends in a loud exit, a stranger's dashboard stopped is
// silent damage.
import { execFileSync } from 'node:child_process'
import { readlinkSync } from 'node:fs'
import { runLsof } from '../lsof.js'
import { argvBelongsToInstall } from '../process-lock.js'

export interface PortHolderProbe {
  comm(pid: number): string | null
  uid(pid: number): number | null
  argv(pid: number): string | null
  cwd(pid: number): string | null
}

export interface PortReclaimLog {
  warn(obj: Record<string, unknown>, msg: string): void
}

export function portReclaimVictims(
  pids: readonly number[],
  opts: { port: number; selfPid: number; uid: number | null; projectRoot: string; probe: PortHolderProbe; log: PortReclaimLog },
): number[] {
  const { port, selfPid, uid, projectRoot, probe, log } = opts
  const victims: number[] = []
  for (const pid of pids) {
    if (pid === selfPid) continue
    const comm = probe.comm(pid)
    if (comm === null) continue
    if (uid !== null && probe.uid(pid) !== uid) continue
    if (!/node|tsx/i.test(comm)) {
      log.warn({ port, pid, cmd: comm }, 'Port held by non-node process -- refusing to kill')
      continue
    }
    const argv = probe.argv(pid)
    if (argv === null || !argvBelongsToInstall(argv, projectRoot, () => probe.cwd(pid))) {
      log.warn({ port, pid }, 'Port held by a process of another install -- refusing to kill')
      continue
    }
    victims.push(pid)
  }
  return victims
}

/** The holders of `port` that are proven ours get SIGTERM. Returns them, for the caller's later SIGKILL and re-listen. */
export function reclaimPortHolders(
  port: number,
  opts: { projectRoot: string; log: PortReclaimLog; selfPid?: number; probe?: PortHolderProbe },
): number[] {
  const raw = (runLsof(['-ti', `:${port}`], 3000) ?? '').trim()
  const pids = raw.split('\n').map((s) => s.trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n > 0)
  const victims = portReclaimVictims(pids, {
    port,
    selfPid: opts.selfPid ?? process.pid,
    uid: typeof process.getuid === 'function' ? process.getuid() : null,
    projectRoot: opts.projectRoot,
    probe: opts.probe ?? systemPortHolderProbe,
    log: opts.log,
  })
  for (const pid of victims) {
    try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
  }
  return victims
}

function ps(pid: number, field: string): string | null {
  try {
    return execFileSync('/bin/ps', ['-p', String(pid), '-o', `${field}=`], { timeout: 2000, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null
  } catch {
    return null
  }
}

export const systemPortHolderProbe: PortHolderProbe = {
  comm: (pid) => ps(pid, 'comm'),
  uid: (pid) => {
    const n = parseInt(ps(pid, 'uid') ?? '', 10)
    return Number.isFinite(n) ? n : null
  },
  argv: (pid) => ps(pid, 'command'),
  cwd: (pid) => {
    try {
      return readlinkSync(`/proc/${pid}/cwd`)
    } catch { /* not Linux or no access; lsof on macOS */ }
    const raw = runLsof(['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], 2000)
    const line = raw?.split('\n').find((l) => l.startsWith('n'))
    return line ? line.slice(1) : null
  },
}
