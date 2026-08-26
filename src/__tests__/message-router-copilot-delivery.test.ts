// Contract test for the ENGINE GATE in runMessageRouterTick().
//
// This test deliberately enters the router from ABOVE the readiness gate, not
// at the delivery branch. That distinction is the whole point of the file: a
// test that only exercised the branch body would have passed against the
// original implementation, in which the Copilot branch was UNREACHABLE in
// production.
//
// The bug it locks down: every message must pass isSessionReadyForPrompt()
// before reaching the engine branch, and that gate is Claude-TUI-specific
// (capturePane -> detectPaneState matches Claude Code's status-footer regex).
// A Copilot CLI pane never renders that footer, so the gate never opened.
// Because the session DOES exist, shouldAbandon's `!sessionExists` condition
// never fired either: messages to a copilot-engine agent re-queued forever --
// never delivered, never abandoned -- and after ~10 min the stuck-session
// escalation fired and re-fired every ~10 min into the main agent's inbox.
//
// Mocking pattern copied from message-router-tick-cap.test.ts (agent-process.js
// is mocked wholesale: this worktree is Windows without tmux; the real runtime
// is WSL).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockSessionExistsOnHost = vi.fn((..._a: unknown[]) => true)
const mockReadAgentEngine = vi.fn((_name: string) => 'claude' as 'claude' | 'copilot')
const mockIsSessionReadyForPrompt = vi.fn(async (..._a: unknown[]) => false)
const mockClearStaleParkedInput = vi.fn(async (..._a: unknown[]) => false)
const mockSendPromptToSession = vi.fn(async (..._a: unknown[]) => 'sent')
const mockSendPromptToCopilotSession = vi.fn(async (..._a: unknown[]) => 'sent')
const mockFormatCopilotInboundMessage = vi.fn(
  (from: string, content: string, category: string) => `[${category}][Uzenet @${from}-tol]: ${content}`,
)
const mockClassifyAgentMessage = vi.fn((..._a: unknown[]) => ({
  category: 'trusted-peer' as string,
  safeFrom: 'orin',
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  MAIN_AGENT_ID: 'orin',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: false,
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent?: string) => {
    if (toAgent) return [] // per-agent query for the reconnect pre-pass
    return mockGetPendingMessages()
  },
  markMessageDelivered: (...a: unknown[]) => mockMarkDelivered(...a),
  markMessageFailed: (...a: unknown[]) => mockMarkFailed(...a),
  markMessageDone: (..._a: unknown[]) => true,
  markPendingFederatedFailed: (..._a: unknown[]) => true,
  setMessageResult: (..._a: unknown[]) => undefined,
  createAgentMessage: (..._a: unknown[]) => ({ id: 999 }),
  stampMessageTrace: (..._a: unknown[]) => false,
  upsertOtelSpan: (..._a: unknown[]) => undefined,
  closeOtelSpan: (..._a: unknown[]) => false,
}))

vi.mock('../web/voice-directive.js', () => ({
  resolveAgentChannelStateDir: () => '/tmp/none',
}))

vi.mock('../web/agent-config.js', () => ({
  readAgentRemoteHost: () => null,
  readAgentVoiceConfig: () => ({ responseMode: 'text' }),
  readAgentEngine: (name: string) => mockReadAgentEngine(name),
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (name: string) => `agent-${name}`,
  isSessionReadyForPrompt: (...a: unknown[]) => mockIsSessionReadyForPrompt(...a),
  clearStaleParkedInput: (...a: unknown[]) => mockClearStaleParkedInput(...a),
  sendPromptToSession: (...a: unknown[]) => mockSendPromptToSession(...a),
  sessionExistsOnHost: (...a: unknown[]) => mockSessionExistsOnHost(...a),
  capturePane: (..._a: unknown[]) => null,
}))

vi.mock('../web/copilot-agent-process.js', () => ({
  sendPromptToCopilotSession: (...a: unknown[]) => mockSendPromptToCopilotSession(...a),
  formatCopilotInboundMessage: (from: string, content: string, category: string) =>
    mockFormatCopilotInboundMessage(from, content, category),
}))

vi.mock('../web/voice-modality.js', () => ({
  setLastInboundModality: vi.fn(),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'orin-channels',
}))

vi.mock('../web/agent-message-wrap.js', () => ({
  classifyAgentMessage: (...a: unknown[]) => mockClassifyAgentMessage(...a),
  wrapAgentMessageForDelivery: () => ({ prefix: 'PREFIX ', wrapped: 'WRAPPED' }),
}))

import { runMessageRouterTick } from '../web/message-router.js'

// Old enough that the stale-parked-input janitor is eligible to run on the
// not-ready path (JANITOR_PARKED_MIN_AGE_MS is 45s), well inside the 1h abandon
// window. This is what makes "clearStaleParkedInput is NOT called for copilot"
// a real assertion rather than a vacuous one.
const AGE_SECONDS = 120

function pendingTo(agent: string, content = 'ping', from = 'orin') {
  const nowSec = Math.floor(Date.now() / 1000)
  return [{
    id: Math.floor(Math.random() * 1_000_000) + 1000,
    from_agent: from,
    to_agent: agent, // a SUB-agent, not MAIN_AGENT_ID -> takes the tmux-inject path
    content,
    created_at: nowSec - AGE_SECONDS,
    origin_note: null,
    trace_id: null,
    span_id: null,
  }]
}

describe('message router: copilot-engine delivery reaches the pane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(true) // session is ALIVE -> never abandoned
    mockMarkDelivered.mockReturnValue(true)
    mockMarkFailed.mockReturnValue(true)
    // The Claude readiness gate NEVER opens in this file. For a Claude-engine
    // agent that means "not ready, retry"; for a Copilot agent it must be
    // irrelevant, because the gate must not be consulted at all.
    mockIsSessionReadyForPrompt.mockResolvedValue(false)
    mockClearStaleParkedInput.mockResolvedValue(false)
    mockClassifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })
  })

  it('delivers to a copilot-engine agent WITHOUT consulting the Claude readiness gate', async () => {
    mockReadAgentEngine.mockReturnValue('copilot')
    mockGetPendingMessages.mockReturnValue(pendingTo('copi-a'))

    await runMessageRouterTick()

    // THE fix for the critical finding: the gate is bypassed entirely...
    expect(mockIsSessionReadyForPrompt).not.toHaveBeenCalled()
    // ...including the Claude-TUI-tuned janitor that lives inside its block.
    expect(mockClearStaleParkedInput).not.toHaveBeenCalled()
    // ...and delivery actually happens, on the Copilot path only.
    expect(mockSendPromptToCopilotSession).toHaveBeenCalledTimes(1)
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
    expect(mockSendPromptToCopilotSession.mock.calls[0][0]).toBe('agent-copi-a')
    // The message is closed out, so it stops re-queueing forever.
    expect(mockMarkDelivered).toHaveBeenCalledTimes(1)
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('resolves the destination engine exactly ONCE per message', async () => {
    mockReadAgentEngine.mockReturnValue('copilot')
    mockGetPendingMessages.mockReturnValue(pendingTo('copi-b'))

    await runMessageRouterTick()

    expect(mockReadAgentEngine).toHaveBeenCalledTimes(1)
    expect(mockReadAgentEngine).toHaveBeenCalledWith('copi-b')
  })

  it('passes the SANITIZED sender and the trust category into the Copilot envelope', async () => {
    mockReadAgentEngine.mockReturnValue('copilot')
    // A federated sender: raw id carries the slash, safeFrom is the sanitized form.
    mockClassifyAgentMessage.mockReturnValue({ category: 'federated', safeFrom: 'peer/bob' })
    mockGetPendingMessages.mockReturnValue(pendingTo('copi-c', 'do a thing', 'peer/bob\nforged line'))

    await runMessageRouterTick()

    expect(mockFormatCopilotInboundMessage).toHaveBeenCalledTimes(1)
    const [from, content, category] = mockFormatCopilotInboundMessage.mock.calls[0]
    expect(from).toBe('peer/bob')            // safeFrom, NOT the raw from_agent
    expect(from).not.toContain('forged')
    expect(content).toBe('do a thing')
    expect(category).toBe('federated')       // trust category is carried through
  })

  it('carries the trusted-peer category through unchanged for a trusted sender', async () => {
    mockReadAgentEngine.mockReturnValue('copilot')
    mockGetPendingMessages.mockReturnValue(pendingTo('copi-d'))

    await runMessageRouterTick()

    expect(mockFormatCopilotInboundMessage.mock.calls[0][2]).toBe('trusted-peer')
  })
})

describe('message router: the Claude-engine path is unchanged', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(true)
    mockMarkDelivered.mockReturnValue(true)
    mockMarkFailed.mockReturnValue(true)
    mockReadAgentEngine.mockReturnValue('claude')
    mockClearStaleParkedInput.mockResolvedValue(false)
    mockClassifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })
  })

  it('still consults the readiness gate, and holds the message when it is closed', async () => {
    mockIsSessionReadyForPrompt.mockResolvedValue(false)
    mockGetPendingMessages.mockReturnValue(pendingTo('cc-a'))

    await runMessageRouterTick()

    // Gate consulted, exactly as before the engine branch existed.
    expect(mockIsSessionReadyForPrompt).toHaveBeenCalledTimes(1)
    expect(mockIsSessionReadyForPrompt).toHaveBeenCalledWith('agent-cc-a', null)
    // The janitor inside the not-ready block still runs for Claude agents.
    expect(mockClearStaleParkedInput).toHaveBeenCalledTimes(1)
    // Nothing delivered; the message stays pending (not failed) for the next tick.
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
    expect(mockSendPromptToCopilotSession).not.toHaveBeenCalled()
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('delivers through sendPromptToSession with the Claude wrap once the gate opens', async () => {
    mockIsSessionReadyForPrompt.mockResolvedValue(true)
    mockGetPendingMessages.mockReturnValue(pendingTo('cc-b'))

    await runMessageRouterTick()

    expect(mockIsSessionReadyForPrompt).toHaveBeenCalledTimes(1)
    expect(mockSendPromptToCopilotSession).not.toHaveBeenCalled()
    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
    // Same (session, text, host) shape the Claude path always used.
    expect(mockSendPromptToSession).toHaveBeenCalledWith('agent-cc-b', 'PREFIX WRAPPED', null)
    expect(mockMarkDelivered).toHaveBeenCalledTimes(1)
  })
})
