//
// Launch path for fleet agents whose engine is "copilot" (GitHub Copilot
// CLI) instead of Claude Code. Deliberately kept separate from
// agent-process.ts: that file's Claude-specific workarounds (CC-version
// regressions, isolated CLAUDE_CONFIG_DIR, fleet OAuth token, pane-idle
// detection tuned to Claude's TUI) do not apply here and must not be
// entangled with this path. See docs/superpowers/specs/
// 2026-08-26-copilot-fleet-agent-design.md for the full design.
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { agentDir } from './agent-config.js'
import { agentSessionName, isAgentRunning, runTmux, shSingleQuote } from './agent-process.js'

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

// Launches a copilot-engine agent's tmux session. Mirrors the shape of
// startAgentProcess (agent-process.ts) so route handlers don't need to know
// which engine ran, but deliberately skips all of that function's
// Claude-specific scaffolding (channel-provider resolution, isolated
// CLAUDE_CONFIG_DIR, fleet OAuth token, "trust this folder" dialogs) -- none
// of it applies to the Copilot CLI. isAgentRunning is safe to reuse as-is:
// it's a pure tmux-session-existence check (agentRunState -> `tmux
// list-sessions` string match), with no Claude-specific pane inspection --
// see agent-process.ts around line 810-829 and ssh-tmux.ts's
// classifyRunState/sessionInList.
export function startCopilotAgentProcess(
  name: string,
  opts: { fresh?: boolean } = {},
): { ok: boolean; pid?: number; error?: string } {
  const dir = agentDir(name)
  if (!existsSync(dir)) return { ok: false, error: 'Agent not found' }
  if (isAgentRunning(name)) return { ok: false, error: 'Agent is already running' }

  const configDir = copilotConfigDir(name)
  mkdirSync(configDir, { recursive: true })

  const session = agentSessionName(name)
  const resume = existsSync(join(configDir, 'session-state')) && !opts.fresh
  const cmd = buildCopilotLaunchCommand({ configDir, resume })

  try {
    runTmux(null, ['new-session', '-d', '-s', session, '-c', dir, cmd])
  } catch (err: any) {
    return { ok: false, error: `tmux launch failed: ${err.message}` }
  }
  return { ok: true }
}

// Frames an inter-agent message the same way the Claude path's trusted/
// untrusted envelope does its visible `[Uzenet @<felado>-tol]: ...` line (see
// agent-message-wrap.ts), so a receiving agent sees an identical-looking
// envelope regardless of which engine sent or receives it. Deliberately
// skips the preamble/trust-classification/msg_id machinery that
// wrapAgentMessageForDelivery adds -- this is the minimal viable envelope
// for a copilot-engine recipient; revisit once this has real usage data.
export function formatCopilotInboundMessage(from: string, content: string): string {
  return `[Uzenet @${from}-tol]: ${content}`
}

// Delivers a prompt into a copilot-engine agent's tmux session. Deliberately
// NOT reusing waitForPaneIdle/paneLooksIdle/clearInputBuffer from
// agent-process.ts -- those are tuned to Claude Code's TUI (see
// docs/superpowers/specs/2026-08-26-copilot-fleet-agent-design.md, Risks) and
// are unsafe to reuse as-is against the Copilot CLI's different TUI. Simple,
// conservative delivery instead: send the literal text, then Enter, with a
// fixed settle delay. Less robust than the Claude path; revisit once this
// has real usage data.
export async function sendPromptToCopilotSession(session: string, text: string): Promise<'sent'> {
  runTmux(null, ['send-keys', '-t', session, '-l', text])
  await new Promise((resolve) => setTimeout(resolve, 300))
  runTmux(null, ['send-keys', '-t', session, 'Enter'])
  return 'sent'
}

export { agentSessionName }
