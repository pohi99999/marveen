import { describe, it, expect, afterEach, vi } from 'vitest'
// Both directions, with real processes on free ports and the real ps and lsof: a holder of this install is taken over,
// a holder of another install is not.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runLsof } from '../lsof.js'
import { isNodeProgram, portReclaimVictims, reclaimPortHolders, runsThisDashboard, systemPortHolderProbe, type PortHolderProbe } from '../web/port-reclaim.js'

const LISTENER = `require('node:net').createServer().listen(Number(process.argv.at(-1)), '127.0.0.1', () => process.stdout.write('up\\n'))`
const CLIENT = `require('node:net').connect(Number(process.argv.at(-1)), '127.0.0.1', () => process.stdout.write('up\\n'))`
// Real processes, ps and lsof: slow on a busy machine, and that is not what these tests measure.
const REAL = { timeout: 30_000 }

const kids: ChildProcess[] = []
const dirs: string[] = []
afterEach(() => {
  for (const k of kids.splice(0)) k.kill('SIGKILL')
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function install(code = LISTENER): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'port-reclaim-')))
  dirs.push(root)
  mkdirSync(join(root, 'dist'))
  writeFileSync(join(root, 'dist', 'index.js'), code)
  return root
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })
}

async function holder(args: string[], cwd: string, port: number): Promise<number> {
  const k = spawn(process.execPath, [...args, String(port)], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
  kids.push(k)
  await new Promise<void>((resolve, reject) => {
    k.stdout!.once('data', () => resolve())
    k.once('exit', () => reject(new Error('holder exited')))
  })
  return k.pid!
}

function holdersOf(port: number): number[] {
  return (runLsof([`-tiTCP:${port}`, '-sTCP:LISTEN'], 3000) ?? '').split('\n').map(Number).filter((n) => n > 0)
}

function decide(port: number, projectRoot: string, selfPid = process.pid) {
  const warn = vi.fn()
  const victims = portReclaimVictims(holdersOf(port), {
    port, selfPid, uid: process.getuid!(), projectRoot, probe: systemPortHolderProbe, log: { warn },
  })
  return { victims, warn }
}

describe('real processes on a real port', REAL, () => {
  it('this install, absolute entry: taken over', async () => {
    const root = install()
    const port = await freePort()
    const pid = await holder([join(root, 'dist', 'index.js')], root, port)
    expect(decide(port, root).victims).toEqual([pid])
  })

  it('this install, relative entry (node dist/index.js): taken over, by its cwd', async () => {
    const root = install()
    const port = await freePort()
    const pid = await holder(['dist/index.js'], root, port)
    expect(decide(port, root).victims).toEqual([pid])
  })

  it('another install, absolute entry: left alone, and said so', async () => {
    const mine = install()
    const other = install()
    const port = await freePort()
    const pid = await holder([join(other, 'dist', 'index.js')], other, port)
    const { victims, warn } = decide(port, mine)
    expect(victims).toEqual([])
    expect(warn).toHaveBeenCalledWith({ port, pid }, expect.stringContaining('another install'))
    process.kill(pid, 0) // still alive
  })

  it('another install, relative entry: left alone, by its cwd', async () => {
    const mine = install()
    const other = install()
    const port = await freePort()
    const pid = await holder(['dist/index.js'], other, port)
    expect(decide(port, mine).victims).toEqual([])
    process.kill(pid, 0)
  })

  it('an entry in another install, with its cwd in this one: left alone', async () => {
    const mine = install()
    const other = install()
    const port = await freePort()
    const pid = await holder([join(other, 'dist', 'index.js')], mine, port)
    expect(decide(port, mine).victims).toEqual([])
    process.kill(pid, 0)
  })

  it('another install, relative entry, with our path named in its argv: left alone', async () => {
    const mine = install()
    const other = install()
    const port = await freePort()
    const pid = await holder(['dist/index.js', `--config=${mine}/x`, `${mine}/y`], other, port)
    expect(decide(port, mine).victims).toEqual([])
    process.kill(pid, 0)
  })

  it('our dist/index.js name, run from below the root: left alone', async () => {
    const mine = install()
    const below = join(mine, 'agents', 'x')
    mkdirSync(join(below, 'dist'), { recursive: true })
    writeFileSync(join(below, 'dist', 'index.js'), LISTENER)
    const port = await freePort()
    const pid = await holder(['dist/index.js'], below, port)
    expect(decide(port, mine).victims).toEqual([])
    process.kill(pid, 0)
  })

  it('a root reached through a symlink proves nothing: left alone, the instance exits instead', async () => {
    const root = install()
    const link = root + '-link'
    symlinkSync(root, link)
    dirs.push(link)
    const port = await freePort()
    await holder([join(root, 'dist', 'index.js')], root, port)
    expect(decide(port, link).victims).toEqual([])
  })

  it('itself: never', async () => {
    const root = install()
    const port = await freePort()
    const pid = await holder(['dist/index.js'], root, port)
    expect(decide(port, root, pid).victims).toEqual([])
  })
})

describe('the program name', () => {
  it.each(['node', 'tsx', 'nodejs', 'node22', '/opt/homebrew/opt/node@22/bin/node', '/usr/local/bin/tsx', process.execPath])('%s is node', (c) => {
    expect(isNodeProgram(c)).toBe(true)
  })
  it.each(['/opt/node-tools/bin/python3', '/Users/x/nodejs/bin/ruby', '/usr/local/bin/tsx-helper', 'node-sass', 'nodemon', '/opt/tsx/bin/bash', 'Google Chrome Helper'])('%s is not', (c) => {
    expect(isNodeProgram(c)).toBe(false)
  })
})

describe('runsThisDashboard', () => {
  const at = (cwd: string | null) => () => cwd
  it.each([
    ['/opt/node /inst/dist/index.js', '/else', true],
    ['node /inst/src/index.ts', null, true],
    ['node dist/index.js', '/inst', true],
    ['tsx ./src/index.ts', '/inst', true],
    ['node /other/dist/index.js', '/inst', false],
    ['node /inst/node_modules/pkg/dist/index.js', '/inst', false],
    ['node /other/dist/index.js /inst/dist/index.js.map', '/inst', false],
    ['node dist/index.js /inst/x', '/other', false],
    ['node dist/index.js', '/inst/agents/x', false],
    ['node dist/index.js', '/inst2', false],
    ['node /inst2/dist/index.js', '/else', false],
    ['node dist/index.js', null, false],
    ['node /inst/scripts/tool.js', '/inst', false],
    ['node server.js', '/inst', false],
  ])('%s from %s: %s', (argv, cwd, want) => {
    expect(runsThisDashboard(argv as string, '/inst', at(cwd as string | null))).toBe(want)
  })
})

describe('what cannot be proven is left alone', () => {
  const base: PortHolderProbe = { comm: () => 'node', uid: () => 501, argv: () => 'node dist/index.js', cwd: () => '/inst' }
  const run = (probe: PortHolderProbe, uid: number | null = 501) => {
    const warn = vi.fn()
    return { victims: portReclaimVictims([7], { port: 1, selfPid: 1, uid, projectRoot: '/inst', probe, log: { warn } }), warn }
  }
  it('the proven case, as the control', () => expect(run(base).victims).toEqual([7]))
  it('a gone process', () => expect(run({ ...base, comm: () => null }).victims).toEqual([]))
  it('another user', () => expect(run({ ...base, uid: () => 502 }).victims).toEqual([]))
  it('an unreadable owner', () => expect(run({ ...base, uid: () => null }).victims).toEqual([]))
  it('a process that is not node or tsx', () => {
    const { victims, warn } = run({ ...base, comm: () => 'Google Chrome Helper' })
    expect(victims).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ pid: 7 }), expect.stringContaining('non-node'))
  })
  it('an unreadable argv', () => expect(run({ ...base, argv: () => null }).victims).toEqual([]))
  it('an unreadable cwd for a relative entry', () => expect(run({ ...base, cwd: () => null }).victims).toEqual([]))
  it('a sibling path that only starts the same', () => expect(run({ ...base, cwd: () => '/inst2' }).victims).toEqual([]))
})

const exited = (pid: number, ms = 3000): Promise<boolean> => new Promise((resolve) => {
  const start = Date.now()
  const t = setInterval(() => {
    const k = kids.find((c) => c.pid === pid)
    if (k?.exitCode !== null || k?.signalCode !== null) { clearInterval(t); resolve(true) } else if (Date.now() - start > ms) { clearInterval(t); resolve(false) }
  }, 50)
})

describe('reclaimPortHolders: the signal goes where the verdict says', REAL, () => {
  it('a client of ours connected to the port is no holder: another install keeps it, the client keeps running', async () => {
    const mine = install(CLIENT)
    const other = install()
    const port = await freePort()
    const listener = await holder(['dist/index.js'], other, port)
    const client = await holder(['dist/index.js'], mine, port)
    expect(reclaimPortHolders(port, { projectRoot: mine, log: { warn: vi.fn() } })).toEqual([])
    expect(await exited(client, 500)).toBe(false)
    expect(await exited(listener, 100)).toBe(false)
  })

  const log = { warn: vi.fn() }
  it('a holder of this install gets SIGTERM and stops', async () => {
    const root = install()
    const port = await freePort()
    const pid = await holder(['dist/index.js'], root, port)
    expect(reclaimPortHolders(port, { projectRoot: root, log })).toEqual([pid])
    expect(await exited(pid)).toBe(true)
    expect(holdersOf(port)).toEqual([])
  })
  it('a holder of another install gets nothing and keeps the port', async () => {
    const mine = install()
    const other = install()
    const port = await freePort()
    const pid = await holder(['dist/index.js'], other, port)
    expect(reclaimPortHolders(port, { projectRoot: mine, log })).toEqual([])
    expect(await exited(pid, 500)).toBe(false)
    expect(holdersOf(port)).toEqual([pid])
  })
})

describe('src/web.ts goes through it', () => {
  const src = readFileSync(join(__dirname, '..', 'web.ts'), 'utf-8')
  const branch = src.slice(src.indexOf("err.code === 'EADDRINUSE'"), src.indexOf('Port-reclaim failed'))
  it('the EADDRINUSE branch asks reclaimPortHolders, and its later SIGKILL covers those only', () => {
    expect(branch).toContain('const victims = reclaimPortHolders(port, { projectRoot: PROJECT_ROOT')
    expect(branch.match(/process\.kill\(/g)).toHaveLength(2) // the liveness probe and the SIGKILL
    expect([...branch.matchAll(/for \(const (\w+) of (\w+)\)/g)].map((m) => m[2])).toEqual(['victims'])
  })
})
