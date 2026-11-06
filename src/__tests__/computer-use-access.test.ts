import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
// The computer-use request_access dialog is the OWNER's to answer, from a Telegram button
// (Péter GO 10142). Before this, the minute menu pass answered it with Escape (= deny) after
// ~45 s (2026-10-22 22:02:58), and a Telegram-only session could never grant an app.
// The pane shape is the Claude Code 2.1.306 dialog (read from the bundle: title, ◉ grant lines,
// two un-numbered options with the default focus on Deny).
import { parseComputerUseAccessDialog, computerUseAccessSignature, detectsBlockingMenu } from '../pane-state.js'
import { decideComputerUseAccess, ComputerUseAccessGuard, CU_ACCESS_TIMEOUT_S, buildComputerUseAccessText, computerUseAccessKeyboard, type CuAccessDeps } from '../web/computer-use-access.js'
import { OWNER_RESOLVER, parseCallbackData } from '../web/telegram-approval.js'

function dialog(opts: { apps?: string[]; focus?: 'deny' | 'allow'; allowN?: number; extra?: string[]; allowLine?: string } = {}): string {
  const apps = opts.apps ?? ['Finder']
  const n = opts.allowN ?? apps.length
  const deny = `${opts.focus === 'allow' ? '  ' : '❯ '}Deny, and tell Claude what to do differently (esc)`
  const allow = opts.allowLine ?? `${opts.focus === 'allow' ? '❯ ' : '  '}Allow for this session (${n} ${n === 1 ? 'app' : 'apps'})`
  return [
    '',
    ' Computer Use wants to control these apps',
    '',
    ...apps.map((a) => `   ◉ ${a}`),
    ...(opts.extra ?? []),
    '',
    ` ${deny}`,
    ` ${allow}`,
    '',
    ' Enter to confirm · Esc to cancel',
    '',
  ].join('\n')
}
const IDLE_FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle)'

describe('parseComputerUseAccessDialog', () => {
  it('reads the grant and the focus from the dialog', () => {
    expect(parseComputerUseAccessDialog(dialog())).toEqual({ kind: 'dialog', dialog: { apps: ['Finder'], alsoRequested: [], notShown: 0, willHide: 0, focus: 'deny' } })
    const p = parseComputerUseAccessDialog(dialog({ focus: 'allow' }))
    expect(p.kind === 'dialog' && p.dialog.focus).toBe('allow')
  })

  it('keeps only the ◉ lines as the grant; flags, hidden and "more" are reported separately', () => {
    const pane = dialog({
      apps: ['Finder', 'Preview'],
      extra: [
        '   ✔ Safari (already granted)',
        '   ◯ Foo (not installed)',
        '   … +2 more apps not shown, and not included in this grant.',
        '',
        ' Also requested:',
        '   Clipboard read',
        '',
        ' 3 other apps will be hidden while Claude works.',
      ],
    })
    expect(parseComputerUseAccessDialog(pane)).toEqual({ kind: 'dialog', dialog: { apps: ['Finder', 'Preview'], alsoRequested: ['Clipboard read'], notShown: 2, willHide: 3, focus: 'deny' } })
  })

  it('parses a bordered rendering like the bare one', () => {
    const boxed = dialog().split('\n').map((l) => (l.trim() ? `│${l.padEnd(60)}│` : l)).join('\n')
    expect(parseComputerUseAccessDialog(boxed).kind).toBe('dialog')
  })

  it('is UNKNOWN (no keystroke) when the shape is not exactly the known one', () => {
    expect(parseComputerUseAccessDialog(dialog({ allowN: 2 })).kind).toBe('unknown') // the button counts other apps than shown
    expect(parseComputerUseAccessDialog(dialog({ allowLine: '  Allow once (1 app)' })).kind).toBe('unknown') // a new CLI wording
    expect(parseComputerUseAccessDialog(dialog({ apps: [] , allowN: 0 })).kind).toBe('unknown')
    const twoPointers = dialog().replace('  Allow for this session', '❯ Allow for this session')
    expect(parseComputerUseAccessDialog(twoPointers).kind).toBe('unknown')
  })

  it('is NONE when the title is only quoted at a live prompt, or the pane is mid-turn', () => {
    expect(parseComputerUseAccessDialog(`> about "Computer Use wants to control these apps"\n${IDLE_FOOTER}\n`).kind).toBe('none')
    expect(parseComputerUseAccessDialog(`${dialog()}\n✻ Thinking… (12s · ↓ 300 tokens · esc to interrupt)\n`).kind).toBe('none')
    expect(parseComputerUseAccessDialog('').kind).toBe('none')
  })

  it('the generic stuck-menu detector also matches it -- the reason the Escape reached it', () => {
    expect(detectsBlockingMenu(dialog())).toBe(true)
  })
})

describe('decideComputerUseAccess (pure)', () => {
  const d = (parseComputerUseAccessDialog(dialog()) as { kind: 'dialog'; dialog: any }).dialog
  const pending = { label: 'Brunella', approvalId: 'a1', signature: computerUseAccessSignature(d), apps: ['Finder'], timeoutAt: 1000 }
  const seen = { kind: 'dialog' as const, dialog: d }
  it('asks the owner on first sight, waits while the row is pending', () => {
    expect(decideComputerUseAccess(null, seen, null, 0)).toEqual({ kind: 'request', dialog: d })
    expect(decideComputerUseAccess(pending, seen, { status: 'pending', resolved_by: null }, 999)).toEqual({ kind: 'wait' })
  })
  it('allows ONLY on an approval resolved by the owner\'s Telegram decision', () => {
    expect(decideComputerUseAccess(pending, seen, { status: 'approved', resolved_by: OWNER_RESOLVER }, 10)).toEqual({ kind: 'allow' })
    expect(decideComputerUseAccess(pending, seen, { status: 'approved', resolved_by: 'dashboard' }, 10)).toEqual({ kind: 'deny', why: 'not-owner' })
  })
  it('denies on reject and on timeout', () => {
    expect(decideComputerUseAccess(pending, seen, { status: 'rejected', resolved_by: OWNER_RESOLVER }, 10)).toEqual({ kind: 'deny', why: 'rejected' })
    expect(decideComputerUseAccess(pending, seen, { status: 'pending', resolved_by: null }, 1000)).toEqual({ kind: 'deny', why: 'timeout' })
    expect(decideComputerUseAccess(pending, seen, { status: 'timeout', resolved_by: null }, 10)).toEqual({ kind: 'deny', why: 'timeout' })
  })
  it('cancels (no keystroke) when the dialog is gone, changed or unknown', () => {
    expect(decideComputerUseAccess(pending, { kind: 'none' }, { status: 'approved', resolved_by: OWNER_RESOLVER }, 10)).toEqual({ kind: 'cancel', why: 'gone' })
    const other = (parseComputerUseAccessDialog(dialog({ apps: ['Terminal'] })) as any)
    expect(decideComputerUseAccess(pending, other, { status: 'approved', resolved_by: OWNER_RESOLVER }, 10)).toEqual({ kind: 'cancel', why: 'changed' })
    expect(decideComputerUseAccess(pending, { kind: 'unknown', why: 'x' }, { status: 'approved', resolved_by: OWNER_RESOLVER }, 10)).toEqual({ kind: 'cancel', why: 'unknown-shape' })
  })
})

// A fake terminal: the dialog reacts to Down / Enter / Escape the way the 2.1.306 dialog does.
function harness(opts: { apps?: string[]; row?: { status: string; resolved_by: string | null }; createOk?: boolean; downMoves?: boolean } = {}) {
  let screen: 'dialog-deny' | 'dialog-allow' | 'granted' | 'denied' = 'dialog-deny'
  let apps = opts.apps ?? ['Finder']
  const keys: string[] = []
  const alerts: string[] = []
  const closed: string[] = []
  const created: Array<{ label: string; apps: string[] }> = []
  let row: { status: string; resolved_by: string | null } = opts.row ?? { status: 'pending', resolved_by: null }
  let now = 1_800_000_000_000
  const deps: CuAccessDeps = {
    capture: () => screen === 'dialog-deny' ? dialog({ apps }) : screen === 'dialog-allow' ? dialog({ apps, focus: 'allow' }) : `> \n${IDLE_FOOTER}\n`,
    sendKey: (_s, key) => {
      keys.push(key)
      if (key === 'Down' && screen === 'dialog-deny' && opts.downMoves !== false) screen = 'dialog-allow'
      else if (key === 'Enter' && screen === 'dialog-allow') screen = 'granted'
      else if (key === 'Enter' && screen === 'dialog-deny') screen = 'denied'
      else if (key === 'Escape' && screen.startsWith('dialog')) screen = 'denied'
    },
    sleep: async () => {},
    createRequest: async (label, d) => { created.push({ label, apps: d.apps }); return opts.createOk === false ? null : 'appr-1' },
    getRow: () => row as any,
    closeRow: (id) => { closed.push(id) },
    alert: (t) => { alerts.push(t) },
    nowMs: () => now,
  }
  const guard = new ComputerUseAccessGuard(deps)
  return {
    guard, keys, alerts, closed, created,
    get screen() { return screen },
    setRow: (r: typeof row) => { row = r },
    setApps: (a: string[]) => { apps = a },
    advance: (ms: number) => { now += ms },
  }
}

describe('ComputerUseAccessGuard', () => {
  it('without a button press it NEVER sends a key, and it keeps the generic Escape away', async () => {
    const h = harness()
    for (let i = 0; i < 20; i++) { expect(await h.guard.tick('marveen-channels', 'Brunella')).toBe(true); h.advance(5000) }
    expect(h.created).toEqual([{ label: 'Brunella', apps: ['Finder'] }])
    expect(h.keys).toEqual([])
    expect(h.screen).toBe('dialog-deny')
  })

  it('the owner\'s Engedélyezem: Down, re-read, Enter -- exactly the shown apps are granted', async () => {
    const h = harness({ apps: ['Finder', 'Preview'] })
    await h.guard.tick('s', 'Brunella')
    h.setRow({ status: 'approved', resolved_by: OWNER_RESOLVER })
    await h.guard.tick('s', 'Brunella')
    expect(h.keys).toEqual(['Down', 'Enter'])
    expect(h.screen).toBe('granted')
    expect(h.alerts.at(-1)).toContain('Finder, Preview')
    expect(h.guard.hasPending('s')).toBe(false)
  })

  it('the owner\'s Elutasítom: Escape (the dialog\'s deny), never Enter', async () => {
    const h = harness()
    await h.guard.tick('s', 'Brunella')
    h.setRow({ status: 'rejected', resolved_by: OWNER_RESOLVER })
    await h.guard.tick('s', 'Brunella')
    expect(h.keys).toEqual(['Escape'])
    expect(h.screen).toBe('denied')
  })

  it('an approval NOT from the owner\'s Telegram decision is a deny', async () => {
    const h = harness()
    await h.guard.tick('s', 'Brunella')
    h.setRow({ status: 'approved', resolved_by: 'dashboard' })
    await h.guard.tick('s', 'Brunella')
    expect(h.keys).toEqual(['Escape'])
  })

  it('no decision inside the window: deny, and the row is closed', async () => {
    const h = harness()
    await h.guard.tick('s', 'Brunella')
    h.advance((CU_ACCESS_TIMEOUT_S - 1) * 1000)
    await h.guard.tick('s', 'Brunella')
    expect(h.keys).toEqual([])
    h.advance(2000)
    await h.guard.tick('s', 'Brunella')
    expect(h.keys).toEqual(['Escape'])
    expect(h.closed).toEqual(['appr-1'])
  })

  it('the dialog changes before the decision: the old request is closed, no key is sent', async () => {
    const h = harness()
    await h.guard.tick('s', 'Brunella')
    h.setApps(['Terminal'])
    h.setRow({ status: 'approved', resolved_by: OWNER_RESOLVER })
    await h.guard.tick('s', 'Brunella')
    expect(h.keys).toEqual([])
    expect(h.closed).toEqual(['appr-1'])
  })

  it('the focus does not reach Allow after Down: NO Enter, a loud alert', async () => {
    const h = harness({ downMoves: false })
    await h.guard.tick('s', 'Brunella')
    h.setRow({ status: 'approved', resolved_by: OWNER_RESOLVER })
    await h.guard.tick('s', 'Brunella')
    expect(h.keys).toEqual(['Down'])
    expect(h.alerts.at(-1)).toContain('Entert NEM küldtem')
  })

  it('the owner cannot be asked: deny at once instead of a deaf channel', async () => {
    const h = harness({ createOk: false })
    await h.guard.tick('s', 'Brunella')
    expect(h.keys).toEqual(['Escape'])
  })

  it('an unrecognised shape: no keystroke, one alert, and the generic Escape still kept away', async () => {
    const alerts: string[] = []
    const keys: string[] = []
    const g = new ComputerUseAccessGuard({
      capture: () => dialog({ allowLine: '  Allow once (1 app)' }), sendKey: (_s, k) => { keys.push(k) }, sleep: async () => {},
      createRequest: async () => 'x', getRow: () => null, closeRow: () => {}, alert: (t) => { alerts.push(t) }, nowMs: () => 0,
    })
    expect(await g.tick('s', 'Brunella')).toBe(true)
    expect(await g.tick('s', 'Brunella')).toBe(true)
    expect(keys).toEqual([])
    expect(alerts).toHaveLength(1)
  })

  it('a pane without the dialog is left to the generic recovery', async () => {
    const keys: string[] = []
    const g = new ComputerUseAccessGuard({
      capture: () => ' /mcp\n ❯ telegram · connected\n Esc to cancel\n', sendKey: (_s, k) => { keys.push(k) }, sleep: async () => {},
      createRequest: vi.fn(async () => 'x'), getRow: () => null, closeRow: () => {}, alert: () => {}, nowMs: () => 0,
    })
    expect(await g.tick('s', 'Brunella')).toBe(false)
    expect(keys).toEqual([])
  })
})

describe('owner message and buttons', () => {
  it('lists the apps and the flags, and the buttons carry the approval\'s callback', () => {
    const d = { apps: ['Finder'], alsoRequested: ['Clipboard read'], notShown: 1, willHide: 0, focus: 'deny' as const }
    const t = buildComputerUseAccessText('Brunella', d, 1_800_000_600)
    expect(t).toContain('• Finder')
    expect(t).toContain('Clipboard read')
    expect(t).toContain('NEM kapnak engedélyt')
    expect(t).not.toContain('—')
    const kb = computerUseAccessKeyboard('0f0e0d0c-0b0a-4908-8706-050403020100', 'n0nceAAA')
    expect(kb.inline_keyboard[0].map((b) => b.text)).toEqual(['Engedélyezem', 'Elutasítom'])
    expect(parseCallbackData(kb.inline_keyboard[0][0].callback_data)).toMatchObject({ decision: 'approved' })
    expect(parseCallbackData(kb.inline_keyboard[0][1].callback_data)).toMatchObject({ decision: 'rejected' })
  })
})

describe('menu pass wiring', () => {
  it('the computer-use guard runs BEFORE the generic Escape branch, for every non-gate target', () => {
    const src = readFileSync(join(__dirname, '..', 'web', 'channel-monitor.ts'), 'utf-8')
    const guard = src.indexOf('await computerUseAccess().tick(t.session')
    const escape = src.indexOf("'Session parked in a blocking interactive menu -- sending Escape to recover'")
    const firstRun = src.indexOf('const firstRunGate = pane != null ? detectsFirstRunGate(pane) : null')
    expect(guard).toBeGreaterThan(0)
    expect(guard).toBeLessThan(firstRun)
    expect(guard).toBeLessThan(escape)
  })
})
