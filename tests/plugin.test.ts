import { Context, FiberState } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject, name } from '../src/index.ts'

function pluginModule() {
  return { name, inject, apply }
}

describe('dsh-runtime-observability plugin lifecycle', () => {
  it('declares tools as a hard dependency', () => {
    expect(inject).toEqual(['tools'])
  })

  it('waits for tools, activates, and releases listener effects on dispose', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin(pluginModule())

    await fiber.await()
    expect(fiber.state).toBe(FiberState.PENDING)

    const disposeTools = ctx.provide('tools', {} as Context['tools'])
    await fiber.await()

    expect(fiber.state).toBe(FiberState.ACTIVE)
    expect(
      fiber.getEffects().some((effect) => effect.label.includes('tools/result')),
    ).toBe(true)

    await fiber.dispose()

    expect(fiber.state).toBe(FiberState.DISPOSED)
    expect(fiber.getEffects()).toEqual([])

    await disposeTools()
  })
})
