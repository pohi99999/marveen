#!/usr/bin/env node
// marveen-api MCP server (stdio). The logic is in core.mjs (tested with node --test).
// Configured per agent in agents/<name>/.mcp.json, NEVER in the root .mcp.json:
//   "marveen-api": { "command": "node", "args": ["<repo>/plugins/marveen-api/server.mjs"],
//                    "env": { "MARVEEN_AGENT_ID": "<name>" } }
// Optional env: MARVEEN_API_BASE (default http://127.0.0.1:3420),
// MARVEEN_DASHBOARD_TOKEN_FILE (default <repo>/store/.dashboard-token).
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOLS, callTool, AGENT_RE } from './core.mjs'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const agent = process.env.MARVEEN_AGENT_ID || ''
const tokenFile = process.env.MARVEEN_DASHBOARD_TOKEN_FILE || join(repo, 'store', '.dashboard-token')

const deps = {
  agent,
  base: (process.env.MARVEEN_API_BASE || 'http://127.0.0.1:3420').replace(/\/+$/, ''),
  fetch: (url, init) => fetch(url, init),
  token: () => readFile(tokenFile, 'utf-8'),
}

const mcp = new Server({ name: 'marveen-api', version: '0.1.0' }, { capabilities: { tools: {} } })

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
}))

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (!AGENT_RE.test(agent)) {
    return { content: [{ type: 'text', text: 'marveen-api: MARVEEN_AGENT_ID is missing or malformed in this server config; nothing was sent' }], isError: true }
  }
  return callTool(req.params.name, req.params.arguments, deps)
})

await mcp.connect(new StdioServerTransport())
