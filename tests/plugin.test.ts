import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { ToolExecutionObserver, apply, inject, name } from '../src/index.ts'

function pluginModule() {
  return { name, inject, apply }
}

function hasToolExecuteEffect(fiber: ReturnType<Context['plugin']>): boolean {
  return fiber.getEffects().some((effect) => effect.label.includes('tools/execute'))
}

describe('dsh-runtime-observability plugin lifecycle', () => {
  it('declares tools as a hard dependency', () => {
    expect(inject).toEqual(['tools'])
  })

  it('waits for tools, exposes its service, and releases owned effects on dispose', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(pluginModule())

    await fiber.await()
    expect(hasToolExecuteEffect(fiber)).toBe(false)
    expect(ctx.get('dshRuntimeObservability')).toBeUndefined()

    const disposeTools = ctx.provide('tools', {} as Context['tools'])
    await fiber.await()

    expect(hasToolExecuteEffect(fiber)).toBe(true)
    expect(ctx.get('dshRuntimeObservability')).toBeInstanceOf(ToolExecutionObserver)

    await fiber.dispose()

    expect(fiber.uid).toBeNull()
    expect(fiber.getEffects()).toEqual([])
    expect(ctx.get('dshRuntimeObservability')).toBeUndefined()

    await disposeTools()
  })
})
