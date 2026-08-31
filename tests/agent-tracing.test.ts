import {
  context,
  SpanStatusCode,
  trace,
} from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import {
  markAgentLoopRequest,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import {
  AGENT_STEP_SPAN_NAME,
  AGENT_TURN_SPAN_NAME,
  LLM_REQUEST_SPAN_NAME,
  OpenTelemetryAgentTracing,
} from '../src/agent-tracing.ts'
import {
  OpenTelemetryToolTracing,
  TOOL_EXECUTION_SPAN_NAME,
} from '../src/otel-tracing.ts'

const toolSuccess = {
  isError: false,
  value: null,
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

function fakeSession(id: string): Session {
  return { id } as unknown as Session
}

let sequence = 0
function sessionEvent(type: string, data: unknown, time: number): SessionEvent {
  sequence += 1
  return { type, data, time, seq: sequence } as SessionEvent
}

function loopRequest(sessionId: string): GenerateOptions {
  return markAgentLoopRequest({
    provider: 'deepseek',
    model: 'deepseek-chat',
    messages: [],
    sessionId: sessionId as GenerateOptions['sessionId'],
  })
}

async function collect(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of source) chunks.push(chunk)
  return chunks
}

describe('OpenTelemetryAgentTracing', () => {
  it('builds turn -> step -> llm/tool parentage from runtime lifecycle seams', async () => {
    const harness = setupTracing()
    try {
      const agentTracing = new OpenTelemetryAgentTracing(harness.tracer)
      const toolTracing = new OpenTelemetryToolTracing(harness.tracer)
      const session = fakeSession('session-1')
      const parent = harness.tracer.startSpan('parent')

      await context.with(trace.setSpan(context.active(), parent), async () => {
        agentTracing.onSessionEvent(session, sessionEvent('turn/start', { turn: 1 }, 1_000))
        agentTracing.onSessionEvent(session, sessionEvent('step/start', { turn: 1, step: 1 }, 1_010))
      })

      await collect(agentTracing.traceLlm(loopRequest('session-1'), () => (async function* () {
        expect(trace.getSpan(context.active())?.spanContext().spanId).toBeDefined()
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()))

      await toolTracing.trace(
        'bash',
        async () => toolSuccess,
        agentTracing.contextForSession('session-1'),
      )

      agentTracing.onSessionEvent(session, sessionEvent('step/end', { turn: 1, step: 1 }, 1_020))
      agentTracing.onSessionEvent(session, sessionEvent('turn/end', {
        turn: 1,
        reason: { kind: 'completed' },
      }, 1_030))
      parent.end()

      await harness.provider.forceFlush()
      const spans = harness.exporter.getFinishedSpans()
      const turn = spans.find((span) => span.name === AGENT_TURN_SPAN_NAME)
      const step = spans.find((span) => span.name === AGENT_STEP_SPAN_NAME)
      const llm = spans.find((span) => span.name === LLM_REQUEST_SPAN_NAME)
      const tool = spans.find((span) => span.name === TOOL_EXECUTION_SPAN_NAME)

      expect(turn?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId)
      expect(step?.parentSpanContext?.spanId).toBe(turn?.spanContext().spanId)
      expect(llm?.parentSpanContext?.spanId).toBe(step?.spanContext().spanId)
      expect(tool?.parentSpanContext?.spanId).toBe(step?.spanContext().spanId)

      expect(turn?.attributes).toMatchObject({ 'agent.turn': 1, outcome: 'completed' })
      expect(step?.attributes).toMatchObject({
        'agent.turn': 1,
        'agent.step': 1,
        outcome: 'completed',
      })
      expect(llm?.attributes).toMatchObject({
        'llm.provider': 'deepseek',
        'llm.model': 'deepseek-chat',
        outcome: 'stop',
      })
    } finally {
      await cleanupTracing(harness)
    }
  })

  it('records structured LLM failure metadata without message or stack content', async () => {
    const harness = setupTracing()
    try {
      const tracing = new OpenTelemetryAgentTracing(harness.tracer)
      const session = fakeSession('session-error')
      tracing.onSessionEvent(session, sessionEvent('turn/start', { turn: 1 }, 2_000))
      tracing.onSessionEvent(session, sessionEvent('step/start', { turn: 1, step: 1 }, 2_010))

      await collect(tracing.traceLlm(loopRequest('session-error'), () => (async function* () {
        yield {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: { message: 'sensitive provider detail', code: 'RATE_LIMIT' },
          },
        }
      })()))
      await harness.provider.forceFlush()

      const span = harness.exporter.getFinishedSpans().find(
        (item) => item.name === LLM_REQUEST_SPAN_NAME,
      )
      expect(span?.status.code).toBe(SpanStatusCode.ERROR)
      expect(span?.attributes).toMatchObject({
        outcome: 'error',
        'error.type': 'RATE_LIMIT',
      })
      expect(span?.events).toEqual([])
      expect(JSON.stringify({
        attributes: span?.attributes,
        status: span?.status,
        events: span?.events,
      })).not.toContain('sensitive provider detail')
    } finally {
      await cleanupTracing(harness)
    }
  })

  it('records terminal turn error classification without exporting its message', async () => {
    const harness = setupTracing()
    try {
      const tracing = new OpenTelemetryAgentTracing(harness.tracer)
      const session = fakeSession('session-turn-error')

      tracing.onSessionEvent(session, sessionEvent('turn/start', { turn: 4 }, 3_000))
      tracing.onSessionEvent(session, sessionEvent('step/start', { turn: 4, step: 1 }, 3_010))
      tracing.onSessionEvent(session, sessionEvent('step/end', { turn: 4, step: 1 }, 3_020))
      tracing.onSessionEvent(session, sessionEvent('turn/end', {
        turn: 4,
        reason: {
          kind: 'error',
          error: { message: 'sensitive auth detail', code: 'AUTH' },
        },
      }, 3_030))
      await harness.provider.forceFlush()

      const turn = harness.exporter.getFinishedSpans().find(
        (span) => span.name === AGENT_TURN_SPAN_NAME,
      )
      expect(turn?.status.code).toBe(SpanStatusCode.ERROR)
      expect(turn?.attributes).toMatchObject({ outcome: 'error', 'error.type': 'AUTH' })
      expect(turn?.events).toEqual([])
      expect(JSON.stringify({
        attributes: turn?.attributes,
        status: turn?.status,
        events: turn?.events,
      })).not.toContain('sensitive auth detail')
    } finally {
      await cleanupTracing(harness)
    }
  })

  it('does not trace auxiliary model calls that were not built by the Agent loop', async () => {
    const harness = setupTracing()
    try {
      const tracing = new OpenTelemetryAgentTracing(harness.tracer)
      const request: GenerateOptions = {
        provider: 'deepseek',
        model: 'deepseek-chat',
        messages: [],
        sessionId: 'session-aux' as GenerateOptions['sessionId'],
      }

      await collect(tracing.traceLlm(request, () => (async function* () {
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()))
      await harness.provider.forceFlush()

      expect(harness.exporter.getFinishedSpans().some(
        (span) => span.name === LLM_REQUEST_SPAN_NAME,
      )).toBe(false)
    } finally {
      await cleanupTracing(harness)
    }
  })

  it('keeps concurrent sessions isolated when parenting tool spans', async () => {
    const harness = setupTracing()
    try {
      const agentTracing = new OpenTelemetryAgentTracing(harness.tracer)
      const toolTracing = new OpenTelemetryToolTracing(harness.tracer)
      const first = fakeSession('session-a')
      const second = fakeSession('session-b')

      agentTracing.onSessionEvent(first, sessionEvent('turn/start', { turn: 1 }, 4_000))
      agentTracing.onSessionEvent(first, sessionEvent('step/start', { turn: 1, step: 1 }, 4_010))
      agentTracing.onSessionEvent(second, sessionEvent('turn/start', { turn: 1 }, 4_000))
      agentTracing.onSessionEvent(second, sessionEvent('step/start', { turn: 1, step: 1 }, 4_010))

      await Promise.all([
        toolTracing.trace('bash', async () => toolSuccess, agentTracing.contextForSession('session-a')),
        toolTracing.trace('bash', async () => toolSuccess, agentTracing.contextForSession('session-b')),
      ])

      agentTracing.onSessionEvent(first, sessionEvent('step/end', { turn: 1, step: 1 }, 4_020))
      agentTracing.onSessionEvent(first, sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4_030))
      agentTracing.onSessionEvent(second, sessionEvent('step/end', { turn: 1, step: 1 }, 4_020))
      agentTracing.onSessionEvent(second, sessionEvent('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4_030))
      await harness.provider.forceFlush()

      const steps = harness.exporter.getFinishedSpans().filter(
        (span) => span.name === AGENT_STEP_SPAN_NAME,
      )
      const tools = harness.exporter.getFinishedSpans().filter(
        (span) => span.name === TOOL_EXECUTION_SPAN_NAME,
      )
      expect(steps).toHaveLength(2)
      expect(tools).toHaveLength(2)
      const stepIds = new Set(steps.map((span) => span.spanContext().spanId))
      expect(stepIds.size).toBe(2)
      expect(tools.every((span) =>
        span.parentSpanContext !== undefined && stepIds.has(span.parentSpanContext.spanId)
      )).toBe(true)
    } finally {
      await cleanupTracing(harness)
    }
  })
})
