import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Contract + behaviour test for the channels.sh orphan reap (33258ff2).
// 2026-09-18 03:01: the env-only `ps eww` match selected the shared tmux
// server and everything under it (156 processes) and killed the fleet plus
// the dashboard. The two reap passes must gate on a POLLER argv shape, and
// the script must not keep TELEGRAM_STATE_DIR exported into the shell that
// creates the tmux server. The awk programs are extracted from the REAL
// script and executed against a fixture, so this measures behaviour, not a
// comment.

const ROOT = join(__dirname, '..', '..')
const src = readFileSync(join(ROOT, 'scripts/channels.sh'), 'utf-8')

const FIXTURE = [
  ' 360935 ?        Ss     0:03 /usr/bin/tmux new-session -d -s marveen-channels HOME=/h TELEGRAM_STATE_DIR=/h/marveen/.claude/channels/telegram',
  ' 361103 pts/2    Sl+    0:00 bun run --cwd /h/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7 --silent start HOME=/h TELEGRAM_STATE_DIR=/h/marveen/.claude/channels/telegram CLAUDE_PLUGIN_ROOT=/h/.claude/plugins/cache/claude-plugins-official/telegram',
  ' 361142 pts/2    Sl+    0:32 /h/.bun/bin/bun server.ts HOME=/h TELEGRAM_STATE_DIR=/h/marveen/.claude/channels/telegram CLAUDE_PLUGIN_ROOT=/h/.claude/plugins/cache/claude-plugins-official/telegram',
  ' 420297 pts/5    Ssl+   0:07 /h/.local/bin/claude --continue HOME=/h TELEGRAM_STATE_DIR=/h/marveen/.claude/channels/telegram CLAUDE_PLUGIN_ROOT=/h/.claude/plugins/cache/claude-plugins-official/telegram',
  ' 421139 pts/6    Sl+    0:01 podman run -i --rm ghcr.io/github/github-mcp-server HOME=/h TELEGRAM_STATE_DIR=/h/marveen/.claude/channels/telegram',
  ' 500001 pts/9    Sl+    0:00 bun run --cwd /h/.claude/plugins/cache/claude-plugins-official/telegram/0.0.7 --silent start HOME=/h TELEGRAM_STATE_DIR=/h/marveen/agents/aura/.claude/channels/telegram CLAUDE_PLUGIN_ROOT=/h/.claude/plugins/cache/claude-plugins-official/telegram',
].join('\n') + '\n'

function awkProgram(varName: string): string {
  const m = src.match(new RegExp(`${varName}="\\$\\(/bin/ps eww -e 2>/dev/null \\| awk (.*?)\\)"\\n`))
  expect(m, `${varName} ps|awk line not found in channels.sh`).not.toBeNull()
  return m![1]!
}
function runAwk(argsSpec: string, vars: Record<string, string>): number[] {
  const prog = argsSpec.match(/'([^']*)'\s*$/)![1]!
  const args: string[] = []
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`)
  const out = execFileSync('awk', [...args, prog], { input: FIXTURE, encoding: 'utf-8' })
  return out.split('\n').filter(Boolean).map(Number)
}

describe('channels.sh orphan reap: poller-only gate', () => {
  it('first pass (STATE_DIR needle) reaps only the two bun poller rows, never tmux/claude/podman', () => {
    const pids = runAwk(awkProgram('ORPHAN_PIDS'), { needle: 'TELEGRAM_STATE_DIR=/h/marveen/.claude/channels/telegram' })
    expect(pids).toEqual([361103, 361142])
  })
  it('second pass (CLAUDE_PLUGIN_ROOT) reaps only main pollers, never the agent claude and never the sub-agent poller', () => {
    const pids = runAwk(awkProgram('ORPHAN_PIDS2'), { needle: 'CLAUDE_PLUGIN_ROOT=', prov: '/telegram', subdir: '/h/marveen/agents/' })
    expect(pids).toEqual([361103, 361142])
  })
  it('does not leave the main STATE_DIR exported in the shell that creates the tmux server', () => {
    const exportIdx = src.indexOf('export "$STATE_ENV_VAR"="$MAIN_CHAN_DIR"')
    const unsetIdx = src.indexOf('unset "$STATE_ENV_VAR"')
    const startServerIdx = src.indexOf('$TMUX start-server')
    expect(exportIdx).toBeGreaterThan(0)
    expect(unsetIdx).toBeGreaterThan(exportIdx)
    expect(startServerIdx).toBeGreaterThan(unsetIdx)
  })
})
