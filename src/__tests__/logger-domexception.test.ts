// A DOMException given to the logger as `err` is logged, not thrown (APPROVALNOTIFYRETRY1118, second review of PR #56).
//
// AbortSignal.timeout() and an aborted fetch reject with a DOMException. Its name, message and code are getters on the
// prototype that answer only for a real DOMException, so the masked copy the logger makes (Object.create of the
// prototype) threw `Value of "this" must be of DOMException` when pino read it: every `logger.warn({ err })` in the catch
// block of a request with a timeout threw instead of logging.
import { describe, it, expect } from 'vitest'
import { createLogger, maskError } from '../logger.js'

/** The error a real fetch with AbortSignal.timeout() rejects with: the signal's own reason. */
async function realTimeoutError(): Promise<unknown> {
  const signal = AbortSignal.timeout(1)
  await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()))
  return signal.reason
}

describe('maskError on a DOMException', () => {
  it('the real timeout error is a DOMException named TimeoutError (the guard is not vacuous)', async () => {
    const e = await realTimeoutError()
    expect(e).toBeInstanceOf(DOMException)
    expect((e as DOMException).name).toBe('TimeoutError')
    // the copy the logger used to make: reading it throws
    const naive = Object.create(Object.getPrototypeOf(e as object)) as Error
    expect(() => naive.message).toThrow(/DOMException/)
  })

  it('gives a copy that can be read: the same name, message and code', async () => {
    const e = (await realTimeoutError()) as DOMException
    const copy = maskError(e) as Error & { code?: number }
    expect(copy).toBeInstanceOf(Error)
    expect(copy.name).toBe('TimeoutError')
    expect(copy.message).toBe(e.message)
    expect(copy.code).toBe(e.code)
    expect(typeof copy.stack === 'string' || copy.stack === undefined).toBe(true)
    // the original is not touched
    expect(e.name).toBe('TimeoutError')
  })

  it('still masks a secret in its message', () => {
    const copy = maskError(new DOMException('aborted: https://api.example/send?token=abcdef0123456789abcdef', 'AbortError'))
    expect(copy.name).toBe('AbortError')
    expect(copy.message).not.toContain('abcdef0123456789abcdef')
    expect(copy.message).toContain('[REDACTED]')
  })

  it('an ordinary Error keeps its class, as before', () => {
    const copy = maskError(new TypeError('fetch failed'))
    expect(copy).toBeInstanceOf(TypeError)
    expect(copy.message).toBe('fetch failed')
  })
})

describe('the shipped logger with a DOMException as err', () => {
  it('writes the line, with the name and the message, instead of throwing', async () => {
    const lines: string[] = []
    const log = createLogger({ write: (l: string) => { lines.push(l) } })
    const e = await realTimeoutError()
    expect(() => log.warn({ err: e, approvalId: 'a-1', attempt: 1, waitMs: 1000 }, 'approval owner notification attempt failed -- sending again')).not.toThrow()
    expect(lines).toHaveLength(1)
    const line = JSON.parse(lines[0]!) as { msg: string; approvalId: string; err: { name?: string; message?: string } }
    expect(line.msg).toBe('approval owner notification attempt failed -- sending again')
    expect(line.approvalId).toBe('a-1')
    expect(line.err.name).toBe('TimeoutError')
    expect(line.err.message).toBe((e as Error).message)
  })

  it('also when the DOMException is the cause of another error, or sits deeper in the object', async () => {
    const lines: string[] = []
    const log = createLogger({ write: (l: string) => { lines.push(l) } })
    const e = await realTimeoutError()
    const outer = new TypeError('fetch failed', { cause: e })
    expect(() => log.warn({ err: outer }, 'outer')).not.toThrow()
    expect(() => log.warn({ details: { last: e } }, 'nested')).not.toThrow()
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('TimeoutError')
  })
})
