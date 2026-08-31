import {
  context,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import {
  OpenTelemetryToolTracing,
  TOOL_EXECUTION_SPAN_NAME,
} from '../src/otel-tracing.ts'

const success = {
  isError: false,
  value: null,
  content: [],
} satisfies ToolExecutionResult

const failure = {
  isError: true,
  error: {
    message: 'sensitive timeout detail',
    info: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
  },
  content: [],
} satisfies ToolExecutionResult

function setupTracing() {
  context.disable()
  const contextManager = new AsyncLocalStorageContextManager().enable()
  context.setGlobalContextManager(contextManager)

  const exporter = new InMemorySpanExporter()
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  })
  const tracer = provider.getTracer('dsh-runtime-observability-test')

  return { contextManager, exporter, provider, tracer }
}

async function cleanupTracing(harness: ReturnType<typeof setupTracing>): Promise<void> {
  await harness.provider.shutdown()
  harness.contextManager.disable()
  context.disable()
}

describe('OpenTelemetryToolTracing', () => {
  it('inherits the active parent and propagates the tool span to nested work', async () => {
    const harness = setupTracing()
    try {
      const tracing = new OpenTelemetryToolTracing(harness.tracer)
      const parent = harness.tracer.startSpan('parent')

      await context.with(trace.setSpan(context.active(), parent), async () => {
        await tracing.trace('bash', async () => {
          const activeToolSpan = trace.getSpan(context.active())
          expect(activeToolSpan).toBeDefined()

          const nested = harness.tracer.startSpan('nested')
          nested.end()
          return success
        })
      })
      parent.end()
      await harness.provider.forceFlush()

      const spans = harness.exporter.getFinishedSpans()
      const toolSpan = spans.find((span) => span.name === TOOL_EXECUTION_SPAN_NAME)
      const nestedSpan = spans.find((span) => span.name === 'nested')

      expect(toolSpan?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
      expect(nestedSpan?.parentSpanContext?.spanId).toBe(toolSpan?.spanContext().spanId)
      expect(toolSpan?.attributes).toMatchObject({
        'tool.name': 'bash',
        outcome: 'success',
      })
    } finally {
      await cleanupTracing(harness)
    }
  })

  it('marks normalized DSH failures without exporting error messages or stacks', async () => {
    const harness = setupTracing()
    try {
      const tracing = new OpenTelemetryToolTracing(harness.tracer)

      await expect(tracing.trace('web_search', async () => failure)).resolves.toBe(failure)
      await harness.provider.forceFlush()

      const span = harness.exporter.getFinishedSpans().find(
        (item) => item.name === TOOL_EXECUTION_SPAN_NAME,
      )

      expect(span?.status.code).toBe(SpanStatusCode.ERROR)
      expect(span?.attributes).toMatchObject({
        'tool.name': 'web_search',
        outcome: 'error',
        'error.type': 'TOOL_TIMEOUT',
      })
      expect(span?.events).toEqual([])
      expect(JSON.stringify(span)).not.toContain('sensitive timeout detail')
    } finally {
      await cleanupTracing(harness)
    }
  })

  it('preserves thrown wrapper errors and executes the tool exactly once', async () => {
    const harness = setupTracing()
    try {
      const tracing = new OpenTelemetryToolTracing(harness.tracer)
      const error = new Error('sensitive downstream failure')
      let calls = 0

      const result = tracing.trace('fs_read', async () => {
        calls += 1
        throw error
      })

      await expect(result).rejects.toBe(error)
      expect(calls).toBe(1)
      await harness.provider.forceFlush()

      const span = harness.exporter.getFinishedSpans().find(
        (item) => item.name === TOOL_EXECUTION_SPAN_NAME,
      )
      expect(span?.status.code).toBe(SpanStatusCode.ERROR)
      expect(span?.attributes).toMatchObject({
        'tool.name': 'fs_read',
        outcome: 'error',
      })
      expect(span?.events).toEqual([])
      expect(JSON.stringify(span)).not.toContain(error.message)
    } finally {
      await cleanupTracing(harness)
    }
  })

  it('keeps concurrent tool executions in distinct active spans', async () => {
    const harness = setupTracing()
    try {
      const tracing = new OpenTelemetryToolTracing(harness.tracer)
      const firstGate = Promise.withResolvers<void>()
      const secondGate = Promise.withResolvers<void>()
      const activeSpanIds: string[] = []

      const first = tracing.trace('bash', async () => {
        const span = trace.getSpan(context.active())
        if (span !== undefined) activeSpanIds.push(span.spanContext().spanId)
        await firstGate.promise
        return success
      })

      const second = tracing.trace('bash', async () => {
        const span = trace.getSpan(context.active())
        if (span !== undefined) activeSpanIds.push(span.spanContext().spanId)
        await secondGate.promise
        return success
      })

      expect(activeSpanIds).toHaveLength(2)
      expect(activeSpanIds[0]).not.toBe(activeSpanIds[1])

      firstGate.resolve()
      secondGate.resolve()
      await Promise.all([first, second])
      await harness.provider.forceFlush()

      const toolSpans = harness.exporter
        .getFinishedSpans()
        .filter((span) => span.name === TOOL_EXECUTION_SPAN_NAME)
      expect(toolSpans).toHaveLength(2)
    } finally {
      await cleanupTracing(harness)
    }
  })

  it('falls back before next starts when tracer setup fails', async () => {
    const brokenTracer = {
      startSpan() {
        throw new Error('tracer unavailable')
      },
    } as unknown as Tracer
    const tracing = new OpenTelemetryToolTracing(brokenTracer)
    let calls = 0

    const result = await tracing.trace('bash', async () => {
      calls += 1
      return success
    })

    expect(result).toBe(success)
    expect(calls).toBe(1)
  })
})
