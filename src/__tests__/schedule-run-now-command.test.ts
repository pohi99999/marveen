import { beforeEach, describe, expect, it, vi } from 'vitest'

// A manual run ("Run now", POST /api/schedules/<name>/run) of a type='command'
// task must run the shell command itself, exactly like the cron tick does
// (runCommandTask). Measured 2026-10-22 18:38 on the Mac: run-now of
// p-szakrajz-engine-ping went through attemptFireTask instead, the main
// session was busy, a pending retry was queued, and at 18:40 the raw shell
// command was typed into the main agent's session as a PROMPT -- a model turn
// for a task that is defined as "no LLM, no tmux".
//
// Same probe as schedule-run-now-direct.test.ts: attemptFireTask's first
// observable step is the restart-lock check, stubbed to "restart in flight" so
// it returns 'busy' before touching tmux; the tmux layer throws if reached.

const h = vi.hoisted(() => ({
  tasks: [] as unknown[],
  runCommand: vi.fn(),
  restartProbe: vi.fn(() => true),
  insertRetry: vi.fn(),
}))

vi.mock('../web/scheduled-tasks-io.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/scheduled-tasks-io.js')>()),
  listScheduledTasks: () => h.tasks,
  readScheduledTask: (n: string) => (h.tasks as Array<{ name: string }>).find(t => t.name === n) ?? null,
}))

vi.mock('../web/command-task.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/command-task.js')>()),
  runCommandTask: h.runCommand,
}))

vi.mock('../web/restart-lock.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../web/restart-lock.js')>()),
  isRestartInFlight: h.restartProbe,
}))

vi.mock('../web/agent-process.js', async (importOriginal) => {
  const unreachable = (fn: string) => () => {
    throw new Error(`schedule-run-now-command: ${fn} must not be reached from this test`)
  }
  return {
    ...(await importOriginal<typeof import('../web/agent-process.js')>()),
    sessionExistsOnHost: unreachable('sessionExistsOnHost'),
    startAgentProcess: unreachable('startAgentProcess'),
    sendPromptToSession: unreachable('sendPromptToSession'),
    isSessionReadyForPrompt: unreachable('isSessionReadyForPrompt'),
    capturePane: unreachable('capturePane'),
  }
})

vi.mock('../db.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db.js')>()),
  insertPendingTaskRetryIfNew: h.insertRetry,
}))

const { runScheduledTaskNow } = await import('../web/schedule-runner.js')

const commandTask = {
  name: 'engine-ping',
  agent: 'marveen',
  schedule: '5,15,25,35,45,55 * * * *',
  enabled: true,
  type: 'command',
  command: 'true',
}

describe('runScheduledTaskNow: a command task runs its command, never the session dispatch', () => {
  beforeEach(() => {
    h.runCommand.mockReset()
    h.restartProbe.mockClear()
    h.insertRetry.mockReset()
    h.tasks = [commandTask]
  })

  it('runs the command once and queues no retry', async () => {
    const res = await runScheduledTaskNow('engine-ping')
    expect(res).toEqual({ ok: true, result: 'marveen: command-started' })
    expect(h.runCommand).toHaveBeenCalledTimes(1)
    expect(h.runCommand.mock.calls[0][0]).toMatchObject({ name: 'engine-ping', type: 'command' })
    expect(h.restartProbe).not.toHaveBeenCalled()
    expect(h.insertRetry).not.toHaveBeenCalled()
  })

  it('control: a prompt task with the same target does go through the dispatch', async () => {
    // Without this the probe could be dead and the test above would pass for
    // the wrong reason.
    h.tasks = [{ ...commandTask, type: 'task', prompt: 'hello' }]
    const res = await runScheduledTaskNow('engine-ping')
    expect(h.runCommand).not.toHaveBeenCalled()
    expect(h.restartProbe).toHaveBeenCalledWith('marveen')
    expect(res).toEqual({ ok: true, result: 'marveen: busy' })
    expect(h.insertRetry).toHaveBeenCalledTimes(1)
  })
})
