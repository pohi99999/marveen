import { describe, it, expect, vi } from 'vitest'
import { join } from 'node:path'

// Mock agent-process.js to avoid tmux resolution failure on Windows.
// This worktree runs on Windows without tmux; the real tests run in WSL.
vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  shSingleQuote: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
}))

// Mock agent-config.js for agentDir
vi.mock('../web/agent-config.js', () => {
  const AGENTS_BASE_DIR = '/mocked/agents'
  return {
    agentDir: (name: string) => join(AGENTS_BASE_DIR, name),
    AGENTS_BASE_DIR,
  }
})

// Import after mocking so it gets the mocked dependencies
const { buildCopilotLaunchCommand, copilotConfigDir } = await import('../web/copilot-agent-process.js')

describe('buildCopilotLaunchCommand', () => {
  it('builds a fresh-session command with --allow-all-tools and a quoted config-dir', () => {
    const cmd = buildCopilotLaunchCommand({ configDir: '/home/pohi/marveen/agents/coder/.copilot-config', resume: false })
    expect(cmd).toBe(
      "copilot --allow-all-tools --config-dir '/home/pohi/marveen/agents/coder/.copilot-config'",
    )
  })

  it('adds --continue when resume is true', () => {
    const cmd = buildCopilotLaunchCommand({ configDir: '/tmp/cfg', resume: true })
    expect(cmd).toBe("copilot --allow-all-tools --continue --config-dir '/tmp/cfg'")
  })

  it('adds --model when a model is given', () => {
    const cmd = buildCopilotLaunchCommand({ configDir: '/tmp/cfg', resume: false, model: 'gpt-5.2' })
    expect(cmd).toBe("copilot --allow-all-tools --config-dir '/tmp/cfg' --model 'gpt-5.2'")
  })

  it('single-quotes a config-dir path containing a single quote (defence #2, mirrors shSingleQuote use elsewhere)', () => {
    const cmd = buildCopilotLaunchCommand({ configDir: "/tmp/weird'dir", resume: false })
    expect(cmd).toContain(`'/tmp/weird'\\''dir'`)
  })
})

describe('copilotConfigDir', () => {
  it('is a dotdir inside the agent directory, not the shared ~/.copilot', () => {
    expect(copilotConfigDir('coder')).toMatch(/agents[/\\]coder[/\\]\.copilot-config$/)
  })
})
