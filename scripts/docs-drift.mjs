#!/usr/bin/env node
// scripts/docs-drift.mjs -- does the documentation still describe the code?
// Zero dependencies (node only). Read-only unless --write.
//
// Two things, both measured from the tree, never from memory:
//   1. A managed statistics block in docs/README.md (between DOC_STATS markers):
//      counts that drift silently (route modules, API paths, hooks, seed tasks,
//      git-hook installers, docs pages) plus the list of docs pages the index
//      does not link. --check fails if the block is stale; --write regenerates
//      it. ONLY TRACKED FILES feed the block: agents/ and .mcp.json are
//      host-local (gitignored), so a count of them would differ per checkout
//      and fail on every clean CI clone -- they are printed for information
//      only (measured 2026-09-07, Brunella's "stable measure" condition).
//   2. Cross-checks that need a human, so they always fail --check until fixed:
//      - a docs/README.md link to a file that does not exist
//      - a .claude/settings.json hook whose script file does not exist
//      - a seed scheduled task (scheduled-tasks/<name>/) that
//        docs/scheduled-tasks.md never mentions
//
// Pattern after ops/scripts/sync_doc_stats.ts in mcp-brunella-core, with
// marveen's own measures. The 2026-09-07 docs audit was found by hand; this
// makes the same finding a one-line check in doctor.sh and CI.
//
//   node scripts/docs-drift.mjs --check   (default; exit 1 on drift)
//   node scripts/docs-drift.mjs --write   (update the managed block; cross-checks still reported)
//   node scripts/docs-drift.mjs --json

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.env.DOCS_DRIFT_ROOT ? path.resolve(process.env.DOCS_DRIFT_ROOT) : path.resolve(new URL('..', import.meta.url).pathname);
const START = '<!-- DOC_STATS_START -->';
const END = '<!-- DOC_STATS_END -->';
const INDEX = 'docs/README.md';

const rd = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const listDirs = (rel) => (exists(rel) ? fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);
const listFiles = (rel, re) => (exists(rel) ? fs.readdirSync(path.join(ROOT, rel)).filter((f) => re.test(f)).sort() : []);

export function collectStats() {
  const agents = listDirs('agents').filter((a) => exists(`agents/${a}/CLAUDE.md`));
  const routeModules = listFiles('src/web/routes', /\.ts$/).filter((f) => !f.endsWith('.d.ts') && f !== 'types.ts');
  const apiPaths = new Set();
  for (const f of listFiles('src/web/routes', /\.ts$/)) {
    for (const m of rd(`src/web/routes/${f}`).matchAll(/['"`](\/api\/[a-z0-9][a-z0-9/_-]*)/g)) apiPaths.add(m[1]);
  }
  const settings = exists('.claude/settings.json') ? JSON.parse(rd('.claude/settings.json')) : {};
  const hookEntries = Object.values(settings.hooks || {}).flat().flatMap((e) => e.hooks || []);
  const hookScripts = new Set(hookEntries.map((h) => (h.command || '').match(/scripts\/hooks\/[A-Za-z0-9_.-]+/)?.[0]).filter(Boolean));
  const mcp = exists('.mcp.json') ? Object.keys(JSON.parse(rd('.mcp.json')).mcpServers || {}) : [];
  const seedTasks = listDirs('scheduled-tasks');
  const hookInstallers = listFiles('scripts', /^install-.*-hook\.sh$/);
  const docsPages = listFiles('docs', /\.md$/).filter((f) => f !== 'README.md');
  const index = exists(INDEX) ? rd(INDEX) : '';
  const indexWithoutBlock = index.replace(new RegExp(`${START}[\\s\\S]*?${END}`), '');
  const linked = new Set([...indexWithoutBlock.matchAll(/\]\(([A-Za-z0-9_./-]+\.md)\)/g)].map((m) => m[1]));
  const unlinkedDocs = docsPages.filter((f) => !linked.has(f));
  return {
    agents, routeModules, apiPaths: [...apiPaths].sort(), hookEvents: Object.keys(settings.hooks || {}), hookEntries: hookEntries.length,
    hookScripts: [...hookScripts].sort(), mcp, seedTasks, hookInstallers, docsPages, linked: [...linked].sort(), unlinkedDocs,
  };
}

export function renderBlock(s) {
  return [
    START,
    '## Auto-generált projekt-statisztika',
    '',
    '_Ezt a blokkot a `node scripts/docs-drift.mjs --write` frissíti; a `--check` (doctor.sh, CI) elbukik, ha elavult. Kézzel ne szerkeszd. Csak követett fájlokból számol (az `agents/` és a `.mcp.json` host-lokális, ezért nincs itt)._',
    '',
    `- Route-modulok (\`src/web/routes/*.ts\`): **${s.routeModules.length}**, egyedi \`/api/...\` útvonal-literál bennük: **${s.apiPaths.length}**`,
    `- Claude Code hookok (\`.claude/settings.json\`): **${s.hookEvents.length}** esemény, **${s.hookEntries}** bejegyzés, **${s.hookScripts.length}** szkript a \`scripts/hooks/\` alatt`,
    `- Seed ütemezett feladatok (\`scheduled-tasks/\`): **${s.seedTasks.length}** -- ${s.seedTasks.join(', ')}`,
    `- Git-hook telepítők (\`scripts/install-*-hook.sh\`): **${s.hookInstallers.length}** -- ${s.hookInstallers.map((f) => f.replace(/^install-|-hook\.sh$/g, '')).join(', ')}`,
    `- Dokumentációs lapok a \`docs/\` alatt: **${s.docsPages.length}**, ebből a fenti táblázat linkel **${s.docsPages.length - s.unlinkedDocs.length}**`,
    '',
    s.unlinkedDocs.length
      ? ['### Lapok, amiket a fenti táblázat még nem sorol be', '', ...s.unlinkedDocs.map((f) => `- [${f.replace(/\.md$/, '')}](${f})`), ''].join('\n')
      : '_Minden lap be van sorolva a táblázatba._\n',
    END,
  ].join('\n');
}

export function crossChecks(s) {
  const problems = [];
  for (const l of s.linked) if (!exists(`docs/${l}`)) problems.push(`docs/README.md linkel egy nem létező lapot: ${l}`);
  for (const h of s.hookScripts) if (!exists(h)) problems.push(`.claude/settings.json hook egy nem létező szkriptre mutat: ${h}`);
  const taskDoc = exists('docs/scheduled-tasks.md') ? rd('docs/scheduled-tasks.md') : '';
  for (const t of s.seedTasks) if (!taskDoc.includes(t)) problems.push(`seed ütemezett feladat, amit a docs/scheduled-tasks.md nem említ: ${t}`);
  return problems;
}

function upsert(content, block) {
  const re = new RegExp(`${START}[\\s\\S]*?${END}`);
  if (re.test(content)) return content.replace(re, block);
  return `${content.trimEnd()}\n\n${block}\n`;
}

function main() {
  const args = new Set(process.argv.slice(2));
  const write = args.has('--write');
  const json = args.has('--json');
  const stats = collectStats();
  const block = renderBlock(stats);
  const index = exists(INDEX) ? rd(INDEX) : '';
  const current = index.match(new RegExp(`${START}[\\s\\S]*?${END}`))?.[0] ?? null;
  const blockStale = current !== block;
  const problems = crossChecks(stats);
  if (write && blockStale) {
    fs.writeFileSync(path.join(ROOT, INDEX), upsert(index, block), 'utf8');
  }
  const drift = (blockStale && !write) || problems.length > 0;
  if (json) {
    console.log(JSON.stringify({ stats, blockStale, written: write && blockStale, problems, drift }, null, 2));
  } else {
    console.log(`docs-drift: route modules ${stats.routeModules.length} | api paths ${stats.apiPaths.length} | hooks ${stats.hookEntries} | seed tasks ${stats.seedTasks.length} | docs ${stats.docsPages.length} (${stats.unlinkedDocs.length} not in the index table) | host-local, not in the block: agents ${stats.agents.length}, mcp ${stats.mcp.length}`);
    if (blockStale) console.log(write ? `docs-drift: managed block in ${INDEX} REWRITTEN.` : `docs-drift: managed block in ${INDEX} is ${current === null ? 'MISSING' : 'STALE'} -- run: node scripts/docs-drift.mjs --write`);
    else console.log('docs-drift: managed block is current.');
    for (const p of problems) console.log(`docs-drift: DRIFT -- ${p}`);
    if (!drift) console.log('docs-drift: no drift.');
  }
  process.exit(drift ? 1 : 0);
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (direct) main();
