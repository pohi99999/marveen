// Regression pin for SECURITY_AUDIT.md H1: POST /api/agents/:name/channels/slack/smoke-test
// must hand the URL-decoded agent name to the script as ONE argument, never through a shell.
// The old execSync(`bash "${scriptPath}" "${name}"`) ran whatever the name smuggled in.
//
// Everything lives in a private temp dir: the agent dir, its Slack .env and a stub
// smoke-test script that only echoes its arguments. The payload in the name only
// touches a marker file inside that temp dir.
import { describe, it, expect, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const h = vi.hoisted(() => {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  const { join: j } = require('node:path') as typeof import('node:path')
  const root = mkdtempSync(j(tmpdir(), 'slack-smoke-test-'))
  return { root, agent: j(root, 'agents', 'victim') }
})

vi.mock('../web/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    // Every name resolves to the one fixture agent, so the route reaches the exec call.
    agentDir: () => h.agent,
    readAgentChannelProvider: () => 'slack',
  }
})

const { tryHandleAgents } = await import('../web/routes/agents.js')

const MARKER = join(h.root, 'injected')
// The route computes the script as <agentDir>/../../scripts/smoke-test-slack-channel.sh
mkdirSync(join(h.root, 'scripts'), { recursive: true })
writeFileSync(join(h.root, 'scripts', 'smoke-test-slack-channel.sh'), '#!/bin/bash\nprintf "argc=%s arg1=[%s]" "$#" "$1"\n')
mkdirSync(join(h.agent, '.claude', 'channels', 'slack'), { recursive: true })
writeFileSync(join(h.agent, '.claude', 'channels', 'slack', '.env'), 'SLACK_SMOKE_TEST_ALLOWED=true\n')
afterAll(() => { rmSync(h.root, { recursive: true, force: true }) })

async function smokeTest(name: string): Promise<{ ok: boolean; output: string }> {
  let raw = ''
  const res = {
    writeHead() { return res },
    end(chunk?: string | Buffer) { if (chunk) raw = String(chunk) },
  }
  const path = `/api/agents/${encodeURIComponent(name)}/channels/slack/smoke-test`
  const ctx = { req: {}, res, path, method: 'POST', url: new URL(`http://localhost${path}`) } as unknown as RouteContext
  expect(await tryHandleAgents(ctx, '')).toBe(true)
  return JSON.parse(raw)
}

describe('Slack smoke-test route: the agent name never reaches a shell', () => {
  it('passes a shell-metacharacter name as one literal argument and runs nothing from it', async () => {
    const name = `x"; touch "${MARKER}"; echo "`
    const r = await smokeTest(name)
    expect(existsSync(MARKER)).toBe(false)
    expect(r.output).toBe(`argc=1 arg1=[${name}]`)
  })

  it('still runs the script for an ordinary name', async () => {
    const r = await smokeTest('victim')
    expect(r.ok).toBe(true)
    expect(r.output).toBe('argc=1 arg1=[victim]')
  })
})
