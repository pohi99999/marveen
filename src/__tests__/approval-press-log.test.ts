import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
// The press log line names the approval and the outcome, and never the nonce.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, createApproval, getApproval } from '../db.js'
import { logger } from '../logger.js'
import { pollApprovalCallbacks, pressForLog } from '../web/approval-callbacks.js'
import { buildCallbackData } from '../web/telegram-approval.js'
import { applyOwnerDecision } from '../web/routes/approvals.js'

const OWNER = '777001'
const ID = 'abcdefab-1111-4abc-8abc-abcdefabcd01'
const NONCE = 'n0nceAAA'

let dir: string
let file: string
let info: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  initDatabase(':memory:')
  dir = mkdtempSync(join(tmpdir(), 'press-log-'))
  file = join(dir, 'approval-callbacks.jsonl')
  writeFileSync(file, '')
  info = vi.spyOn(logger, 'info')
  createApproval({ id: ID, agent_id: 'marveen', category: 'email_send', action_description: 'x', owner_nonce: NONCE, timeout_at: Math.floor(Date.now() / 1000) + 600 })
})
afterEach(() => {
  info.mockRestore()
  rmSync(dir, { recursive: true, force: true })
})

async function press(data: string, from: number | string = 777001) {
  appendFileSync(file, JSON.stringify({ callback_query_id: 'cq', data, from_id: from }) + '\n')
  await pollApprovalCallbacks(file, OWNER, join(dir, 'offset.json'), {
    apply: (i, n, d) => applyOwnerDecision(i, n, d, undefined, 'button'),
    answer: async () => {},
  })
  const line = info.mock.calls.find((c: unknown[]) => c[1] === 'approval-callbacks: owner button press handled')
  expect(line).toBeTruthy()
  return line![0] as Record<string, unknown>
}

describe('the press log line', () => {
  it('an approved press: the approval, the decision and the outcome, no nonce', async () => {
    const line = await press(buildCallbackData(ID, NONCE, 'approved'))
    expect(line).toEqual({ approval_id: ID, decision: 'approved', outcome: 'approved', reason: undefined })
    expect(JSON.stringify(line)).not.toContain(NONCE)
    expect(getApproval(ID)!.status).toBe('approved')
  })

  it('a refused press from another user: still identified, no nonce', async () => {
    const line = await press(buildCallbackData(ID, NONCE, 'approved'), 123)
    expect(line).toMatchObject({ approval_id: ID, decision: 'approved', outcome: 'refused', reason: 'not-owner' })
    expect(JSON.stringify(line)).not.toContain(NONCE)
  })

  it('a wrong nonce: identified, and neither nonce is in the line', async () => {
    const line = await press(buildCallbackData(ID, 'wrongNON', 'rejected'))
    expect(line).toMatchObject({ approval_id: ID, decision: 'rejected', outcome: 'refused', reason: 'wrong_nonce' })
    expect(JSON.stringify(line)).not.toContain('wrongNON')
  })

  it('data that does not parse: only its length', async () => {
    const data = `apr:${NONCE}:garbage`
    const line = await press(data)
    expect(line).toMatchObject({ unparsed_length: data.length, outcome: 'malformed' })
    expect(JSON.stringify(line)).not.toContain(NONCE)
  })

  it('pressForLog, both directions', () => {
    expect(pressForLog(buildCallbackData(ID, NONCE, 'rejected'))).toEqual({ approval_id: ID, decision: 'rejected' })
    expect(pressForLog('x'.repeat(5))).toEqual({ unparsed_length: 5 })
  })
})
