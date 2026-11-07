// Who may be taken off the dashboard port when listen() answers EADDRINUSE.
//
// index.ts has the same rule at startup (process-lock.ts findOwnNodeHolders, #1870). This is the later path: a
// listener that appears between that check and listen(), or a holder the startup check left alone because it belongs
// to another install. Without the install check here, a second checkout started on the same port stopped the live
// dashboard, although the startup path had just logged "belongs to a different install, leaving alone".
//
// A holder is taken over only when it is proven ours: this UID, a node or tsx program, and THIS install's dashboard
// entry. What cannot be read is left alone: a port we fail to get ends in a loud exit, a stranger's dashboard stopped is
// silent damage.
//
// Stricter than process-lock.ts argvBelongsToInstall on purpose: that one also accepts an argv that merely names our
// path, or a cwd below the root. Here the entry itself must be ours: its absolute path, or `dist/index.js` run from
// exactly the root. Paths are compared as written, so a root reached through a symlink, or with a space in it, proves
// nothing and is left alone.
import { execFileSync } from 'node:child_process'
import { readlinkSync } from 'node:fs'
import { basename } from 'node:path'
import { runLsof } from '../lsof.js'

export interface PortHolderProbe {
  comm(pid: number): string | null
  uid(pid: number): number | null
  argv(pid: number): string | null
  cwd(pid: number): string | null
}

export interface PortReclaimLog {
  warn(obj: Record<string, unknown>, msg: string): void
}

const ABSOLUTE_ENTRY = /\/(?:dist\/index\.js|src\/index\.ts)$/
const RELATIVE_ENTRY = /^(?:\.\/)?(?:dist\/index\.js|src\/index\.ts)$/

/** Whether this argv runs this install's dashboard. `cwdOf` is lazy: lsof on macOS. */
export function runsThisDashboard(argv: string, projectRoot: string, cwdOf: () => string | null): boolean {
  const tokens = argv.split(/\s+/)
  const absolute = tokens.filter((t) => t.startsWith('/') && ABSOLUTE_ENTRY.test(t))
  if (absolute.length > 0) return absolute.some((t) => t.startsWith(projectRoot + '/') && !t.includes('/node_modules/'))
  return tokens.some((t) => RELATIVE_ENTRY.test(t)) && cwdOf() === projectRoot
}

/** The program's own name: macOS `ps -o comm=` gives the full path, and a directory named node proves nothing. */
export function isNodeProgram(comm: string): boolean {
  return /^(?:node(?:js)?\d*|tsx)$/i.test(basename(comm))
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
    if (!isNodeProgram(comm)) {
      log.warn({ port, pid, cmd: comm }, 'Port held by non-node process -- refusing to kill')
      continue
    }
    const argv = probe.argv(pid)
    if (argv === null || !runsThisDashboard(argv, projectRoot, () => probe.cwd(pid))) {
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
  // Listeners only: a bare `-ti :port` also names every client connected to the port.
  const raw = (runLsof(['-tiTCP:' + port, '-sTCP:LISTEN'], 3000) ?? '').trim()
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
