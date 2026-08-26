// Contract test for the three-way ENGINE GATE in runMessageRouterTick().
//
// Mirrors message-router-copilot-delivery.test.ts exactly, extended to cover
// the 'antigravity' engine branch. The contract:
//
//  'claude'      → readiness gate runs (isSessionReadyForPrompt called);
//                  delivery via sendPromptToSession + wrapAgentMessageForDelivery.
//  'copilot'     → readiness gate SKIPPED; delivery via sendPromptToCopilotSession.
//  'antigravity' → readiness gate SKIPPED; delivery via sendPromptToAntigravitySession.
//
// The regression this test locks down: any implementation that leaves
// isSessionReadyForPrompt active for the antigravity engine would cause
// messages to queue forever (gate never opens against an agy TUI) and trigger
// spurious stuck-session escalations every ~10 min. The test would FAIL
// against that hypothetical bug because it asserts the gate is NOT called for
// antigravity (not a loose "it was eventually delivered" check).
//
// Mocking pattern copied from message-router-copilot-delivery.test.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetPendingMessages = vi.fn()
const mockMarkDelivered = vi.fn((..._a: unknown[]) => true)
const mockMarkFailed = vi.fn((..._a: unknown[]) => true)
const mockSessionExistsOnHost = vi.fn((..._a: unknown[]) => true)
const mockReadAgentEngine = vi.fn((_name: string) => 'claude' as 'claude' | 'copilot' | 'antigravity')
const mockIsSessionReadyForPrompt = vi.fn(async (..._a: unknown[]) => false)
const mockClearStaleParkedInput = vi.fn(async (..._a: unknown[]) => false)
const mockSendPromptToSession = vi.fn(async (..._a: unknown[]) => 'sent')
const mockSendPromptToCopilotSession = vi.fn(async (..._a: unknown[]) => 'sent')
const mockFormatCopilotInboundMessage = vi.fn(
  (from: string, content: string, category: string) => `[${category}][Uzenet @${from}-tol]: ${content}`,
)
const mockSendPromptToAntigravitySession = vi.fn(async (..._a: unknown[]) => 'sent')
const mockFormatAntigravityInboundMessage = vi.fn(
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

vi.mock('../web/antigravity-agent-process.js', () => ({
  sendPromptToAntigravitySession: (...a: unknown[]) => mockSendPromptToAntigravitySession(...a),
  formatAntigravityInboundMessage: (from: string, content: string, category: string) =>
    mockFormatAntigravityInboundMessage(from, content, category),
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
// window. This makes "clearStaleParkedInput is NOT called for antigravity"
// a real assertion rather than a vacuous one.
const AGE_SECONDS = 120

function pendingTo(agent: string, content = 'ping', from = 'orin') {
  const nowSec = Math.floor(Date.now() / 1000)
  return [{
    id: Math.floor(Math.random() * 1_000_000) + 1000,
    from_agent: from,
    to_agent: agent,
    content,
    created_at: nowSec - AGE_SECONDS,
    origin_note: null,
    trace_id: null,
    span_id: null,
  }]
}

describe('message router: antigravity-engine delivery reaches the pane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(true)
    mockMarkDelivered.mockReturnValue(true)
    mockMarkFailed.mockReturnValue(true)
    // Gate never opens. For antigravity this must be irrelevant (gate skipped).
    // This is the exact regression scenario: if the gate were NOT skipped, the
    // mock returning false would cause the message to queue forever and this
    // test would fail (sendPromptToAntigravitySession not called).
    mockIsSessionReadyForPrompt.mockResolvedValue(false)
    mockClearStaleParkedInput.mockResolvedValue(false)
    mockClassifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })
  })

  it('delivers to an antigravity-engine agent WITHOUT consulting the Claude readiness gate', async () => {
    mockReadAgentEngine.mockReturnValue('antigravity')
    mockGetPendingMessages.mockReturnValue(pendingTo('agy-a'))

    await runMessageRouterTick()

    // THE critical check: gate must be bypassed entirely for antigravity.
    expect(mockIsSessionReadyForPrompt).not.toHaveBeenCalled()
    // ...including the Claude-TUI-tuned janitor inside the not-ready block.
    expect(mockClearStaleParkedInput).not.toHaveBeenCalled()
    // ...and delivery actually happens on the antigravity path only.
    expect(mockSendPromptToAntigravitySession).toHaveBeenCalledTimes(1)
    expect(mockSendPromptToCopilotSession).not.toHaveBeenCalled()
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
    expect(mockSendPromptToAntigravitySession.mock.calls[0][0]).toBe('agent-agy-a')
    // Message is closed out, stops re-queueing forever.
    expect(mockMarkDelivered).toHaveBeenCalledTimes(1)
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('resolves the destination engine exactly ONCE per message', async () => {
    mockReadAgentEngine.mockReturnValue('antigravity')
    mockGetPendingMessages.mockReturnValue(pendingTo('agy-b'))

    await runMessageRouterTick()

    expect(mockReadAgentEngine).toHaveBeenCalledTimes(1)
    expect(mockReadAgentEngine).toHaveBeenCalledWith('agy-b')
  })

  it('passes the SANITIZED sender and trust category into the Antigravity envelope', async () => {
    mockReadAgentEngine.mockReturnValue('antigravity')
    mockClassifyAgentMessage.mockReturnValue({ category: 'federated', safeFrom: 'peer/bob' })
    mockGetPendingMessages.mockReturnValue(pendingTo('agy-c', 'do a thing', 'peer/bob\nforged line'))

    await runMessageRouterTick()

    expect(mockFormatAntigravityInboundMessage).toHaveBeenCalledTimes(1)
    const [from, content, category] = mockFormatAntigravityInboundMessage.mock.calls[0]
    expect(from).toBe('peer/bob')       // safeFrom, NOT the raw from_agent
    expect(from).not.toContain('forged')
    expect(content).toBe('do a thing')
    expect(category).toBe('federated')  // trust category is carried through
  })

  it('carries the trusted-peer category through unchanged for a trusted sender', async () => {
    mockReadAgentEngine.mockReturnValue('antigravity')
    mockGetPendingMessages.mockReturnValue(pendingTo('agy-d'))

    await runMessageRouterTick()

    expect(mockFormatAntigravityInboundMessage.mock.calls[0][2]).toBe('trusted-peer')
  })
})

describe('message router: copilot-engine path is still unaffected after generalization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(true)
    mockMarkDelivered.mockReturnValue(true)
    mockMarkFailed.mockReturnValue(true)
    mockIsSessionReadyForPrompt.mockResolvedValue(false)
    mockClearStaleParkedInput.mockResolvedValue(false)
    mockClassifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })
  })

  it('still skips the gate and delivers via sendPromptToCopilotSession', async () => {
    mockReadAgentEngine.mockReturnValue('copilot')
    mockGetPendingMessages.mockReturnValue(pendingTo('copi-a'))

    await runMessageRouterTick()

    expect(mockIsSessionReadyForPrompt).not.toHaveBeenCalled()
    expect(mockSendPromptToCopilotSession).toHaveBeenCalledTimes(1)
    expect(mockSendPromptToAntigravitySession).not.toHaveBeenCalled()
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
    expect(mockMarkDelivered).toHaveBeenCalledTimes(1)
  })
})

describe('message router: claude-engine path is unchanged after generalization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSessionExistsOnHost.mockReturnValue(true)
    mockMarkDelivered.mockReturnValue(true)
    mockMarkFailed.mockReturnValue(true)
    mockReadAgentEngine.mockReturnValue('claude')
    mockClearStaleParkedInput.mockResolvedValue(false)
    mockClassifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })
  })

  it('still consults the readiness gate and holds the message when it is closed', async () => {
    mockIsSessionReadyForPrompt.mockResolvedValue(false)
    mockGetPendingMessages.mockReturnValue(pendingTo('cc-a'))

    await runMessageRouterTick()

    // Gate consulted exactly as before.
    expect(mockIsSessionReadyForPrompt).toHaveBeenCalledTimes(1)
    expect(mockIsSessionReadyForPrompt).toHaveBeenCalledWith('agent-cc-a', null)
    // Janitor inside the not-ready block still runs for Claude agents.
    expect(mockClearStaleParkedInput).toHaveBeenCalledTimes(1)
    // Nothing delivered; message stays pending.
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
    expect(mockSendPromptToCopilotSession).not.toHaveBeenCalled()
    expect(mockSendPromptToAntigravitySession).not.toHaveBeenCalled()
    expect(mockMarkDelivered).not.toHaveBeenCalled()
    expect(mockMarkFailed).not.toHaveBeenCalled()
  })

  it('delivers through sendPromptToSession with the Claude wrap once the gate opens', async () => {
    mockIsSessionReadyForPrompt.mockResolvedValue(true)
    mockGetPendingMessages.mockReturnValue(pendingTo('cc-b'))

    await runMessageRouterTick()

    expect(mockIsSessionReadyForPrompt).toHaveBeenCalledTimes(1)
    expect(mockSendPromptToCopilotSession).not.toHaveBeenCalled()
    expect(mockSendPromptToAntigravitySession).not.toHaveBeenCalled()
    expect(mockSendPromptToSession).toHaveBeenCalledTimes(1)
    expect(mockSendPromptToSession).toHaveBeenCalledWith('agent-cc-b', 'PREFIX WRAPPED', null)
    expect(mockMarkDelivered).toHaveBeenCalledTimes(1)
  })
})
