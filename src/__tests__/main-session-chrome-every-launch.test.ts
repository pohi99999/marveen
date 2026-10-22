import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildMainSessionRespawnCmd } from '../web/channel-monitor.js'
import { mainConfigDecisionForTest } from '../web/main-config-decision.js'

// The main channels session runs with --chrome (claude-in-chrome on the owner's
// Chrome profile; owner decision 2026-10-22, tg 10035: the main session keeps
// full Chrome access on every restart). channels.sh had it on both of its launch
// lines, but the three RESPAWN paths built their own command without it, so a
// respawn silently dropped the browser: measured 2026-10-22 20:28 on the Mac,
// after the channel-monitor's recovery respawn the main session ran with no
// claude-in-chrome (Zeph 4339). Every main-session launch path is pinned here,
// and a new shell launch line with --channels fails the enumeration below.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8')

// The code lines (no comments) of a script that launch claude for a channel.
const launchLines = (src: string) =>
  src.split('\n').filter((l) => !/^\s*#/.test(l) && l.includes('--dangerously-skip-permissions') && l.includes('--channels'))

// --chrome must sit between the permission flag and --channels, as in channels.sh.
const chromeBeforeChannels = (l: string) => {
  const p = l.indexOf('--dangerously-skip-permissions'); const c = l.indexOf('--chrome'); const ch = l.indexOf('--channels')
  return p >= 0 && c > p && ch > c
}

const respawn = (continueSession: boolean) => buildMainSessionRespawnCmd({
  claudePath: '/usr/local/bin/claude',
  pluginId: 'telegram@claude-plugins-official',
  model: 'claude-opus-4-8[1m]',
  config: mainConfigDecisionForTest(),
  channelStateEnv: { name: 'TELEGRAM_STATE_DIR', dir: '/opt/marveen/.claude/channels/telegram' },
  continueSession,
})

describe('the main channels session keeps --chrome on every launch path', () => {
  it('channels.sh: both launch lines', () => {
    const lines = launchLines(read('scripts/channels.sh'))
    expect(lines.length).toBe(2)
    for (const l of lines) expect(chromeBeforeChannels(l)).toBe(true)
  })

  it('channel-monitor fresh respawn (respawnMainSessionFresh / respawnMarveenSessionFresh), behaviour', () => {
    const cmd = respawn(false)
    expect(cmd).toMatch(/ --chrome /)
    expect(chromeBeforeChannels(cmd)).toBe(true)
  })

  it('channel-monitor recovery resume (resumeMarveenSession, --continue), behaviour', () => {
    const cmd = respawn(true)
    expect(cmd).toContain('--continue')
    expect(cmd).toMatch(/ --chrome /)
    expect(chromeBeforeChannels(cmd)).toBe(true)
  })

  it('every channel-monitor main relaunch goes through the one builder', () => {
    // The builder is the only place the TS side assembles a main-session claude
    // command; three callers (fresh, recovery resume, fresh relaunch) use it.
    const src = read('src/web/channel-monitor.ts')
    expect((src.match(/buildMainSessionRespawnCmd\(\{/g) ?? []).length).toBe(3)
  })

  it('channel-watchdog.sh respawn command', () => {
    const lines = launchLines(read('scripts/channel-watchdog.sh'))
    expect(lines.length).toBe(1)
    expect(chromeBeforeChannels(lines[0])).toBe(true)
  })

  it('stuck-modal-guard.sh respawn command', () => {
    const lines = launchLines(read('scripts/stuck-modal-guard.sh'))
    expect(lines.length).toBe(1)
    expect(chromeBeforeChannels(lines[0])).toBe(true)
  })
})

// Sub-agents do NOT get --chrome: one browser bridge, and the owner's decision is
// about the main session. watchdog.sh relaunches sub-agents, so it is the one
// script exempt from the enumeration.
const SUB_AGENT_LAUNCHERS = new Set(['watchdog.sh'])

describe('no shell launch line with --channels is missing --chrome (enumeration)', () => {
  it('scripts/*.sh', () => {
    const missing: string[] = []
    for (const f of readdirSync(join(ROOT, 'scripts')).filter((n) => n.endsWith('.sh'))) {
      if (SUB_AGENT_LAUNCHERS.has(f)) continue
      for (const l of launchLines(read(`scripts/${f}`))) if (!chromeBeforeChannels(l)) missing.push(f)
    }
    expect(missing).toEqual([])
  })
})
