import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { ToolExecutionObserver } from '../src/tool-observer.ts'

const success = {
  isError: false,
  value: null,
  content: [],
} satisfies ToolExecutionResult

const failure = {
  isError: true,
  error: { message: 'failed' },
  content: [],
} satisfies ToolExecutionResult

describe('ToolExecutionObserver', () => {
  it('tracks active calls and duration without changing the returned result', async () => {
    let now = 100
    const observer = new ToolExecutionObserver(() => now)
    const gate = Promise.withResolvers<ToolExecutionResult>()

    const pending = observer.observe('bash', () => gate.promise)

    expect(observer.snapshot()).toEqual({
      active: 1,
      calls: 0,
      errors: 0,
      durationMs: 0,
      tools: {
        bash: { active: 1, calls: 0, errors: 0, durationMs: 0 },
      },
    })

    now = 125
    gate.resolve(success)

    await expect(pending).resolves.toBe(success)
    expect(observer.snapshot()).toEqual({
      active: 0,
      calls: 1,
      errors: 0,
      durationMs: 25,
      tools: {
        bash: { active: 0, calls: 1, errors: 0, durationMs: 25 },
      },
    })
  })

  it('counts normalized tool failures', async () => {
    let now = 10
    const observer = new ToolExecutionObserver(() => now)

    const result = observer.observe('web_search', async () => {
      now = 42
      return failure
    })

    await expect(result).resolves.toBe(failure)
    expect(observer.snapshot()).toEqual({
      active: 0,
      calls: 1,
      errors: 1,
      durationMs: 32,
      tools: {
        web_search: { active: 0, calls: 1, errors: 1, durationMs: 32 },
      },
    })
  })

  it('restores active gauges and rethrows downstream wrapper exceptions', async () => {
    let now = 3
    const observer = new ToolExecutionObserver(() => now)
    const error = new Error('sensitive downstream message')

    const result = observer.observe('fs_read', async () => {
      now = 11
      throw error
    })

    await expect(result).rejects.toBe(error)

    const snapshot = observer.snapshot()
    expect(snapshot).toEqual({
      active: 0,
      calls: 1,
      errors: 1,
      durationMs: 8,
      tools: {
        fs_read: { active: 0, calls: 1, errors: 1, durationMs: 8 },
      },
    })
    expect(JSON.stringify(snapshot)).not.toContain(error.message)
  })

  it('tracks overlapping calls independently', async () => {
    let now = 0
    const observer = new ToolExecutionObserver(() => now)
    const first = Promise.withResolvers<ToolExecutionResult>()
    const second = Promise.withResolvers<ToolExecutionResult>()

    const firstRun = observer.observe('bash', () => first.promise)
    now = 5
    const secondRun = observer.observe('bash', () => second.promise)

    expect(observer.snapshot().tools.bash?.active).toBe(2)

    now = 15
    first.resolve(success)
    await firstRun
    expect(observer.snapshot().tools.bash?.active).toBe(1)

    now = 25
    second.resolve(success)
    await secondRun

    expect(observer.snapshot()).toEqual({
      active: 0,
      calls: 2,
      errors: 0,
      durationMs: 35,
      tools: {
        bash: { active: 0, calls: 2, errors: 0, durationMs: 35 },
      },
    })
  })

  it('emits metadata-only lifecycle events with the measured duration', async () => {
    let now = 7
    const observer = new ToolExecutionObserver(() => now)
    const events: unknown[] = []

    observer.addSink({
      onStart(event) {
        events.push(event)
      },
      onComplete(event) {
        events.push(event)
      },
    })

    await observer.observe('bash', async () => {
      now = 19
      return failure
    })

    expect(events).toEqual([
      { toolName: 'bash' },
      { toolName: 'bash', durationMs: 12, isError: true },
    ])
  })

  it('contains lifecycle sink failures so telemetry cannot fail a tool call', async () => {
    const observer = new ToolExecutionObserver(() => 1)
    observer.addSink({
      onStart() {
        throw new Error('exporter unavailable')
      },
      onComplete() {
        throw new Error('must not be reached after rejected start')
      },
    })

    await expect(observer.observe('bash', async () => success)).resolves.toBe(success)
    expect(observer.snapshot().calls).toBe(1)
  })
})
