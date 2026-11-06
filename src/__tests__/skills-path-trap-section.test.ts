// Functional test for ensureSkillsPathTrapSection() -- mirrors
// autonomy-section.test.ts. SKILLUTCSAPDA822: the isolated config root's
// `skills` entry IS the shared global dir (symlink), reads as "my own config",
// and five third-party skills landed fleet-wide through it on 2026-08-22. This
// proves the warning block actually reaches the agent file on respawn,
// idempotently.
//
// SKILLGYOKERNEV925: these assertions deliberately pin the MEASUREMENT
// (`echo "$CLAUDE_CONFIG_DIR"`) and BOTH root names, not one path string. A body
// that names a single root teaches a false generalisation in both directions,
// and the old assertions (`toContain('.claude-config/skills')`) would have
// passed on exactly the text that caused one: the root is named
// `.claude-config` for sub-agents and `.channels-config` for the main agent,
// measured 2026-09-25, and in both the `skills` entry is the same symlink.
import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-skilltrap-test-'))

vi.mock('../config.js', () => ({
  // agent-scaffold imports settings-store (MCPOROKLES923), which derives a path from
  // STORE_DIR at import time. A never-created dir: nothing here reads the store.
  STORE_DIR: '/nonexistent/claudeclaw-test-store',
  PROJECT_ROOT: tmpRoot,
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'agent-a',
  BOT_NAME: 'agent-a',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  DASHBOARD_PUBLIC_URL: '',
  // Empty = the resolver falls through to the public URL, then to
  // localhost -- i.e. exactly the behaviour these tests asserted
  // before AGENT_API_ORIGIN existed.
  AGENT_API_ORIGIN: '',
  APP_TZ: 'Europe/Budapest',
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(tmpRoot, 'agents', name),
  agentConfigRoot: () => join(tmpRoot, 'agents'),
  listAgentNames: () => ['agent-a', 'agent-b'],
  readAgentCapabilities: () => [],
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

const { ensureSkillsPathTrapSection } = await import('../web/agent-scaffold.js')

const MARKER_BEGIN = '<!-- BEGIN GENERATED: skills-path-trap (auto-generated, do not edit by hand) -->'
const MARKER_END = '<!-- END GENERATED: skills-path-trap -->'
// The measuring command: it falls back to ~/.claude when CLAUDE_CONFIG_DIR is empty (a DEFAULT install,
// MAIN_AGENT_ISOLATED_CONFIG=0), where the old form ran `ls -ld /skills` (upstream review of #1563).
const MEASURE = 'echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"; ls -ld "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"'

function setup(agentName: string, content: string) {
  const dir = join(tmpRoot, 'agents', agentName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'CLAUDE.md'), content, 'utf-8')
}

function read(agentName: string): string {
  return readFileSync(join(tmpRoot, 'agents', agentName, 'CLAUDE.md'), 'utf-8')
}

describe('ensureSkillsPathTrapSection', () => {
  it('appends the warning block to a CLAUDE.md that lacks it', () => {
    setup('agent-b', '# Agent B\n\nSome persona.\n')
    ensureSkillsPathTrapSection('agent-b')
    const out = read('agent-b')
    expect(out).toContain(MARKER_BEGIN)
    expect(out).toContain(MARKER_END)
    expect(out).toContain('marveen-skills')
    expect(out).toContain('EGYETLEN forrása')
    expect(out).toContain('.claude/skills')
    // Existing content untouched.
    expect(out).toContain('Some persona.')
  })

  it('is idempotent: a second call changes nothing', () => {
    setup('agent-b', '# Agent B\n')
    ensureSkillsPathTrapSection('agent-b')
    const first = read('agent-b')
    ensureSkillsPathTrapSection('agent-b')
    expect(read('agent-b')).toBe(first)
    // Exactly one block, not stacked.
    expect(first.split(MARKER_BEGIN).length - 1).toBe(1)
  })

  it('replaces ONLY the marked block, preserving hand-written text around it', () => {
    setup('agent-b', `# Agent B\n\n${MARKER_BEGIN}\nRÉGI SZÖVEG\n${MARKER_END}\n\nKézzel írt lábjegyzet.\n`)
    ensureSkillsPathTrapSection('agent-b')
    const out = read('agent-b')
    expect(out).not.toContain('RÉGI SZÖVEG')
    expect(out).toContain('Kézzel írt lábjegyzet.')
    expect(out).toContain('marveen-skills')
  })

  it('skips silently when there is no CLAUDE.md', () => {
    expect(() => ensureSkillsPathTrapSection('agent-nonexistent')).not.toThrow()
  })

  it('the main agent path targets PROJECT_ROOT/CLAUDE.md', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureSkillsPathTrapSection('agent-a')
    const out = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain(MARKER_BEGIN)
  })

  // SKILLGYOKERLATSZIK923: one text for everybody was wrong for the main agent in
  // the direction that matters -- it promised a private dir that does not exist
  // for a reader whose cwd IS the project root.
  // FORK (SKILLSGIT914): one skills tree for the whole fleet, so the main agent and a sub-agent get the SAME
  // body -- upstream's per-agent body (three locations, "EZ NEKED NEM PRIVÁT") describes a layout this install
  // retired on 2026-09-14 (no global ~/.claude/skills, no per-agent copy).
  it('the main agent and a sub-agent get the same one-source body', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureSkillsPathTrapSection('agent-a')
    const main = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8').split(MARKER_BEGIN)[1].split(MARKER_END)[0]
    setup('agent-b', '# Agent B\n')
    ensureSkillsPathTrapSection('agent-b')
    const sub = read('agent-b').split(MARKER_BEGIN)[1].split(MARKER_END)[0]
    for (const body of [main, sub]) {
      expect(body).toContain('EGYETLEN forrása')
      expect(body).toContain('NINCS globális `~/.claude/skills`')
      expect(body).not.toContain('EZ NEKED NEM PRIVÁT')
    }
    expect(main).toBe(sub)
  })

})

describe('wiring contracts', () => {
  it('startAgentProcess calls the ensure on every (re)spawn', () => {
    const src = readFileSync(join(__dirname, '../../src/web/agent-process.ts'), 'utf-8')
    const roster = src.indexOf('ensureFleetRosterSection(name)')
    const trap = src.indexOf('ensureSkillsPathTrapSection(name)')
    expect(roster).toBeGreaterThan(0)
    expect(trap).toBeGreaterThan(roster)
  })

  it('the generated template names the trap inline too', () => {
    const src = readFileSync(join(__dirname, '../../src/web/agent-scaffold.ts'), 'utf-8')
    expect(src).toContain('CSAPDA: a ~/.claude/skills és az agents/<név>/.claude/skills NEM létezik többé')
  })
})

// MEMSLUG1005 (#1700 review): the memory paragraph was held by no test, so neither
// the old ("never yours") nor the replacement ("keyed by the cwd slug") wording was
// pinned. Claude Code keys the auto-memory dir by the GIT ROOT, so the criterion the
// agent is given must be the path the harness names, resolved -- never a slug the
// agent derives from its working directory.
describe('skills-path-trap memory paragraph', () => {
  // The paragraph is the SAME for the main agent and a sub-agent (it lives outside the per-agent
  // part), and it comes AFTER the numbered location list: placed before the 2nd item it would cut
  // the list in two. Both halves are pinned, because dropping it for one kind of agent, or moving
  // it into the middle of the list, kept the whole file green (measured by mutation on cb174d8).
  const MEM_START = 'Ugyanez a csapda a MEMÓRIÁRA is áll'

  function expectMemoryParagraph(block: string) {
    expect(block).toContain('MEGADOTT útvonal')
    expect(block).toContain('`readlink -f`')
    expect(block).toContain('REPO GYÖKERE')
    expect(block).toContain('`POST /api/memories`')
    // The rejected rule must not come back: the cwd slug is a transcript dir on a
    // git checkout, and writing memory there is the silent loss this block prevents.
    expect(block).not.toMatch(/MUNKAKÖNYVTÁR\s+slugja\s+szerint\s+kulcsolt/)
    expect(block).not.toContain('a tiéd SOHA')
  }

  it('points at the harness-given path and the git-root keying, not a derived cwd slug', () => {
    setup('agent-mem', '# Agent Mem\n')
    ensureSkillsPathTrapSection('agent-mem')
    expectMemoryParagraph(read('agent-mem').split(MARKER_BEGIN)[1].split(MARKER_END)[0])
  })

  // FORK (SKILLSGIT914): the paragraph follows the one-source text, identical for both kinds of agent.
  const FORK_END = '(SKILLSGIT914, 2026-09-14.)'
  it('the main agent gets the same paragraph, after the one-source text', () => {
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureSkillsPathTrapSection('agent-a')
    const main = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8').split(MARKER_BEGIN)[1].split(MARKER_END)[0]
    expectMemoryParagraph(main)
    expect(main.indexOf(FORK_END)).toBeGreaterThan(-1)
    expect(main.indexOf(MEM_START)).toBeGreaterThan(main.indexOf(FORK_END))
  })

  it('a sub-agent gets it after the one-source text too, and the paragraph text is identical for both kinds', () => {
    setup('agent-mem2', '# Agent Mem 2\n')
    ensureSkillsPathTrapSection('agent-mem2')
    const sub = read('agent-mem2').split(MARKER_BEGIN)[1].split(MARKER_END)[0]
    expect(sub.indexOf(FORK_END)).toBeGreaterThan(-1)
    expect(sub.indexOf(MEM_START)).toBeGreaterThan(sub.indexOf(FORK_END))
    writeFileSync(join(tmpRoot, 'CLAUDE.md'), '# Main\n', 'utf-8')
    ensureSkillsPathTrapSection('agent-a')
    const main = readFileSync(join(tmpRoot, 'CLAUDE.md'), 'utf-8').split(MARKER_BEGIN)[1].split(MARKER_END)[0]
    expect(main.slice(main.indexOf(MEM_START))).toBe(sub.slice(sub.indexOf(MEM_START)))
  })
})
