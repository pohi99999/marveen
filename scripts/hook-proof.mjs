#!/usr/bin/env node
// scripts/hook-proof.mjs -- push gate with per-commit proof that the pre-commit
// checks ran. Zero dependencies (node + git only).
//
// The pre-commit hooks (prod-tree-guard, secret-gate) are the fast lane; they
// are skippable with `git commit --no-verify`, and nothing so far noticed when
// that happened. This gate closes that hole on the PUSH side:
//
//   pre-commit  -> remember the tree that was checked (write-tree of the index)
//   post-commit -> if HEAD's tree is that tree, record HEAD as verified
//   pre-push    -> every commit about to leave this machine for the first time
//                  must be verified, else the push is blocked -- loudly.
//
// "About to leave for the first time" = not reachable from any remote-tracking
// ref (`--not --remotes`), so commits merged in from upstream, or already on
// the fork, never need a local proof. Merge commits are exempt (git runs no
// pre-commit for `git merge`); their parents are checked like any other commit.
//
// State lives in <git-common-dir>/marveen-hook-proof/ (shared by worktrees,
// never committed). Pattern after ops/scripts/hook-proof.mjs in
// mcp-brunella-core, reduced to what git itself can tell us.
//
// Deliberate bypass (loud, for the record):  MARVEEN_PUSH_PROOF_SKIP=1 git push ...
// Attest commits by hand after a rebase:      node scripts/hook-proof.mjs attest <rev-range>

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ZERO = '0000000000000000000000000000000000000000';

function git(args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (err) {
    if (allowFail) return '';
    throw err;
  }
}

const commonDir = path.resolve(git(['rev-parse', '--git-common-dir']));
const stateDir = path.join(commonDir, 'marveen-hook-proof');
const verifiedFile = path.join(stateDir, 'verified-commits.json');
const pendingFile = path.join(stateDir, 'precommit-pending.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function lines(s) {
  return s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** Keep the proof file from growing forever: only commits still in recent history. */
function prune(records) {
  const keep = new Set(lines(git(['rev-list', '--max-count=500', '--all'], { allowFail: true })));
  return Object.fromEntries(Object.entries(records).filter(([sha]) => keep.has(sha)));
}

function preCommit() {
  writeJson(pendingFile, {
    tree: git(['write-tree']),
    head: git(['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }) || null,
    createdAt: new Date().toISOString(),
  });
}

function postCommit() {
  const pending = readJson(pendingFile, null);
  const head = git(['rev-parse', 'HEAD']);
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  if (pending && pending.tree === tree) {
    const verified = readJson(verifiedFile, {});
    verified[head] = { tree, source: 'pre-commit', verifiedAt: new Date().toISOString() };
    writeJson(verifiedFile, prune(verified));
  }
  if (fs.existsSync(pendingFile)) fs.unlinkSync(pendingFile);
}

function attest(range) {
  if (!range) throw new Error('attest needs a rev-range, e.g. HEAD~3..HEAD');
  const shas = lines(git(['rev-list', range]));
  const verified = readJson(verifiedFile, {});
  for (const sha of shas) {
    verified[sha] = { tree: git(['rev-parse', `${sha}^{tree}`]), source: 'manual-attest', verifiedAt: new Date().toISOString() };
  }
  writeJson(verifiedFile, prune(verified));
  console.error(`hook-proof: ${shas.length} commit(s) attested BY HAND (source=manual-attest). This is on the record.`);
}

function isMerge(sha) {
  return lines(git(['rev-list', '--parents', '-n', '1', sha])).join(' ').split(' ').length > 2;
}

function prePush(input) {
  const verified = readJson(verifiedFile, {});
  const unverified = [];
  for (const line of lines(input)) {
    const [, localSha] = line.split(' ');
    if (!localSha || localSha === ZERO) continue; // branch deletion
    // Commits that no remote has yet: these leave the machine with this push.
    const outgoing = lines(git(['rev-list', localSha, '--not', '--remotes'], { allowFail: true }));
    for (const sha of outgoing) {
      if (verified[sha]) continue;
      if (isMerge(sha)) continue;
      if (!unverified.includes(sha)) unverified.push(sha);
    }
  }
  if (unverified.length === 0) return;
  const skip = process.env.MARVEEN_PUSH_PROOF_SKIP === '1';
  const subjects = unverified.map((sha) => `  ${sha.slice(0, 10)}  ${git(['log', '-1', '--format=%s', sha], { allowFail: true })}`);
  const msg = [
    '',
    skip ? 'pre-push: MARVEEN_PUSH_PROOF_SKIP=1 -- pushing commits WITHOUT pre-commit proof:'
         : 'BLOCKED: outgoing commit(s) without pre-commit proof.',
    ...subjects,
    skip ? '' : 'The pre-commit hooks (prod-tree-guard, secret-gate) did not run for these -- typically',
    skip ? '' : '`git commit --no-verify`, or a rebase/cherry-pick that rewrote them.',
    skip ? '' : 'Re-check and attest by hand:  node scripts/hook-proof.mjs attest <range>',
    skip ? '' : 'Deliberate bypass (on the record): MARVEEN_PUSH_PROOF_SKIP=1 git push ...',
    '',
  ].filter((l, i, a) => !(l === '' && a[i - 1] === ''));
  console.error(msg.join('\n'));
  if (!skip) process.exit(1);
}

function status() {
  const verified = readJson(verifiedFile, {});
  const local = lines(git(['rev-list', 'HEAD', '--not', '--remotes'], { allowFail: true }));
  console.log(`verified commits on record: ${Object.keys(verified).length}`);
  console.log(`commits not on any remote:  ${local.length}`);
  for (const sha of local) {
    const v = verified[sha];
    console.log(`  ${sha.slice(0, 10)}  ${v ? `proof (${v.source})` : isMerge(sha) ? 'merge (exempt)' : 'NO PROOF'}  ${git(['log', '-1', '--format=%s', sha])}`);
  }
}

const [, , command, ...rest] = process.argv;
try {
  switch (command) {
    case 'pre-commit': preCommit(); break;
    case 'post-commit': postCommit(); break;
    case 'pre-push': prePush(fs.readFileSync(0, 'utf8')); break;
    case 'attest': attest(rest[0]); break;
    case 'status': status(); break;
    default:
      console.error('Usage: node scripts/hook-proof.mjs <pre-commit|post-commit|pre-push|attest <range>|status>');
      process.exit(2);
  }
} catch (err) {
  console.error(`hook-proof failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
