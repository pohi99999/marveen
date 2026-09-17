import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Contract test for the sub-agent MCP scope isolation (card b970af61).
// Measured 2026-09-17: Claude Code walks UP from cwd for project-scope
// .mcp.json and inherits the local scope into subdirectories, so every
// agent in agents/<name> loaded the repo-root's main-agent-only servers
// (1.4-1.7 GB RSS per agent). `--mcp-config <own> --strict-mcp-config` was the
// only switch that isolated. This test reads the REAL launcher source and
// fails if the flag, or any of its three safety gates, is removed.

const ROOT = join(__dirname, '..', '..')
const stripTsComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')

describe('sub-agent launch: --strict-mcp-config with the agent\'s own .mcp.json', () => {
  const src = stripTsComments(readFileSync(join(ROOT, 'src/web/agent-process.ts'), 'utf-8'))
  const cfg = stripTsComments(readFileSync(join(ROOT, 'src/config.ts'), 'utf-8'))

  it('emits --mcp-config <agents/<name>/.mcp.json> --strict-mcp-config into the launch command', () => {
    expect(src).toMatch(/const strictMcpFlags = strictMcp \? `--mcp-config \$\{shSingleQuote\(agentMcpJsonPath\)\} --strict-mcp-config ` : ''/)
    expect(src).toMatch(/const agentMcpJsonPath = join\(agentDir\(name\), '\.mcp\.json'\)/)
    // the flag must sit in the ONE launch command template, before --model
    expect(src).toMatch(/\$\{skipFlag\}\$\{strictMcpFlags\}--model \$\{shSingleQuote\(model\)\}/)
  })

  it('is gated: never for the main agent, never with a --channels plugin, only when the own .mcp.json exists', () => {
    const gate = src.match(/const strictMcp =([\s\S]*?)\n\s*const strictMcpFlags/)
    expect(gate).not.toBeNull()
    const body = gate![1]
    expect(body).toMatch(/name !== MAIN_AGENT_ID/)
    expect(body).toMatch(/!channelFlag\.includes\('plugin:'\)/)
    expect(body).toMatch(/existsSync\(agentMcpJsonPath\)/)
    expect(body).toMatch(/SUBAGENT_STRICT_MCP/)
  })

  it('has a kill switch in config.ts that defaults ON and turns off with SUBAGENT_STRICT_MCP=0', () => {
    expect(cfg).toMatch(/export const SUBAGENT_STRICT_MCP =\s*\n\s*!\['0', 'false', 'no', 'off'\]\.includes\(\(cfg\('SUBAGENT_STRICT_MCP'\) \?\? ''\)/)
  })
})
