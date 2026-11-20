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
  'en:own-curl:drive=none': '3377e1ee8bc7a27611b7a6ae65b0f62c1b7f5afb1dafea8dfbcaf52b92031419',
  'en:own-curl:drive=set': '6ad52c57e11c32077e45850097b52fda0b16c3327427a96657aa66212538af68',
  'en:own-helper:drive=none': '5b309582cbfba5212b76fb59ce17d6167d6123017b4103b3f7eaa292b129796a',
  'en:own-helper:drive=set': 'a82daca5498d7b074f2f0b9efea1893c4ce36a12c9cbd8256ac664c0edb7e980',
  'en:shared-curl:drive=none': 'ffc50df3686ffd7c1e7cad3435f682eb410f7577541b4dfb3210b2516a71a050',
  'en:shared-curl:drive=set': 'ec11b94087f4a825eb078a5abc6d85305da3e6fa5e3b9893a2bfe07fed31c8a2',
  'en:shared-helper:drive=none': 'cbda0bdf405aa99377b3135c5ff12caf6ef77a827bab3257d0e86037098d2329',
  'en:shared-helper:drive=set': 'd3166060ea1c4dd222f86b6879c3d8cdf6df534c81214ff3913e4e5f3cf349bc',
  'hu:own-curl:drive=none': 'd413db393171d0032421f2d2eab09d6359d8609e5ca50f475cbd1ea808901378',
  'hu:own-curl:drive=set': 'cce93976395b531787473cb27a2e69daec2f7175f77abe4a0eb664d1c4a90778',
  'hu:own-helper:drive=none': 'f2192d9215e664ce0009145fd4932dc8b53bbf30c473d60979b0511bbf07bcb2',
  'hu:own-helper:drive=set': '3c4cef091cf02e9849e18894feeb9927162393ee1e51c2c8d1086cb86fb65768',
  'hu:shared-curl:drive=none': 'acff2c5c2ca87d85e9e995138700f6cf998de092748f68d1e050096fb6c00f2e',
  'hu:shared-curl:drive=set': 'eafc3c6a99e2e76652838d94041ce25be61b1de0f9332a65b4aa95e3f8496408',
  'hu:shared-helper:drive=none': '2d5cbe08deea765d091a07ca847c74fb88e1fc98056358c0fe30fa61801d4f4d',
  'hu:shared-helper:drive=set': 'e6f41bf75850903588d6c4a16c80592cf99d6b02dbfaec1528746261312f2fff',
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
