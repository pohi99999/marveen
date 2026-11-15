import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { resolveProviderEnv } from '../web/agent-process.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AGENT_LOCAL_CONTEXT_TOKENS, AGENT_LOCAL_CONTEXT_TOKENS_DEFAULT, PROJECT_ROOT, parseLocalContextTokens } from '../config.js'
import { SETTINGS_REGISTRY } from '../config-registry.js'
import type { CustomProviderDef } from '../web/custom-providers.js'

describe('resolveProviderEnv', () => {
  it('returns no export chain for a claude- model (uses host OAuth/API key elsewhere)', () => {
    const r = resolveProviderEnv('claude-sonnet-5', () => null)
    expect(r.provider).toBe('claude')
    expect(r.exportsStr).toBe('')
  })

  it('routes deepseek- models to the DeepSeek Anthropic-compatible endpoint with DEEPSEEK_API_KEY', () => {
    const seen: string[] = []
    const r = resolveProviderEnv('deepseek-v4-pro', (id) => {
      seen.push(id)
      return `"$(cat '/tmp/ref-${id}')"`
    })
    expect(r.provider).toBe('deepseek')
    expect(seen).toEqual(['DEEPSEEK_API_KEY'])
    // A HIVATKOZAS megy at, nem az ertek (LATENSKULCSARGV920).
    expect(r.exportsStr).toContain(`ANTHROPIC_AUTH_TOKEN="$(cat '/tmp/ref-DEEPSEEK_API_KEY')"`)
    expect(r.exportsStr).toContain('ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic')
    expect(r.exportsStr).toContain(`ANTHROPIC_MODEL='deepseek-v4-pro'`)
  })

  it('routes minimax- models to the MiniMax Anthropic-compatible endpoint with MINIMAX_API_KEY', () => {
    const seen: string[] = []
    const r = resolveProviderEnv('minimax-m3', (id) => {
      seen.push(id)
      return `"$(cat '/tmp/ref-${id}')"`
    })
    expect(r.provider).toBe('minimax')
    expect(seen).toEqual(['MINIMAX_API_KEY'])
    expect(r.exportsStr).toContain(`ANTHROPIC_AUTH_TOKEN="$(cat '/tmp/ref-MINIMAX_API_KEY')"`)
    expect(r.exportsStr).toContain('ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic')
    expect(r.exportsStr).toContain(`ANTHROPIC_MODEL='minimax-m3'`)
  })

  it('forces CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 for minimax- models -- the /anthropic compat layer misreports 200K (MiniMax-AI/MiniMax-M2.7#46), so the CLI must be told the real window explicitly', () => {
    const r = resolveProviderEnv('minimax-m3', () => `"$(cat '/tmp/ref')"`)
    expect(r.exportsStr).toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000')
  })

  it('does NOT force CLAUDE_CODE_MAX_CONTEXT_TOKENS for a claude- model -- the override is minimax-specific, not a blanket setting', () => {
    const r = resolveProviderEnv('claude-sonnet-5', () => null)
    expect(r.exportsStr).not.toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
  })

  it('forces CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000 for OpenRouter deepseek/deepseek-v4* -- OpenRouter lists 1,048,576 but the CLI caps unknown ids at 200k', () => {
    const r = resolveProviderEnv('deepseek/deepseek-v4.1-flash', () => `"$(cat '/tmp/ref')"`)
    expect(r.provider).toBe('openrouter')
    expect(r.exportsStr).toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000')
  })

  it('does NOT force the override for other OpenRouter models or the direct-API deepseek-v4-pro', () => {
    expect(resolveProviderEnv('qwen/qwen3-coder', () => null).exportsStr).not.toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
    expect(resolveProviderEnv('deepseek-v4-pro', () => null).exportsStr).not.toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS')
  })

  it('routes provider/model ids (containing "/") to OpenRouter, not minimax or ollama', () => {
    const seen: string[] = []
    const r = resolveProviderEnv('minimax/minimax-m3', (id) => {
      seen.push(id)
      return `"$(cat '/tmp/ref-${id}')"`
    })
    expect(r.provider).toBe('openrouter')
    expect(seen).toEqual(['openrouter-fleet-key'])
    expect(r.exportsStr).toContain('ANTHROPIC_BASE_URL=https://openrouter.ai/api')
  })

  it('falls back to Ollama for a bare tag (no "claude-"/"deepseek-"/"minimax-" prefix, no "/")', () => {
    const r = resolveProviderEnv('qwen3.6:27b', () => null)
    expect(r.provider).toBe('ollama')
    expect(r.exportsStr).toContain('ANTHROPIC_AUTH_TOKEN=ollama')
    expect(r.exportsStr).toContain(`ANTHROPIC_MODEL='qwen3.6:27b'`)
  })

  it('caps the context window for an Ollama tag with CLAUDE_CODE_DISABLE_1M_CONTEXT=1 -- from Claude Code 2.1.323 an unrecognized model id is assumed to be 1M', () => {
    const r = resolveProviderEnv('gemma4:12b', () => null)
    expect(r.provider).toBe('ollama')
    // Exact token, chained like the other exports, so a typo or a dropped `&&` also fails.
    expect(r.exportsStr).toContain(' && export CLAUDE_CODE_DISABLE_1M_CONTEXT=1 && ')
  })

  it('does NOT set CLAUDE_CODE_DISABLE_1M_CONTEXT for a claude- model -- the Anthropic models keep their own [1m] choice', () => {
    const r = resolveProviderEnv('claude-opus-5-5', () => null)
    expect(r.exportsStr).not.toContain('CLAUDE_CODE_DISABLE_1M_CONTEXT')
  })

  it('tells the CLI the real context window of an Ollama tag with CLAUDE_CODE_MAX_CONTEXT_TOKENS -- the 1M the CLI assumes, and the 200K of the safety net, are both far above what the local server loads', () => {
    const r = resolveProviderEnv('gemma4:12b', () => null)
    expect(r.provider).toBe('ollama')
    // Exact token, chained like the other exports: a dropped export, a typo or a dropped `&&` fails.
    expect(r.exportsStr).toContain(` && export CLAUDE_CODE_MAX_CONTEXT_TOKENS=${AGENT_LOCAL_CONTEXT_TOKENS} && `)
    // The number is the configured one, a plain whole number, never a guess baked into the launcher.
    const exported = /CLAUDE_CODE_MAX_CONTEXT_TOKENS=([^ ]+) /.exec(r.exportsStr)?.[1]
    expect(exported).toMatch(/^[0-9]+$/)
    expect(Number(exported)).toBe(AGENT_LOCAL_CONTEXT_TOKENS)
    // The safety net stays next to it.
    expect(r.exportsStr).toContain(' && export CLAUDE_CODE_DISABLE_1M_CONTEXT=1 && ')
  })

  it('the exported number comes from the setting, it is not baked into the launcher', () => {
    // On an install that keeps the default, a literal 32768 in the launcher would pass every value check
    // above. So this one reads what the ollama line is built from, the way agent-local-base-url.test.ts
    // does for the base URL: the same line that sets the ollama auth token and the base URL.
    const src = readFileSync(join(PROJECT_ROOT, 'src', 'web', 'agent-process.ts'), 'utf8')
    const line = src.split('\n').find(l => l.includes('ANTHROPIC_AUTH_TOKEN=ollama') && l.includes('ANTHROPIC_BASE_URL'))
    expect(line, 'the ollama exportsStr line is gone -- re-verify the patch by hand').toBeDefined()
    expect(line).toContain('export CLAUDE_CODE_MAX_CONTEXT_TOKENS=${AGENT_LOCAL_CONTEXT_TOKENS} && ')
    expect(line).not.toMatch(/CLAUDE_CODE_MAX_CONTEXT_TOKENS=[0-9]/)
  })

  it('the Ollama export chain, run by a shell, really sets both variables (behaviour, not a string search)', () => {
    const r = resolveProviderEnv('gemma4:12b', () => null)
    const out = execFileSync('/bin/bash', ['-c', `${r.exportsStr}printf '%s|%s|%s' "$CLAUDE_CODE_MAX_CONTEXT_TOKENS" "$CLAUDE_CODE_DISABLE_1M_CONTEXT" "$ANTHROPIC_MODEL"`], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
    expect(out).toBe(`${AGENT_LOCAL_CONTEXT_TOKENS}|1|gemma4:12b`)
  })

  it('does NOT cap the window of the hosted providers with the local number', () => {
    for (const model of ['claude-opus-5-5', 'deepseek-v4-pro', 'qwen/qwen3-coder']) {
      expect(resolveProviderEnv(model, () => null).exportsStr, model).not.toContain(`CLAUDE_CODE_MAX_CONTEXT_TOKENS=${AGENT_LOCAL_CONTEXT_TOKENS} `)
    }
    expect(resolveProviderEnv('minimax-m3', () => null).exportsStr).toContain('CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000')
  })

  it('AGENT_LOCAL_CONTEXT_TOKENS is a registered setting with the measured default, and a bad value never reaches the shell line', () => {
    const def = SETTINGS_REGISTRY.find(s => s.key === 'AGENT_LOCAL_CONTEXT_TOKENS')
    expect(def, 'AGENT_LOCAL_CONTEXT_TOKENS missing from SETTINGS_REGISTRY').toBeDefined()
    expect(def!.type).toBe('int')
    expect(def!.default).toBe(32768)
    expect(def!.requiresRestart).toBe(true)
    expect(AGENT_LOCAL_CONTEXT_TOKENS_DEFAULT).toBe(32768)
    // Good values pass through.
    expect(parseLocalContextTokens('32768')).toBe(32768)
    expect(parseLocalContextTokens('131072')).toBe(131072)
    expect(parseLocalContextTokens(' 8192 ')).toBe(8192)
    expect(parseLocalContextTokens('2048')).toBe(2048)
    expect(parseLocalContextTokens('2000000')).toBe(2000000)
    // Missing, empty, out of range, not a whole number, or shell text: the default.
    for (const bad of [undefined, '', '0', '-1', '2047', '2000001', '32768.5', '32k', '1e6', '0x8000', '32768; rm -rf /', '$(id)', '`id`', '32768 && echo x', '99999999']) {
      expect(parseLocalContextTokens(bad), String(bad)).toBe(32768)
    }
    // A value that only STARTS with a usable number is not read up to where it stops being one:
    // these would give 4096, 8192, 65536 and 131072 if the leading digits were taken.
    for (const bad of ['4096abc', '8192; rm -rf /', '65536.5', '131072 && echo x', '4096 8192', '+4096']) {
      expect(parseLocalContextTokens(bad), bad).toBe(32768)
    }
    // The registry's range and the parser's range are the same range.
    expect((def as { min?: number }).min).toBe(2048)
    expect((def as { max?: number }).max).toBe(2000000)
  })

  it('a titok ERTEKE sosem jut el a fuggvenyig: ami athalad, az hivatkozas (LATENSKULCSARGV920)', () => {
    // NEGATIV KONTROLL a javitas lenyegere. A hivo `launchSecretRef`-et ad at, ami FAJLBA teszi a
    // titkot; ide mar csak a `$(cat ...)` alak jon. Ha valaki visszaallitana az ertek-atadast, ez
    // az allitas piros lesz -- es vele az a tulajdonsag bukik, hogy a launch-parancs (es a `ps`
    // sora) nem hordozza a kulcsot.
    const TITOK = 'PROBA-ERTEK-ez-soha-nem-lathat-a-ps-ben'
    for (const model of ['deepseek-v4-pro', 'minimax-m3', 'minimax/minimax-m3']) {
      const r = resolveProviderEnv(model, () => `"$(cat '/tmp/kulcs-fajl')"`)
      expect(r.exportsStr, model).not.toContain(TITOK)
      expect(r.exportsStr, model).toContain(`$(cat '/tmp/kulcs-fajl')`)
    }
  })

  it('hivatkozas nelkul (nincs titok) URES ertek megy ki, nem a "null" szo', () => {
    const r = resolveProviderEnv('deepseek-v4-pro', () => null)
    expect(r.exportsStr).toContain('ANTHROPIC_AUTH_TOKEN=""')
    expect(r.exportsStr).not.toContain('null')
    expect(r.exportsStr).not.toContain('undefined')
  })

  it('never asks the secret lookup for a claude- model', () => {
    let called = false
    resolveProviderEnv('claude-sonnet-5', () => {
      called = true
      return 'unused'
    })
    expect(called).toBe(false)
  })

  // REGRESSZIOS ORZO: a custom-provider vault-kulcs hianya megallitja az inditast,
  // nem esik vissza csendben a rossz backendre. Ez a check kivehetetlen anelkul,
  // hogy ez a teszt piros ne legyen -- korabban semmilyen teszt nem pinnelte le
  // (Szotasz FIX-THEN-GO merese: a check kivetele mellett is 6537/6537 zold volt).
  for (const authHeader of ['x-api-key', 'Bearer'] as const) {
    it(`throws when a custom provider's vault key (authHeader=${authHeader}) has no secret, instead of launching without one`, () => {
      const def: CustomProviderDef = {
        id: 'my-provider',
        label: 'My Provider',
        baseUrl: 'https://api.example.com',
        authHeader,
        vaultKey: 'missing-vault-key',
      }
      const seen: string[] = []
      expect(() => resolveProviderEnv('some-model', (id) => {
        seen.push(id)
        return null // a hivo pontosan ezt adja vissza, ha a vault-kulcshoz nincs titok
      }, def)).toThrow(/missing-vault-key/)
      expect(seen).toEqual(['missing-vault-key'])
    })
  }

  it("does NOT throw for authHeader='none' even when the vault key lookup would fail -- no key is needed on that path", () => {
    const def: CustomProviderDef = {
      id: 'ollama-like',
      label: 'No-auth provider',
      baseUrl: 'http://localhost:11434',
      authHeader: 'none',
      vaultKey: null,
    }
    const r = resolveProviderEnv('some-model', () => null, def)
    expect(r.provider).toBe('custom')
    expect(r.exportsStr).toContain('ANTHROPIC_AUTH_TOKEN=ollama')
  })
})
