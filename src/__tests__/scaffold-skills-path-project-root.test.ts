import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// The skills-path block and the CLAUDE.md generation prompt named the skills tree with a literal
// WSL path (/home/pohi/marveen/...). After the move to the Mac every generated CLAUDE.md told the
// agent to commit skills in a directory that does not exist there (agents/ellenor, 2026-10-23;
// kenshin, tablaor and the main CLAUDE.md carry the same line). The path comes from PROJECT_ROOT.
import { buildSkillsPathTrapBody } from '../web/agent-scaffold.js'
import { PROJECT_ROOT } from '../config.js'

describe('skills path follows the install root', () => {
  it('the skills-path block names PROJECT_ROOT/.claude/skills', () => {
    const body = buildSkillsPathTrapBody()
    expect(body).toContain(`git -C ${PROJECT_ROOT}/.claude/skills add -A && git commit && git push`)
  })
  it('agent-scaffold.ts carries no literal /home/<user> install path', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'agent-scaffold.ts'), 'utf-8')
    expect(src.match(/\/home\/[a-z]+\/marveen/g) ?? []).toEqual([])
  })
})
