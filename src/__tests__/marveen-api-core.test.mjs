// kanban 5f3617d9 step 4: the marveen-api MCP server core (plugins/marveen-api/core.mjs).
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { callTool, sendMessage } from '../../plugins/marveen-api/core.mjs'

// A fake dashboard that stores what it gets and can be told to mangle it.
function dashboard({ mangle = (s) => s, fail = null } = {}) {
  const calls = []
  const messages = new Map(), memories = [], comments = []
  let next = 100
  const fetch = async (url, init) => {
    const u = new URL(url)
    calls.push({ method: init.method, path: u.pathname + u.search, headers: init.headers, body: init.body })
    if (fail && fail.test(u.pathname)) return new Response(JSON.stringify({ error: 'boom' }), { status: 500 })
    const body = init.body ? JSON.parse(init.body) : null
    if (init.method === 'POST' && u.pathname === '/api/messages') {
      const row = { id: next++, from_agent: body.from, to_agent: body.to, content: mangle(body.content) }
      messages.set(row.id, row)
      return new Response(JSON.stringify(row))
    }
    const m = u.pathname.match(/^\/api\/messages\/(\d+)$/)
    if (m) return new Response(JSON.stringify(messages.get(Number(m[1]))))
    if (init.method === 'POST' && u.pathname === '/api/memories') {
      const row = { id: next++, agent_id: body.agent_id, content: mangle(body.content) }
      memories.unshift(row)
      return new Response(JSON.stringify({ id: row.id }))
    }
    if (u.pathname === '/api/memories') return new Response(JSON.stringify(memories))
    const k = u.pathname.match(/^\/api\/kanban\/([0-9a-f]{8})\/comments$/)
    if (k && init.method === 'POST') {
      const row = { id: next++, card_id: k[1], author: body.author, content: mangle(body.content) }
      comments.push(row)
      return new Response(JSON.stringify(row))
    }
    if (k) return new Response(JSON.stringify(comments.filter((c) => c.card_id === k[1])))
    return new Response('{}', { status: 404 })
  }
  return { calls, deps: { agent: 'aura', base: 'http://dash', fetch, token: async () => ' secret-token\n' } }
}

// The payload class the curl-heredoc path broke on: backtick, dollar-paren, quotes, accents, newlines, em dash.
const HARD = 'kód: `ls` és $(date) meg ${HOME} "idéző" \'aposztróf\' \\ backslash\nárvíztűrő tükörfúrógép ÁRVÍZTŰRŐ — vége'

test('send_message: the hard payload is stored and read back byte for byte; the sender is this agent', async () => {
  const d = dashboard()
  const r = await callTool('send_message', { to: 'marveen', content: HARD }, d.deps)
  assert.equal(r.isError, undefined)
  assert.deepEqual(JSON.parse(r.content[0].text), { id: 100, to: 'marveen', chars: HARD.length, verified: true })
  const post = d.calls.find((c) => c.method === 'POST')
  assert.deepEqual(JSON.parse(post.body), { from: 'aura', to: 'marveen', content: HARD })
  assert.equal(post.headers.Authorization, 'Bearer secret-token')
})

test('save_memory and kanban_comment: the same payload, read back byte for byte', async () => {
  const d = dashboard()
  const m = await callTool('save_memory', { content: HARD, category: 'project' }, d.deps)
  assert.equal(JSON.parse(m.content[0].text).verified, true)
  assert.deepEqual(JSON.parse(d.calls[0].body), { agent_id: 'aura', content: HARD, category: 'project' })
  const k = await callTool('kanban_comment', { card_id: '5f3617d9', content: HARD }, d.deps)
  assert.equal(JSON.parse(k.content[0].text).verified, true)
})

test('a stored text that differs from the sent one is an error, never a success', async () => {
  for (const tool of ['send_message', 'save_memory', 'kanban_comment']) {
    const d = dashboard({ mangle: (s) => s.replace('$(date)', '2026-10-12') })
    const r = await callTool(tool, { to: 'marveen', card_id: '5f3617d9', content: HARD }, d.deps)
    assert.equal(r.isError, true, tool)
    assert.match(r.content[0].text, /differs/)
  }
})

test('the token never appears in a result, also on an HTTP error', async () => {
  const d = dashboard({ fail: /^\/api\/messages$/ })
  const r = await callTool('send_message', { to: 'marveen', content: 'x' }, d.deps)
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /HTTP 500/)
  assert.equal(r.content[0].text.includes('secret-token'), false)
})

test('input checks: recipient name, card id, empty content, unknown tool; nothing is sent', async () => {
  const d = dashboard()
  for (const [tool, args] of [
    ['send_message', { to: 'mar veen', content: 'x' }],
    ['send_message', { to: 'marveen', content: '' }],
    ['kanban_comment', { card_id: '5F3617D9', content: 'x' }],
    ['kanban_comment', { card_id: '../x', content: 'x' }],
    ['nope', {}],
  ]) {
    const r = await callTool(tool, args, d.deps)
    assert.equal(r.isError, true, `${tool} ${JSON.stringify(args)}`)
  }
  assert.equal(d.calls.length, 0)
})

test('a federated recipient (system/agent) is accepted', async () => {
  const d = dashboard()
  const r = await sendMessage({ to: 'peer/agent', content: 'hi' }, d.deps)
  assert.equal(r.verified, true)
})
