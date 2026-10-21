import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'skill-index.sh')

function makeSkillMd(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`
}

// FORK (SKILLSGIT914): the fork has ONE skills tree, <repo>/.claude/skills (a
// nested clone of marveen-skills). The script finds it from its own location
// ($0/..), not from $HOME, and the AGENT_DIR argument is accepted only for
// backward compatibility (a deprecation note, then the same single tree is
// indexed). The upstream tests below ran the REAL script in place with a fake
// HOME and asserted the retired global (~/.claude/skills) and per-agent index
// layout. They now run a COPY of the real script from a throwaway repo root
// (the same technique the truncation test uses), so they measure the fork's
// layout and can never write into the checkout's own .claude/skills.
//
// Every fixture keeps a decoy skill in the throwaway HOME's ~/.claude/skills:
// if the script ever went back to reading $HOME, the decoy would show up.
function makeRepoRoot(base: string): { root: string; script: string; skillsDir: string; index: string } {
  const root = join(base, 'repo')
  const skillsDir = join(root, '.claude', 'skills')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(skillsDir, { recursive: true })
  const script = join(root, 'scripts', 'skill-index.sh')
  copyFileSync(SCRIPT, script)
  return { root, script, skillsDir, index: join(skillsDir, '.skill-index.md') }
}

function addSkill(skillsDir: string, name: string, description: string): void {
  mkdirSync(join(skillsDir, name), { recursive: true })
  writeFileSync(join(skillsDir, name, 'SKILL.md'), makeSkillMd(name, description))
}

function runScript(script: string, args: string[], env: Record<string, string>): { stdout: string; stderr: string; exitCode: number } {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
  })
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', exitCode: r.status ?? 1 }
}

describe('skill-index.sh -- no-arg mode', () => {
  let tmp: string
  let home: string
  let repo: ReturnType<typeof makeRepoRoot>

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'skill-index-test-'))
    home = join(tmp, 'home')
    repo = makeRepoRoot(tmp)
    addSkill(repo.skillsDir, 'skill-alpha', 'Repo-tree skill alpha description')
    addSkill(join(home, '.claude', 'skills'), 'skill-home-decoy', 'Retired global copy, must not be indexed')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('writes the index to <repo>/.claude/skills/.skill-index.md, not to ~/.claude/skills', () => {
    const { exitCode } = runScript(repo.script, [], { HOME: home })
    expect(exitCode).toBe(0)
    expect(existsSync(repo.index)).toBe(true)
    expect(existsSync(join(home, '.claude', 'skills', '.skill-index.md'))).toBe(false)
  })

  it('includes the repo-tree skill in the index, and not the retired ~/.claude/skills copy', () => {
    runScript(repo.script, [], { HOME: home })
    const content = readFileSync(repo.index, 'utf-8')
    expect(content).toContain('skill-alpha')
    expect(content).toContain('Repo-tree skill alpha description')
    expect(content).not.toContain('skill-home-decoy')
  })

  it('uses the two-column table format (no Scope column)', () => {
    runScript(repo.script, [], { HOME: home })
    const content = readFileSync(repo.index, 'utf-8')
    expect(content).toContain('| Skill | Leírás |')
    expect(content).not.toContain('| Scope |')
  })

  it('does NOT create an index in any other directory', () => {
    const agentDir = join(tmp, 'agents', 'agent-a')
    addSkill(join(agentDir, '.claude', 'skills'), 'skill-beta', 'Agent-specific skill beta')
    const { exitCode } = runScript(repo.script, [], { HOME: home })
    // Positive control: the run did produce the one index it should, so the
    // absences below are not just the side effect of a failed run.
    expect(exitCode).toBe(0)
    expect(existsSync(repo.index)).toBe(true)
    expect(existsSync(join(agentDir, '.claude', 'skills', '.skill-index.md'))).toBe(false)
    expect(existsSync(join(home, '.claude', 'skills', '.skill-index.md'))).toBe(false)
  })
})

describe('skill-index.sh -- description truncation', () => {
  let tmpHome: string

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true })
  })

  // `cut -c` in GNU coreutils counts bytes, not characters, even under a UTF-8
  // locale. A description of accented text long enough to hit the 120 cut then
  // loses its last character mid-encoding, and the index every agent reads
  // carries a broken byte.
  it('truncates a long accented description without splitting a character', () => {
    tmpHome = mkdtempSync(join(tmpdir(), 'skill-index-test-'))
    mkdirSync(join(tmpHome, '.claude', 'skills', 'skill-accents'), { recursive: true })
    // 'é' is two bytes, so a byte-cut at 120 lands inside a character.
    const longAccented = 'é'.repeat(200)
    writeFileSync(
      join(tmpHome, '.claude', 'skills', 'skill-accents', 'SKILL.md'),
      makeSkillMd('skill-accents', longAccented),
    )

    // FORK (SKILLSGIT914): the fork's script indexes <repo>/.claude/skills (its own
    // root, from $0), not ~/.claude/skills. Run a COPY of the real script from a
    // throwaway root that holds the fixture tree, so the same truncation is measured.
    mkdirSync(join(tmpHome, 'scripts'), { recursive: true })
    copyFileSync(SCRIPT, join(tmpHome, 'scripts', 'skill-index.sh'))
    execSync(`bash "${join(tmpHome, 'scripts', 'skill-index.sh')}"`, { encoding: 'utf-8', env: { ...process.env, HOME: tmpHome } })

    const raw = readFileSync(join(tmpHome, '.claude', 'skills', '.skill-index.md'))
    // A replacement char means the bytes did not decode: the cut split a char.
    expect(raw.toString('utf-8')).not.toContain('\uFFFD')
    expect(raw.toString('utf-8')).toContain('é'.repeat(120))
  })
})

describe('skill-index.sh -- AGENT_DIR argument (deprecated, single tree)', () => {
  let tmp: string
  let home: string
  let repo: ReturnType<typeof makeRepoRoot>
  let agentDir: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'skill-index-test-'))
    home = join(tmp, 'home')
    repo = makeRepoRoot(tmp)
    // The one tree every agent sees
    addSkill(repo.skillsDir, 'skill-shared', 'A repo-tree skill visible to all agents')
    // A leftover per-agent copy (retired by SKILLSGIT914)
    agentDir = join(tmp, 'agents', 'agent-a')
    addSkill(join(agentDir, '.claude', 'skills'), 'skill-local', 'A leftover agent-local copy for agent-a')
    addSkill(join(home, '.claude', 'skills'), 'skill-home-decoy', 'Retired global copy, must not be indexed')
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('accepts the AGENT_DIR argument and writes the single <repo>/.claude/skills/.skill-index.md', () => {
    const { exitCode } = runScript(repo.script, [agentDir], { HOME: home })
    expect(exitCode).toBe(0)
    expect(existsSync(repo.index)).toBe(true)
  })

  it('includes the repo-tree skill in the index when called with AGENT_DIR', () => {
    runScript(repo.script, [agentDir], { HOME: home })
    const content = readFileSync(repo.index, 'utf-8')
    expect(content).toContain('skill-shared')
    expect(content).toContain('A repo-tree skill visible to all agents')
  })

  it('does NOT index a leftover agent-local copy: the agent dir is no longer a skills source', () => {
    runScript(repo.script, [agentDir], { HOME: home })
    const content = readFileSync(repo.index, 'utf-8')
    expect(content).toContain('skill-shared')
    expect(content).not.toContain('skill-local')
    expect(content).not.toContain('skill-home-decoy')
  })

  it('prints the deprecation note and keeps the two-column format (no global/agent scope labels)', () => {
    const { stderr } = runScript(repo.script, [agentDir], { HOME: home })
    expect(stderr).toContain('AGENT_DIR argumentum elavult')
    const content = readFileSync(repo.index, 'utf-8')
    expect(content).toContain('| Skill | Leírás |')
    expect(content).not.toContain('| global |')
    expect(content).not.toContain('| agent |')
  })

  it('does NOT modify the global index when running in agent mode', () => {
    const globalIndexPath = join(home, '.claude', 'skills', '.skill-index.md')
    // Ensure there is no stale global index before the run
    expect(existsSync(globalIndexPath)).toBe(false)
    runScript(repo.script, [agentDir], { HOME: home })
    expect(existsSync(repo.index)).toBe(true)
    expect(existsSync(globalIndexPath)).toBe(false)
  })

  it('does NOT create an agent .claude/skills/ directory or an agent-level index', () => {
    const freshAgentDir = join(tmp, 'agents', 'agent-b')
    // Only the agent dir exists, no .claude/skills/ inside
    mkdirSync(freshAgentDir, { recursive: true })
    const { exitCode } = runScript(repo.script, [freshAgentDir], { HOME: home })
    expect(exitCode).toBe(0)
    expect(existsSync(repo.index)).toBe(true)
    expect(existsSync(join(freshAgentDir, '.claude', 'skills'))).toBe(false)
  })

  it('two different agents get the same single index, with no agent-local skills leaking in', () => {
    // agent-b has a different leftover local copy
    const agentBDir = join(tmp, 'agents', 'agent-b')
    addSkill(join(agentBDir, '.claude', 'skills'), 'skill-b-only', 'Only for agent-b')

    runScript(repo.script, [agentDir], { HOME: home })
    const indexA = readFileSync(repo.index, 'utf-8')
    runScript(repo.script, [agentBDir], { HOME: home })
    const indexB = readFileSync(repo.index, 'utf-8')

    // neither run sees either agent's leftover copy
    for (const idx of [indexA, indexB]) {
      expect(idx).toContain('skill-shared')
      expect(idx).not.toContain('skill-local')
      expect(idx).not.toContain('skill-b-only')
    }
    // no per-agent index was written for either agent
    expect(existsSync(join(agentDir, '.claude', 'skills', '.skill-index.md'))).toBe(false)
    expect(existsSync(join(agentBDir, '.claude', 'skills', '.skill-index.md'))).toBe(false)
  })
})

describe('skill-index.sh -- graceful handling of missing global dir', () => {
  it('exits cleanly when ~/.claude/skills does not exist (the repo tree is the only source)', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-index-test-'))
    try {
      const emptyHome = join(tmp, 'home')
      mkdirSync(emptyHome)
      const repo = makeRepoRoot(tmp)
      addSkill(repo.skillsDir, 'skill-alpha', 'Repo-tree skill alpha description')
      const { exitCode } = runScript(repo.script, [], { HOME: emptyHome })
      expect(exitCode).toBe(0)
      expect(existsSync(join(emptyHome, '.claude'))).toBe(false)
      expect(readFileSync(repo.index, 'utf-8')).toContain('skill-alpha')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('fails loudly (non-zero, names the path) when the repo skills tree itself is missing', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'skill-index-test-'))
    try {
      const repo = makeRepoRoot(tmp)
      rmSync(join(repo.root, '.claude'), { recursive: true, force: true })
      const { exitCode, stderr } = runScript(repo.script, [], { HOME: join(tmp, 'home') })
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain(repo.skillsDir)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
