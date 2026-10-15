import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, appendFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initDatabase, createApproval, getApproval } from '../db.js'
import { handleCallbackLine, pollApprovalCallbacks } from '../web/approval-callbacks.js'
import { buildCallbackData } from '../web/telegram-approval.js'
import { applyOwnerDecision } from '../web/routes/approvals.js'

// Card 3558: the plugin writes one line per button press; the dashboard decides, the agent never
// sees the line. Both directions, through the real DB resolver.
const OWNER = '777001'
const deps = (answers: string[]) => ({
  apply: (id: string, nonce: string, decision: 'approved' | 'rejected') => applyOwnerDecision(id, nonce, decision),
  answer: async (_cb: string, text: string) => { answers.push(text) },
})

describe('approval-callbacks: one line, one decision', () => {
  beforeEach(() => { initDatabase(':memory:') })
  const mk = (id: string, nonce = 'n0nceAAA') => createApproval({ id, agent_id: 'marveen', category: 'email_send', action_description: 'Levél', owner_nonce: nonce, timeout_at: Math.floor(Date.now() / 1000) + 600 })

  it("the owner's press approves, and answers the callback; a second press is refused", async () => {
    mk('b1b1b1b1'); const answers: string[] = []
    const line = { callback_query_id: 'cq1', data: buildCallbackData('b1b1b1b1', 'n0nceAAA', 'approved'), from_id: 777001 }
    expect(await handleCallbackLine(line, OWNER, deps(answers))).toMatchObject({ outcome: 'approved' })
    expect(getApproval('b1b1b1b1')).toMatchObject({ status: 'approved', resolved_by: 'telegram-owner' })
    expect(answers).toEqual(['Jóváhagyva.'])
    expect(await handleCallbackLine({ ...line, data: buildCallbackData('b1b1b1b1', 'n0nceAAA', 'rejected') }, OWNER, deps(answers))).toMatchObject({ outcome: 'refused', reason: 'already_resolved' })
    expect(getApproval('b1b1b1b1')!.status).toBe('approved')
  })

  it('a foreign from.id, a wrong nonce and garbage data decide nothing', async () => {
    mk('b2b2b2b2'); const answers: string[] = []
    expect(await handleCallbackLine({ callback_query_id: 'cq2', data: buildCallbackData('b2b2b2b2', 'n0nceAAA', 'approved'), from_id: 42 }, OWNER, deps(answers))).toMatchObject({ outcome: 'refused', reason: 'not-owner' })
    expect(answers).toEqual(['Nem jogosult.'])
    expect(await handleCallbackLine({ data: buildCallbackData('b2b2b2b2', 'wrongNON', 'approved'), from_id: 777001 }, OWNER, deps(answers))).toMatchObject({ outcome: 'refused', reason: 'wrong_nonce' })
    expect(await handleCallbackLine({ data: 'perm:allow:abcde', from_id: 777001 }, OWNER, deps(answers))).toMatchObject({ outcome: 'malformed' })
    expect(await handleCallbackLine({ data: buildCallbackData('b2b2b2b2', 'n0nceAAA', 'approved'), from_id: 777001 }, null, deps(answers))).toMatchObject({ outcome: 'refused', reason: 'no-owner-configured' })
    expect(getApproval('b2b2b2b2')!.status).toBe('pending')
  })

  it('poll: reads only new complete lines, advances the offset, survives a partial and a malformed line', async () => {
    mk('b3b3b3b3'); mk('b4b4b4b4', 'n0nceBBB')
    const dir = mkdtempSync(join(tmpdir(), 'apr-')); const file = join(dir, 'approval-callbacks.jsonl'); const off = join(dir, 'offset.json')
    const answers: string[] = []
    writeFileSync(file, JSON.stringify({ callback_query_id: 'c1', data: buildCallbackData('b3b3b3b3', 'n0nceAAA', 'rejected'), from_id: 777001 }) + '\n' + 'not json\n' + '{"partial": tru')
    const first = await pollApprovalCallbacks(file, OWNER, off, deps(answers))
    expect(first.map((o) => o.outcome)).toEqual(['rejected', 'malformed'])
    expect(getApproval('b3b3b3b3')!.status).toBe('rejected')
    expect(existsSync(off)).toBe(true)
    // nothing new: no re-processing
    expect(await pollApprovalCallbacks(file, OWNER, off, deps(answers))).toEqual([])
    // the partial line completes, then a second valid press
    appendFileSync(file, 'e}\n' + JSON.stringify({ callback_query_id: 'c2', data: buildCallbackData('b4b4b4b4', 'n0nceBBB', 'approved'), from_id: 777001 }) + '\n')
    const second = await pollApprovalCallbacks(file, OWNER, off, deps(answers))
    expect(second.map((o) => o.outcome)).toEqual(['malformed', 'approved'])
    expect(getApproval('b4b4b4b4')!.status).toBe('approved')
    expect(answers).toEqual(['Elutasítva.', 'Jóváhagyva.'])
  })
})
