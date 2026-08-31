import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ToolExecutionObserver, apply, inject, name } from '../src/index.ts'

function pluginModule() {
  return { name, inject, apply }
}

function hasEffect(
  fiber: ReturnType<Context['plugin']>,
  label: string,
): boolean {
  return fiber.getEffects().some((effect) => effect.label.includes(label))
}

describe('dsh-runtime-observability plugin lifecycle', () => {
  it('declares tool, session, and llm runtime dependencies', () => {
    expect(inject).toEqual(['tools', 'sessions', 'llm'])
  })

  it('waits for every dependency and releases all owned effects on dispose', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(pluginModule())

    await fiber.await()
    expect(hasEffect(fiber, 'tools/execute')).toBe(false)
    expect(ctx.get('dshRuntimeObservability')).toBeUndefined()

    const disposeTools = ctx.provide('tools', {} as Context['tools'])
    await fiber.await()
    expect(ctx.get('dshRuntimeObservability')).toBeUndefined()

    const disposeSessions = ctx.provide('sessions', {} as Context['sessions'])
    await fiber.await()
    expect(ctx.get('dshRuntimeObservability')).toBeUndefined()

    const disposeLlm = ctx.provide('llm', {} as Context['llm'])
    await fiber.await()

    expect(hasEffect(fiber, 'tools/execute')).toBe(true)
    expect(hasEffect(fiber, 'session/event')).toBe(true)
    expect(hasEffect(fiber, 'llm/stream')).toBe(true)
    expect(ctx.get('dshRuntimeObservability')).toBeInstanceOf(ToolExecutionObserver)

    await fiber.dispose()

    expect(fiber.uid).toBeNull()
    expect(fiber.getEffects()).toEqual([])
    expect(ctx.get('dshRuntimeObservability')).toBeUndefined()

    await disposeLlm()
    await disposeSessions()
    await disposeTools()
  })
})
