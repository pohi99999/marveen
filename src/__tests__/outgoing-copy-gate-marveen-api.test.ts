import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// kanban 5f3617d9 step 4: the marveen-api MCP tools carry inter-agent text as JSON.
// They get exactly the curl path's rule (INTERAGENTHOMOGLIF923): a homoglyph in
// any string argument blocks, everything else passes. The text is always readable
// here, so there is no loud pass. Both directions, every tool, and the wiring.

const ROOT = join(__dirname, '..', '..')
const GATE = join(ROOT, 'scripts', 'hooks', 'outgoing-copy-gate.py')
// Built from code points so this file never carries a literal lookalike.
const CYR_A = String.fromCodePoint(0x430)
const HARD = 'kód: `ls` és $(date) "idéző" árvíztűrő tükörfúrógép — vége'

function gate(tool: string, input: unknown): { code: number | null; err: string } {
  const r = spawnSync('python3', [GATE], {
    input: JSON.stringify({ tool_name: tool, tool_input: input, hook_event_name: 'PreToolUse' }),
    encoding: 'utf-8',
  })
  return { code: r.status, err: r.stderr }
}

describe('outgoing-copy-gate: marveen-api MCP tools', () => {
  it('clean text passes on all three tools (backtick, dollar-paren, accents, em dash: same as the curl path)', () => {
    expect(gate('mcp__marveen-api__send_message', { to: 'marveen', content: HARD }).code).toBe(0)
    expect(gate('mcp__marveen-api__save_memory', { content: HARD, category: 'project' }).code).toBe(0)
    expect(gate('mcp__marveen-api__kanban_comment', { card_id: '5f3617d9', content: HARD }).code).toBe(0)
  })

  it('a homoglyph in the content blocks, on every tool', () => {
    for (const [tool, input] of [
      ['mcp__marveen-api__send_message', { to: 'marveen', content: `a k${CYR_A}rtyan` }],
      ['mcp__marveen-api__save_memory', { content: `a k${CYR_A}rtyan` }],
      ['mcp__marveen-api__kanban_comment', { card_id: '5f3617d9', content: `a k${CYR_A}rtyan` }],
    ] as const) {
      const r = gate(tool, input)
      expect(r.code, tool).toBe(2)
      expect(r.err).toMatch(/homoglifa/)
    }
  })

  it('a homoglyph in the recipient blocks too (a lookalike agent name misroutes silently)', () => {
    expect(gate('mcp__marveen-api__send_message', { to: `m${CYR_A}rveen`, content: 'ok' }).code).toBe(2)
  })

  it('another MCP tool is untouched by this branch', () => {
    expect(gate('mcp__someother__send_message', { content: `a k${CYR_A}rtyan` }).code).toBe(0)
  })

  it('the hook is wired to the marveen-api tools in the project settings', () => {
    const s = JSON.parse(readFileSync(join(ROOT, '.claude', 'settings.json'), 'utf-8'))
    const pre = s.hooks.PreToolUse as { matcher: string; hooks: { command: string }[] }[]
    const hit = pre.find((h) => (h.matcher === '*' ? true : new RegExp(`^(?:${h.matcher})$`).test('mcp__marveen-api__send_message')) && h.hooks.some((x) => x.command.includes('outgoing-copy-gate.py')))
    expect(hit).toBeTruthy()
  })
})
