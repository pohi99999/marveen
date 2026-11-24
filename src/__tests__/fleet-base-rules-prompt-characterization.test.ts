// The creation prompt of a sub-agent's CLAUDE.md, pinned byte for byte (MIOAGENTINSTALL1114, PR-I3; plan 4.3, N12).
//
// The two install-dependent rule texts of that prompt (the unknown-sender golden rule and the eight fleet rules) are
// lifted into one renderer, renderFleetBaseRules, so that a package agent gets the same text in its shell. The lift
// must not change the prompt a hand-made agent is created from: this file was written and run green on the code
// BEFORE the lift, and pins the sha256 of the whole prompt for every input the two texts depend on (plan 4.3,
// addendum (5)): the language, the helper recipes or the curl ones, an own token or the shared one, a configured
// Drive folder or none. The temp root is replaced by a fixed word before hashing, so the hash is the same on every
// machine.
//
// When a later change edits the creation prompt on purpose, these hashes change with it: update them in the same
// change, after reading the new prompt.
import { describe, it, expect, vi, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readdirSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'marveen-fleet-base-rules-char-'))
// readEnvFile (src/env.ts) takes its folder from this at import time.
process.env.CLAUDECLAW_ENV_DIR = tmpRoot

const drive = { value: '' }
vi.mock('../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config.js')>()
  return {
    ...real,
    STORE_DIR: '/nonexistent/claudeclaw-test-store',
    PROJECT_ROOT: tmpRoot,
    OWNER_NAME: 'TestOwner',
    MAIN_AGENT_ID: 'agent-a',
    HEARTBEAT_AGENT_ID: 'heartbeat',
    BOT_NAME: 'Botty',
    CHANNEL_PROVIDER: 'telegram',
    WEB_PORT: 3420,
    OWNER_DRIVE_FOLDER: '',
    DASHBOARD_PUBLIC_URL: '',
    AGENT_API_ORIGIN: '',
    APP_TZ: 'Europe/Budapest',
    mainAgentRecipientLedgerEnabled: () => false,
  }
})
vi.mock('../settings-store.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../settings-store.js')>()
  return {
    ...real,
    getEffectiveSettingValue: (key: string) => {
      if (key === 'AGENT_TOKENS') return '1'
      if (key === 'OWNER_DRIVE_FOLDER') return drive.value
      return real.getEffectiveSettingValue(key)
    },
  }
})
vi.mock('../web/agent-config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/agent-config.js')>()
  return {
    ...real,
    agentDir: (name: string) => join(tmpRoot, 'agents', name),
    agentConfigRoot: () => join(tmpRoot, 'agents'),
    listAgentNames: () => ['own-helper', 'own-curl', 'shared-helper', 'shared-curl'],
    readAgentCapabilities: () => [],
  }
})
const captured = { prompt: '' }
vi.mock('../agent.js', () => ({
  runAgent: async (prompt: string) => { captured.prompt = prompt; return { text: '# Generated\n' } },
}))
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => writeFileSync(path, content, 'utf-8'),
}))

mkdirSync(join(tmpRoot, 'templates', 'profiles'), { recursive: true })
for (const f of readdirSync(join(__dirname, '..', '..', 'templates', 'profiles'))) {
  copyFileSync(join(__dirname, '..', '..', 'templates', 'profiles', f), join(tmpRoot, 'templates', 'profiles', f))
}
for (const n of ['own-helper', 'own-curl', 'shared-helper', 'shared-curl']) mkdirSync(join(tmpRoot, 'agents', n, '.claude'), { recursive: true })
for (const n of ['own-helper', 'own-curl']) writeFileSync(join(tmpRoot, 'agents', n, '.dashboard-token'), 'c'.repeat(64), { mode: 0o600 })
for (const n of ['own-curl', 'shared-curl']) {
  writeFileSync(join(tmpRoot, 'agents', n, '.claude', 'settings.json'), JSON.stringify({ permissions: { deny: ['Bash(bash:*)'] } }), 'utf-8')
}

const sc = await import('../web/agent-scaffold.js')

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }))

function setLang(lang: 'hu' | 'en'): void {
  writeFileSync(join(tmpRoot, '.env'), `AGENT_TEXT_LANG=${lang}\n`, 'utf-8')
}

async function promptFor(lang: 'hu' | 'en', name: string, driveFolder: string): Promise<string> {
  setLang(lang)
  drive.value = driveFolder
  captured.prompt = ''
  await sc.generateClaudeMd(name, 'Keeps the books.', 'claude-sonnet-4-6')
  return captured.prompt.split(tmpRoot).join('<ROOT>')
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

// Measured on develop c0951d76f, BEFORE renderFleetBaseRules was lifted out of the two prompts.
// FORK (SKILLSGIT914): re-measured on the fork merge of v1.51.0. The fork's prompt differs from upstream's only in the
// skill section (one git-managed tree, <repo>/.claude/skills, commit + push; no skill-propose recipe); every other
// byte is upstream's. Diffed variant by variant before these values were written.
const EXPECTED: Record<string, string> = {
  'en:own-curl:drive=none': '7aa909e8366b5a64d2cd66d79ffcbc03eaadbd27031ef71c1a2d9330b80b9c18',
  'en:own-curl:drive=set': 'df65a5b88b02fcd9c69a6855725649af2df9dd4a90dfae773f69918ec869ecbb',
  'en:own-helper:drive=none': 'f8003887b11dd58b1b6ccec452253f90c8b2f9f512c56ed8f3b7eb55c73e2b01',
  'en:own-helper:drive=set': 'd9d9ad850ab8a64aa38c965814d75f9bcd619a953fab41df28de423e44ea6ae4',
  'en:shared-curl:drive=none': '79c00b410e132b537cff5d6f08bcddd2f8abfd8ce419b4307b7390103e54d685',
  'en:shared-curl:drive=set': '603a6173ac2a366060e8dc91acf95ebbcc15542327459e4d2b63014c0999331a',
  'en:shared-helper:drive=none': '16ccabd568be2fd794f828f4ae27d6241b8b4230468f1780214668b1c44dbfd0',
  'en:shared-helper:drive=set': 'b5d799d147eb84ff11bbe2fb5302619aab83466513d8ca77408e2420f9ec48f0',
  'hu:own-curl:drive=none': '4f78ac0be3a5cb6b58b33ca74881c2bbbc0efcd590e1465dbaff322fee8b8fa2',
  'hu:own-curl:drive=set': 'abf0ee54c087fc6d3bca34859e403ca7d5f2d90350c0975f6780dafee1fc3acb',
  'hu:own-helper:drive=none': '001b8553488baf4944c14a151bd7e83401108ebe3a666e3fe737d073b2805e76',
  'hu:own-helper:drive=set': '9c0ac0cef503b35ce077698e8a817c28f9f7e13ecd4bea185736f623f93daae3',
  'hu:shared-curl:drive=none': '366e6990f21a79b9e942e51f55ce61f740421f528ebcf3664c05cb62e208cda9',
  'hu:shared-curl:drive=set': '202c1a13b06016da81d268be745b320a815085ff83844a7ae5948aeb57c89bac',
  'hu:shared-helper:drive=none': 'e85d1cab951380365712e3a6508a825afc8e5734a031d1ec8b2a962e16689564',
  'hu:shared-helper:drive=set': 'fdf1c66110645f3a6a27dcd788923cc4d3f699eb34d0639b85ad1473a5b1e57e',
}

describe('the sub-agent creation prompt is byte-identical across the fleet base rules lift (N12)', () => {
  it('every variant of language, helper, own token and Drive folder hashes as before', async () => {
    const actual: Record<string, string> = {}
    for (const lang of ['hu', 'en'] as const) {
      for (const name of ['own-helper', 'own-curl', 'shared-helper', 'shared-curl']) {
        for (const d of ['', 'DRIVEFOLDER123']) {
          const p = await promptFor(lang, name, d)
          expect(p.length).toBeGreaterThan(1000)
          actual[`${lang}:${name}:drive=${d ? 'set' : 'none'}`] = sha(p)
        }
      }
    }
    expect(actual).toEqual(EXPECTED)
  })

  it('the prompt embeds fleetBaseRulesTemplate verbatim, in both languages (one source)', async () => {
    for (const lang of ['hu', 'en'] as const) {
      for (const name of ['own-helper', 'shared-curl']) {
        const p = await promptFor(lang, name, 'DRIVEFOLDER123')
        const tokenPath = name === 'own-helper' ? '<ROOT>/agents/own-helper/.dashboard-token' : '<ROOT>/store/.dashboard-token'
        setLang(lang)
        const t = sc.fleetBaseRulesTemplate({ agentName: name, lang, helper: name === 'own-helper', tokenPath, driveFolder: 'DRIVEFOLDER123' })
        expect(p).toContain(t.split(tmpRoot).join('<ROOT>') + '\n\nOutput ONLY the markdown content, no code fences.')
      }
    }
  })

  it('the variants differ where the inputs differ (the matrix is not degenerate)', async () => {
    const a = await promptFor('hu', 'own-helper', '')
    expect(await promptFor('hu', 'own-helper', 'DRIVEFOLDER123')).toContain('drive/folders/DRIVEFOLDER123')
    expect(a).not.toContain('drive/folders/')
    expect(await promptFor('hu', 'shared-curl', '')).toContain('curl -s -X POST')
    expect(a).toContain('marveen-api.sh message AGENT_NAME agent-a')
    expect(await promptFor('en', 'own-helper', '')).toContain('## Fleet rules (UNBREAKABLE')
    expect(await promptFor('hu', 'own-curl', '')).toContain('agents/own-curl/.dashboard-token')
    expect(await promptFor('hu', 'shared-curl', '')).not.toContain('agents/shared-curl/.dashboard-token')
  })
})
