// marveen-api MCP server, pure core (kanban 5f3617d9, step 4; owner GO 2026-10-12).
//
// Three tools that replace the curl-heredoc calls to the local dashboard API:
//   send_message(to, content)        POST /api/messages
//   save_memory(content, category?)  POST /api/memories
//   kanban_comment(card_id, content) POST /api/kanban/<id>/comments
// No shell anywhere: the arguments arrive as JSON and leave as JSON, so the
// backtick / dollar-paren / quoting failure class of the heredoc path cannot
// happen. After every write the core reads the stored row back and compares it
// byte for byte with what was asked; a difference is an error, never a silent
// success. The sender (`from`, `agent_id`, `author`) is the agent the server
// was configured for (MARVEEN_AGENT_ID), never a model argument.
// The bearer token is read from store/.dashboard-token per call, inside this
// process; it is never part of a tool result.
// Pure: fetch and the token reader are injected, so it is tested with node --test.

export const AGENT_RE = /^[a-z0-9_-]{1,64}$/i
export const FED_AGENT_RE = /^[a-z0-9_-]{1,64}\/[a-z0-9_-]{1,64}$/i
export const CARD_RE = /^[0-9a-f]{8}$/
export const MAX_CONTENT = 60_000

export class ToolError extends Error {}

function text(v, name) {
  if (typeof v !== 'string' || !v.length) throw new ToolError(`${name}: a non-empty string is required`)
  if (v.length > MAX_CONTENT) throw new ToolError(`${name}: at most ${MAX_CONTENT} characters`)
  return v
}

/** One dashboard call; the token never leaves this function. */
async function api(deps, method, path, body) {
  const token = (await deps.token()).trim()
  if (!token) throw new ToolError('dashboard token is not readable')
  const res = await deps.fetch(`${deps.base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Agent-Id': deps.agent },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const raw = await res.text()
  let data
  try { data = raw ? JSON.parse(raw) : null } catch { data = null }
  if (!res.ok) throw new ToolError(`${method} ${path} -> HTTP ${res.status}${data && data.error ? `: ${String(data.error).slice(0, 200)}` : ''}`)
  return data
}

function verified(stored, sent, what) {
  if (stored !== sent) {
    throw new ToolError(`${what}: stored text differs from the text sent (sent ${sent.length} chars, stored ${typeof stored === 'string' ? stored.length : 'none'}); NOT a success`)
  }
}

export async function sendMessage(args, deps) {
  const to = text(args?.to, 'to')
  if (!AGENT_RE.test(to) && !FED_AGENT_RE.test(to)) throw new ToolError('to: an agent name (letters, digits, _ -) or system/agent')
  const content = text(args?.content, 'content')
  const row = await api(deps, 'POST', '/api/messages', { from: deps.agent, to, content })
  const id = row && row.id
  if (!Number.isInteger(id)) throw new ToolError('send_message: the API returned no message id')
  const back = await api(deps, 'GET', `/api/messages/${id}`)
  verified(back && back.content, content, 'send_message')
  if (back.to_agent !== to || back.from_agent !== deps.agent) throw new ToolError('send_message: stored sender/recipient differ from the request')
  return { id, to, chars: content.length, verified: true }
}

export async function saveMemory(args, deps) {
  const content = text(args?.content, 'content')
  const body = { agent_id: deps.agent, content }
  if (args?.category !== undefined) body.category = text(args.category, 'category')
  if (args?.keywords !== undefined) body.keywords = text(args.keywords, 'keywords')
  const row = await api(deps, 'POST', '/api/memories', body)
  const id = row && (row.id ?? row.memory?.id)
  if (id === undefined || id === null) throw new ToolError('save_memory: the API returned no memory id')
  // there is no GET by id: read the agent's newest rows and find this one
  const list = await api(deps, 'GET', `/api/memories?agent=${encodeURIComponent(deps.agent)}&limit=50`)
  const rows = Array.isArray(list) ? list : (list?.memories ?? list?.items ?? [])
  const back = rows.find((m) => String(m.id) === String(id))
  if (!back) throw new ToolError(`save_memory: memory ${id} not found when read back`)
  verified(back.content, content, 'save_memory')
  return { id, chars: content.length, verified: true }
}

export async function kanbanComment(args, deps) {
  const cardId = text(args?.card_id, 'card_id')
  if (!CARD_RE.test(cardId)) throw new ToolError('card_id: 8 lowercase hex characters')
  const content = text(args?.content, 'content')
  const row = await api(deps, 'POST', `/api/kanban/${cardId}/comments`, { author: deps.agent, content })
  const id = row && row.id
  if (id === undefined || id === null) throw new ToolError('kanban_comment: the API returned no comment id')
  const list = await api(deps, 'GET', `/api/kanban/${cardId}/comments`)
  const rows = Array.isArray(list) ? list : (list?.comments ?? [])
  const back = rows.find((c) => String(c.id) === String(id))
  if (!back) throw new ToolError(`kanban_comment: comment ${id} not found when read back`)
  verified(back.content ?? back.body, content, 'kanban_comment')
  return { id, card_id: cardId, chars: content.length, verified: true }
}

export const TOOLS = {
  send_message: {
    run: sendMessage,
    description: 'Send an inter-agent message through the local dashboard (POST /api/messages). The sender is this agent. The stored text is read back and compared byte for byte.',
    inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'recipient agent, or system/agent for a federated peer' }, content: { type: 'string' } }, required: ['to', 'content'], additionalProperties: false },
  },
  save_memory: {
    run: saveMemory,
    description: "Save a memory for this agent (POST /api/memories). The stored text is read back and compared byte for byte.",
    inputSchema: { type: 'object', properties: { content: { type: 'string' }, category: { type: 'string' }, keywords: { type: 'string' } }, required: ['content'], additionalProperties: false },
  },
  kanban_comment: {
    run: kanbanComment,
    description: 'Add a comment to a kanban card (POST /api/kanban/<card_id>/comments). The author is this agent. The stored text is read back and compared byte for byte.',
    inputSchema: { type: 'object', properties: { card_id: { type: 'string', description: '8 hex characters' }, content: { type: 'string' } }, required: ['card_id', 'content'], additionalProperties: false },
  },
}

/** The MCP tool result for one call: ok text, or isError with the reason (never the token). */
export async function callTool(name, args, deps) {
  const tool = TOOLS[name]
  if (!tool) return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true }
  try {
    const out = await tool.run(args ?? {}, deps)
    return { content: [{ type: 'text', text: JSON.stringify(out) }] }
  } catch (err) {
    const msg = err instanceof ToolError ? err.message : `unexpected error: ${err && err.name ? err.name : 'error'}`
    return { content: [{ type: 'text', text: `${name}: ${msg}` }], isError: true }
  }
}
