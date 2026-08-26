import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

// Mock agent-process.js to avoid tmux resolution failure on Windows.
// This worktree runs on Windows without tmux; the real tests run in WSL.
// isAgentRunning/runTmux are mocked as controllable spies so
// startCopilotAgentProcess's branching (already-running guard, tmux launch
// args, tmux-failure handling) is unit-testable without a real tmux binary.
const isAgentRunningMock = vi.fn<(name: string) => boolean>(() => false)
const runTmuxMock = vi.fn<(host: string | null, args: string[], opts?: { timeout?: number }) => void>()

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  shSingleQuote: (value: string) => `'${value.replace(/'/g, `'\\''`)}'`,
  isAgentRunning: (name: string) => isAgentRunningMock(name),
  runTmux: (host: string | null, args: string[], opts?: { timeout?: number }) => runTmuxMock(host, args, opts),
}))

// Mock agent-config.js for agentDir
vi.mock('../web/agent-config.js', () => {
  const AGENTS_BASE_DIR = '/mocked/agents'
  return {
    agentDir: (name: string) => join(AGENTS_BASE_DIR, name),
    AGENTS_BASE_DIR,
  }
})

// existsSync is used both for the "agent directory exists" guard and the
// "session-state file present" resume check; a controllable mock lets each
// test steer both independently by path. mkdirSync is a no-op spy.
const existsSyncMock = vi.fn<(path: any) => boolean>(() => true)
const mkdirSyncMock = vi.fn()
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: any) => existsSyncMock(path),
    mkdirSync: (path: any, opts?: any) => mkdirSyncMock(path, opts),
  }
})

// Import after mocking so it gets the mocked dependencies
const { buildCopilotLaunchCommand, copilotConfigDir, startCopilotAgentProcess, formatCopilotInboundMessage } = await import('../web/copilot-agent-process.js')

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

describe('startCopilotAgentProcess', () => {
  beforeEach(() => {
    isAgentRunningMock.mockReset().mockReturnValue(false)
    runTmuxMock.mockReset()
    existsSyncMock.mockReset().mockReturnValue(true) // agent dir exists, no session-state (overridden per test)
    mkdirSyncMock.mockReset()
  })

  it('returns "Agent not found" when the agent directory does not exist', () => {
    existsSyncMock.mockImplementation((p: string) => !String(p).includes('coder'))
    const result = startCopilotAgentProcess('coder')
    expect(result).toEqual({ ok: false, error: 'Agent not found' })
    expect(runTmuxMock).not.toHaveBeenCalled()
  })

  it('returns "Agent is already running" without touching tmux when isAgentRunning is true', () => {
    isAgentRunningMock.mockReturnValue(true)
    const result = startCopilotAgentProcess('coder')
    expect(result).toEqual({ ok: false, error: 'Agent is already running' })
    expect(runTmuxMock).not.toHaveBeenCalled()
  })

  it('launches a fresh (non-resume) session when no session-state file exists', () => {
    existsSyncMock.mockImplementation((p: string) => !String(p).includes('session-state'))
    const result = startCopilotAgentProcess('coder')
    expect(result).toEqual({ ok: true })
    expect(mkdirSyncMock).toHaveBeenCalledWith(
      expect.stringMatching(/agents[/\\]coder[/\\]\.copilot-config$/),
      { recursive: true },
    )
    expect(runTmuxMock).toHaveBeenCalledTimes(1)
    const [host, args] = runTmuxMock.mock.calls[0]
    expect(host).toBeNull()
    expect(args[0]).toBe('new-session')
    expect(args).toContain('-s')
    expect(args).toContain('agent-coder')
    const cmd = args[args.length - 1]
    expect(cmd).toContain('copilot --allow-all-tools')
    expect(cmd).not.toContain('--continue')
  })

  it('resumes (passes --continue) when a session-state file exists and fresh is not set', () => {
    existsSyncMock.mockReturnValue(true) // agent dir AND session-state both exist
    const result = startCopilotAgentProcess('coder')
    expect(result).toEqual({ ok: true })
    const cmd = runTmuxMock.mock.calls[0][1].pop()
    expect(cmd).toContain('--continue')
  })

  it('does not resume when opts.fresh is true even if a session-state file exists', () => {
    existsSyncMock.mockReturnValue(true)
    startCopilotAgentProcess('coder', { fresh: true })
    const cmd = runTmuxMock.mock.calls[0][1].pop()
    expect(cmd).not.toContain('--continue')
  })

  it('reports a tmux launch failure instead of throwing', () => {
    existsSyncMock.mockReturnValue(true)
    runTmuxMock.mockImplementation(() => {
      throw new Error('no server running')
    })
    const result = startCopilotAgentProcess('coder')
    expect(result).toEqual({ ok: false, error: 'tmux launch failed: no server running' })
  })
})

describe('formatCopilotInboundMessage', () => {
  it('frames an inter-agent message the same way the Claude path does', () => {
    expect(formatCopilotInboundMessage('marveen', 'Fix the login bug')).toBe(
      '[Uzenet @marveen-tol]: Fix the login bug',
    )
  })
})
