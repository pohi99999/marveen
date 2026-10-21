// The shipped usage-collect-hourly seed hardcoded one machine's install path
// ("cd /home/<user>/marveen && ..."), so on every other install the hourly usage
// collector and the quota gate cd'd into a directory that does not exist and
// failed every hour. The command must name the install root as a placeholder,
// and every path that turns a seed into a live command must land in THAT root:
//
//   * the shell seeders (install-*.sh, update.sh render_seed_template),
//   * the node seeder (substituteTemplatePlaceholders),
//   * the runtime resolver (resolveCommandPlaceholders), for a copy that was
//     seeded without rendering.
//
// The command is never executed here: on the old seed it would cd into a real
// install and run its quota gate.
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { substituteTemplatePlaceholders } from '../web/agent-scaffold.js'
import { resolveCommandPlaceholders } from '../web/command-task.js'

const ROOT = join(__dirname, '..', '..')
const SEED = join(ROOT, 'seed-scheduled-tasks', 'usage-collect-hourly', 'task-config.json')
const command: string = JSON.parse(readFileSync(SEED, 'utf-8')).command
const OTHER = '/opt/other-install'
const TAIL = ' && python3 scripts/usage-collect.py; python3 scripts/usage-quota-gate.py'

function shellRender(content: string, installDir: string): string {
  const update = readFileSync(join(ROOT, 'update.sh'), 'utf-8')
  const start = update.indexOf('render_seed_template() {')
  const fn = update.slice(start, update.indexOf('\n}', start) + 2)
  return execFileSync('/bin/bash', ['-c', `${fn}\nrender_seed_template`], {
    input: content,
    encoding: 'utf-8',
    env: { PATH: '/usr/bin:/bin', INSTALL_DIR: installDir, MAIN_AGENT_ID: 'main' },
  })
}

describe('usage-collect-hourly seed: the command runs in the install it was seeded into', () => {
  it('names the install root as a placeholder, not an absolute path', () => {
    expect(command.startsWith('cd {{INSTALL_DIR}} && ') || command.startsWith('cd {{PROJECT_ROOT}} && ')).toBe(true)
    expect(command).not.toMatch(/(^|\s)\/(home|Users|root)\//)
  })

  it('the shell seeders render it into the target install', () => {
    expect(shellRender(command, OTHER)).toBe(`cd ${OTHER}${TAIL}`)
  })

  it('the node seeder renders it into the target install', () => {
    const id = { projectRoot: OTHER, mainAgentId: 'main', botName: 'b', ownerName: 'o', webPort: 3420 }
    expect(substituteTemplatePlaceholders(command, id)).toBe(`cd ${OTHER}${TAIL}`)
  })

  it('an unrendered copy still resolves to the running install at run time, shell-quoted', () => {
    expect(resolveCommandPlaceholders(command, '/opt/other install')).toBe(`cd '/opt/other install'${TAIL}`)
  })
})
