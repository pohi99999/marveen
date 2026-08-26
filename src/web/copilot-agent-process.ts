//
// Launch path for fleet agents whose engine is "copilot" (GitHub Copilot
// CLI) instead of Claude Code. Deliberately kept separate from
// agent-process.ts: that file's Claude-specific workarounds (CC-version
// regressions, isolated CLAUDE_CONFIG_DIR, fleet OAuth token, pane-idle
// detection tuned to Claude's TUI) do not apply here and must not be
// entangled with this path. See docs/superpowers/specs/
// 2026-08-26-copilot-fleet-agent-design.md for the full design.
import { join } from 'node:path'
import { agentDir } from './agent-config.js'
import { agentSessionName, shSingleQuote } from './agent-process.js'

export function copilotConfigDir(name: string): string {
  return join(agentDir(name), '.copilot-config')
}

export function buildCopilotLaunchCommand(opts: {
  configDir: string
  resume: boolean
  model?: string
}): string {
  const parts = ['copilot', '--allow-all-tools']
  if (opts.resume) parts.push('--continue')
  parts.push('--config-dir', shSingleQuote(opts.configDir))
  if (opts.model) parts.push('--model', shSingleQuote(opts.model))
  return parts.join(' ')
}

export { agentSessionName }
