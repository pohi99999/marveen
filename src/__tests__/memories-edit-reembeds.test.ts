/**
 * MEMEDITEMBED1103: PUT/PATCH /api/memories/:id must re-embed the edited row.
 *
 * updateMemory() drops the embedding to NULL when the embedded text (content +
 * keywords) changes, because the old vector describes text that is gone. Before
 * this fix nothing regenerated it until a manual POST /api/memories/backfill or
 * a dashboard restart -- measured on the live install 2026-11-03: at least 74
 * edited rows had no vector since 2026-10-25, so hybrid search's vector branch
 * could not find them.
 *
 * The contract pinned here:
 *  - after a PUT (and a PATCH) that changes the text, the row gets a FRESH
 *    vector, generated from the new text, without anyone calling backfill;
 *  - the response does not wait for the embedding backend and does not change
 *    shape or status when the backend fails -- the row then stays NULL and the
 *    existing backfill picks it up;
 *  - only the edited row is embedded, and an edit that kept the vector (a
 *    category-only move) costs no backend call;
 *  - a slower, older embedding never overwrites the vector of a newer edit.
 *
 * The embedding backend is stubbed at fetch (generateEmbedding's only I/O, the
 * same seam memories-backfill-reports-failures.test.ts uses); in-memory SQLite.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { Readable } from 'stream'
import { initDatabase, getDb, backfillEmbeddings } from '../db.js'
import { tryHandleMemories, memoryVersion } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return { ...actual, MAIN_AGENT_ID: 'reembed-agent', ALLOWED_CHAT_ID: 'test-chat', OLLAMA_URL: '' }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const AGENT = 'reembed-agent'
const OLD_VECTOR = [0.1, 0.2, 0.3]

async function call(path: string, method: string, body?: unknown): Promise<{ status: number; body: any }> {
  const url = new URL(`http://localhost:3420${path}`)
  let responseBody = ''
  let statusCode = 200
  const res = {
    writeHead: (code: number) => { statusCode = code },
    setHeader: () => {},
    end: (b?: string) => { responseBody = b || '' },
  }
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as any
  const ctx: RouteContext = { req, res: res as any, path, method, url }
  await tryHandleMemories(ctx)
  return { status: statusCode, body: responseBody ? JSON.parse(responseBody) : null }
}

// Seeded with raw SQL and a real-looking vector, so "the PUT nulled it and
// something put a NEW one back" is distinguishable from "it was never touched".
function seed(content: string, keywords: string | null = 'kw', embedding: number[] | null = OLD_VECTOR): number {
  const now = Math.floor(Date.now() / 1000)
  const r = getDb().prepare(
    `INSERT INTO memories (chat_id, topic_key, content, sector, salience,
     created_at, accessed_at, agent_id, category, auto_generated, keywords, embedding)
     VALUES ('test-chat', NULL, ?, 'semantic', 1.0, ?, ?, ?, 'warm', 0, ?, ?)`,
  ).run(content, now, now, AGENT, keywords, embedding ? JSON.stringify(embedding) : null)
  return Number(r.lastInsertRowid)
}

function embeddingOf(id: number): number[] | null {
  const row = getDb().prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as { embedding: string | null }
  return row.embedding ? JSON.parse(row.embedding) as number[] : null
}

// A vector derived from the prompt, so the test can tell WHICH text was embedded.
function vectorFor(prompt: string): number[] {
  return [prompt.length, 0.5, 0.25]
}

type FetchImpl = (prompt: string) => Promise<number[]>

// Stubs the embedding backend. `impl` decides per prompt: resolve a vector,
// throw (backend down), or hang. Every prompt is recorded.
function stubBackend(impl: FetchImpl) {
  const prompts: string[] = []
  const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const prompt = (JSON.parse(init?.body ?? '{}') as { prompt?: string }).prompt ?? ''
    prompts.push(prompt)
    const embedding = await impl(prompt)
    return { json: async () => ({ embedding }) } as unknown as Response
  })
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, prompts }
}

const working: FetchImpl = async (prompt) => vectorFor(prompt)
const down: FetchImpl = async () => { throw new TypeError('fetch failed') }

// Lets the fire-and-forget promise chain settle.
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0))
}

beforeAll(() => {
  initDatabase(':memory:')
})

beforeEach(() => {
  // Start every case with an empty backlog so "only the edited row" is checkable.
  getDb().prepare('UPDATE memories SET embedding = ? WHERE embedding IS NULL').run(JSON.stringify(OLD_VECTOR))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe.each(['PUT', 'PATCH'] as const)('%s /api/memories/:id re-embeds the edited row', (method) => {
  it('a content edit gets a fresh vector from the NEW text, without a backfill', async () => {
    const { prompts } = stubBackend(working)
    const id = seed(`${method} original text`, 'kw-a')

    const r = await call(`/api/memories/${id}`, method, { content: `${method} rewritten text` })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, version: memoryVersion(`${method} rewritten text`) })

    await vi.waitFor(() => expect(embeddingOf(id)).not.toBeNull())
    const expectedPrompt = `${method} rewritten text kw-a`
    expect(prompts).toEqual([expectedPrompt])
    expect(embeddingOf(id)).toEqual(vectorFor(expectedPrompt))
    expect(embeddingOf(id)).not.toEqual(OLD_VECTOR)
  })

  it('a keywords-only edit is re-embedded too (keywords are part of the embedded text)', async () => {
    const { prompts } = stubBackend(working)
    const id = seed(`${method} same body`, 'old-kw')

    const r = await call(`/api/memories/${id}`, method, { keywords: 'new-kw' })
    expect(r.status).toBe(200)

    await vi.waitFor(() => expect(embeddingOf(id)).not.toBeNull())
    expect(prompts).toEqual([`${method} same body new-kw`])
  })

  it('backend down: the answer is unchanged, the row stays NULL, and the backfill picks it up', async () => {
    const { fetchMock } = stubBackend(down)
    const id = seed(`${method} before outage`)

    const r = await call(`/api/memories/${id}`, method, { content: `${method} edited during outage` })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, version: memoryVersion(`${method} edited during outage`) })

    await settle()
    expect(fetchMock).toHaveBeenCalledTimes(1) // one attempt, no retry loop
    expect(embeddingOf(id)).toBeNull()

    // The existing recovery path still owns the row.
    stubBackend(working)
    const b = await backfillEmbeddings()
    expect(b).toEqual({ attempted: 1, embedded: 1, failed: 0 })
    expect(embeddingOf(id)).toEqual(vectorFor(`${method} edited during outage kw`))
  })

  it('the answer does not wait for the backend (a hanging backend still gets a 200)', async () => {
    const { fetchMock } = stubBackend(() => new Promise<number[]>(() => {}))
    const id = seed(`${method} hang before`)

    const r = await call(`/api/memories/${id}`, method, { content: `${method} hang after` })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, version: memoryVersion(`${method} hang after`) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(embeddingOf(id)).toBeNull()
  })

  it('embeds ONLY the edited row, not other rows waiting for the backfill', async () => {
    const { prompts } = stubBackend(working)
    const waiting = seed(`${method} someone else, never embedded`, null, null)
    const id = seed(`${method} target before`, null)

    await call(`/api/memories/${id}`, method, { content: `${method} target after` })
    await vi.waitFor(() => expect(embeddingOf(id)).not.toBeNull())
    await settle()

    expect(prompts).toEqual([`${method} target after`])
    expect(embeddingOf(waiting)).toBeNull()
  })

  it('a category-only edit keeps the vector and makes no backend call', async () => {
    const { fetchMock } = stubBackend(working)
    const id = seed(`${method} tier move body`)

    const r = await call(`/api/memories/${id}`, method, { category: 'cold' })
    expect(r.status).toBe(200)
    await settle()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(embeddingOf(id)).toEqual(OLD_VECTOR)
  })

  it('a rejected edit (404 / 400) triggers no embedding', async () => {
    const { fetchMock } = stubBackend(working)
    const id = seed(`${method} untouched`)

    expect((await call('/api/memories/99999999', method, { content: 'nope' })).status).toBe(404)
    expect((await call(`/api/memories/${id}`, method, { content: '' })).status).toBe(400)
    await settle()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(embeddingOf(id)).toEqual(OLD_VECTOR)
  })
})

describe('two quick edits: the older embedding never lands over the newer text', () => {
  it('the slow first embedding is discarded, the second one stays', async () => {
    const resolvers = new Map<string, (v: number[]) => void>()
    stubBackend((prompt) => new Promise<number[]>((resolve) => { resolvers.set(prompt, resolve) }))
    const id = seed('race original', null)

    await call(`/api/memories/${id}`, 'PUT', { content: 'race first edit' })
    await call(`/api/memories/${id}`, 'PUT', { content: 'race second edit' })
    await vi.waitFor(() => expect(resolvers.size).toBe(2))

    // The newer edit's embedding answers first, the older one last.
    resolvers.get('race second edit')!(vectorFor('race second edit'))
    await settle()
    resolvers.get('race first edit')!(vectorFor('race first edit'))
    await settle()

    expect(embeddingOf(id)).toEqual(vectorFor('race second edit'))
  })
})
