// The import route validates the key with a trailing-newline-restored copy
// (needed for ssh-keygen to accept the PEM) but historically stored the raw,
// possibly newline-stripped client value. That passes ssh-keygen validation
// and returns 201, then fails later when something actually reads the stored
// key: an OpenSSH parser rejects a PEM without its closing newline. The gate
// here therefore checks the STORED value, not the response status.
import { describe, it, expect, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RouteContext } from '../web/routes/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'vault-ssh-keys-import-'))
mkdirSync(join(tmpRoot, 'store'), { recursive: true })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store') }
})

const { initDatabase, getVaultSshKey } = await import('../db.js')
const { tryHandleVaultSshKeys } = await import('../web/routes/vault-ssh-keys.js')
const { getSecret } = await import('../web/vault.js')

initDatabase(':memory:')

interface MockRes {
  statusCode: number
  body: string
  writeHead(status: number): MockRes
  end(data?: string): void
}
function mkRes(): MockRes {
  return {
    statusCode: 0,
    body: '',
    writeHead(status) { this.statusCode = status; return this },
    end(data) { if (data !== undefined) this.body += data },
  }
}

async function importKey(privateKey: string) {
  const payload = Buffer.from(JSON.stringify({ label: 'test-key', username: 'deploy', privateKey }))
  const req = Readable.from([payload]) as unknown as http.IncomingMessage
  const res = mkRes()
  const ctx: RouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    path: '/api/vault/ssh-keys/import',
    method: 'POST',
    url: new URL('http://127.0.0.1:3420/api/vault/ssh-keys/import'),
  }
  await tryHandleVaultSshKeys(ctx)
  return { res, json: () => JSON.parse(res.body || '{}') }
}

// The fixture key is built here, in-process, not with `ssh-keygen -t`: the
// ssh-keygen binary is not on every machine the suite runs on (measured
// 2026-10-21: a cloud container without openssh-client, where this test died
// with spawnSync ssh-keygen ENOENT before reaching the route). A fresh ed25519
// pair from node:crypto, serialized in the unencrypted openssh-key-v1 format --
// the same bytes `ssh-keygen -t ed25519 -N ''` writes. Generated per run, so no
// private key, not even a throwaway one, is checked in.
function sshString(b: Buffer | string): Buffer {
  const buf = typeof b === 'string' ? Buffer.from(b) : b
  const len = Buffer.alloc(4)
  len.writeUInt32BE(buf.length)
  return Buffer.concat([len, buf])
}
function freshPrivateKeyWithNewline(): string {
  const { privateKey } = generateKeyPairSync('ed25519')
  const jwk = privateKey.export({ format: 'jwk' })
  const seed = Buffer.from(jwk.d!, 'base64url')
  const pub = Buffer.from(jwk.x!, 'base64url')
  const pubBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)])
  const check = randomBytes(4)
  let priv = Buffer.concat([check, check, sshString('ssh-ed25519'), sshString(pub),
    sshString(Buffer.concat([seed, pub])), sshString('fixture')])
  const pad: number[] = []
  for (let i = 1; (priv.length + pad.length) % 8 !== 0; i++) pad.push(i)
  priv = Buffer.concat([priv, Buffer.from(pad)])
  const count = Buffer.alloc(4)
  count.writeUInt32BE(1)
  const body = Buffer.concat([Buffer.from('openssh-key-v1\0'), sshString('none'), sshString('none'), sshString(''),
    count, sshString(pubBlob), sshString(priv)]).toString('base64')
  const lines = body.match(/.{1,70}/g)!.join('\n')
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${lines}\n-----END OPENSSH PRIVATE KEY-----\n`
}

// The route itself validates the key with `ssh-keygen -y` (production, not
// touched here). Where the binary exists it is used as is. Where it does not, a
// fixture stand-in for exactly that call goes first on PATH: it parses the
// unencrypted openssh-key-v1 file, refuses anything malformed -- including a
// PEM without its closing newline, which the real ssh-keygen refuses too and
// the route's normalization exists for -- and prints the public key line.
const SSH_KEYGEN_SHIM = String.raw`#!/usr/bin/env python3
import base64, struct, sys
def die(msg):
    sys.stderr.write("Load key \"%s\": %s\n" % (sys.argv[-1], msg)); sys.exit(255)
if sys.argv[1:2] != ["-y"] or sys.argv[2:3] != ["-f"] or len(sys.argv) != 4:
    sys.stderr.write("ssh-keygen fixture shim: only -y -f <file> is supported\n"); sys.exit(1)
text = open(sys.argv[3]).read()
head, tail = "-----BEGIN OPENSSH PRIVATE KEY-----\n", "-----END OPENSSH PRIVATE KEY-----\n"
if not (text.startswith(head) and text.endswith(tail)):
    die("invalid format")
raw = base64.b64decode("".join(text[len(head):-len(tail)].split()), validate=True)
pos = 0
def take(n):
    global pos
    if pos + n > len(raw): die("invalid format")
    out = raw[pos:pos + n]; pos += n; return out
def string():
    (n,) = struct.unpack(">I", take(4)); return take(n)
if take(15) != b"openssh-key-v1\0": die("invalid format")
if string() != b"none" or string() != b"none" or string() != b"": die("encrypted keys are not supported by the shim")
if struct.unpack(">I", take(4))[0] != 1: die("invalid format")
pub_blob = string()
priv = string()
if pos != len(raw): die("invalid format")
p = 0
def ptake(n):
    global p
    if p + n > len(priv): die("invalid format")
    out = priv[p:p + n]; p += n; return out
def pstring():
    (n,) = struct.unpack(">I", ptake(4)); return ptake(n)
if ptake(4) != ptake(4): die("incorrect passphrase supplied to decrypt private key")
ktype = pstring(); pub = pstring(); secret = pstring(); comment = pstring()
if ktype != b"ssh-ed25519" or len(pub) != 32 or len(secret) != 64 or secret[32:] != pub: die("invalid format")
pad = priv[p:]
if pad != bytes(range(1, len(pad) + 1)): die("invalid format")
blob = struct.pack(">I", len(ktype)) + ktype + struct.pack(">I", len(pub)) + pub
if blob != pub_blob: die("invalid format")
print("ssh-ed25519 %s %s" % (base64.b64encode(blob).decode(), comment.decode()))
`
function haveSshKeygen(): boolean {
  try { execFileSync('sh', ['-c', 'command -v ssh-keygen'], { stdio: 'pipe' }); return true } catch { return false }
}
if (!haveSshKeygen()) {
  const shimDir = mkdtempSync(join(tmpdir(), 'ssh-keygen-shim-'))
  writeFileSync(join(shimDir, 'ssh-keygen'), SSH_KEYGEN_SHIM, { mode: 0o755 })
  process.env.PATH = `${shimDir}${delimiter}${process.env.PATH ?? ''}`
}

describe('POST /api/vault/ssh-keys/import: stored value trailing newline', () => {
  it('stores the private key WITH its trailing newline even when the client body had it stripped', async () => {
    const withNewline = freshPrivateKeyWithNewline()
    expect(withNewline.endsWith('\n')).toBe(true)
    const stripped = withNewline.replace(/\n+$/, '')
    expect(stripped.endsWith('\n')).toBe(false)

    const { res, json } = await importKey(stripped)

    // Sanity: the request itself must succeed (this is NOT the bug surface).
    expect(res.statusCode).toBe(201)

    const id = json().key.id as string
    const row = getVaultSshKey(id)
    expect(row).toBeDefined()
    const stored = getSecret(row!.vault_key_id)

    // THE ACTUAL BUG SURFACE: the value that lands in the vault, not the
    // response code. A stored PEM without its closing newline is rejected by
    // OpenSSH's parser the next time it is actually used.
    expect(stored).not.toBeNull()
    expect(stored!.endsWith('\n')).toBe(true)
    expect(stored).toBe(withNewline)
  })
})
