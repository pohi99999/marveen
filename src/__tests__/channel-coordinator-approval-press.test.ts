import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// An approval button press read by the coordinator is recorded for the dashboard's watcher, never handed to the agent.
const state = vi.hoisted(() => ({ dir: '' }))
vi.mock('../config.js', async (importOriginal) => ({ ...(await importOriginal<typeof import('../config.js')>()), ALLOWED_CHAT_ID: '42' }))
vi.mock('../channel-provider.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../channel-provider.js')>()),
  channelStateDir: () => state.dir,
}))

import { processBatch } from '../channel-coordinator.js'
import * as ingest from '../channel-coordinator/ingest.js'

const press = (id: number, data: string, from = 42) => ({
  update_id: id,
  callback_query: { id: `cq${id}`, data, from: { id: from }, message: { message_id: id, date: 1700000000, text: 'x', chat: { id: 42, type: 'private' } } },
})

let db: ReturnType<typeof ingest.initIngestDb>
const messages = () => (db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get() as { n: number }).n
const file = () => join(state.dir, 'approval-callbacks.jsonl')
const lines = () => (existsSync(file()) ? readFileSync(file(), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)) : [])
const eventStatus = (id: number) => (db.prepare('SELECT status FROM incoming_events WHERE update_id = ?').get(id) as { status: string }).status

beforeEach(() => {
  state.dir = mkdtempSync(join(tmpdir(), 'coordinator-press-'))
  db = ingest.initIngestDb(':memory:')
})
afterEach(() => {
  ingest.closeIngestDb()
  rmSync(state.dir, { recursive: true, force: true })
})

describe('processBatch: an apr: callback', () => {
  it('is recorded with Telegram\'s own sender, and the agent gets no message', () => {
    const data = 'apr:abcdefab-1111-4abc-8abc-abcdefabcd01:n0nceAAA:a'
    expect(processBatch([press(20, data)])).toEqual({ offset: 20, stalled: false })
    expect(lines()).toMatchObject([{ data, from_id: 42, callback_query_id: 'cq20', chat_id: 42 }])
    expect(messages()).toBe(0)
    // Handled: it does not come back as an undelivered event.
    expect(eventStatus(20)).toBe('delivered')
  })

  it('from another Telegram user: recorded with that sender, for the watcher to refuse', () => {
    expect(processBatch([press(21, 'apr:abcdefab-1111-4abc-8abc-abcdefabcd01:n0nceAAA:a', 777)]).stalled).toBe(false)
    expect(lines()).toMatchObject([{ from_id: 777 }])
    expect(messages()).toBe(0)
  })

  it('when the press cannot be recorded, the event stays open, and the batch goes on', () => {
    rmSync(state.dir, { recursive: true, force: true })
    writeFileSync(state.dir, 'a file where the state dir should be')
    expect(processBatch([press(23, 'apr:abcdefab-1111-4abc-8abc-abcdefabcd01:n0nceAAA:a')])).toEqual({ offset: 23, stalled: false })
    expect(eventStatus(23)).toBe('pending')
    expect(messages()).toBe(0)
  })

  it('any other callback stays an ordinary handoff, and records no press', () => {
    processBatch([press(22, 'perm:something')])
    expect(lines()).toEqual([])
    expect(messages()).toBe(1)
  })
})
