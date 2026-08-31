import { context, metrics, trace } from '@opentelemetry/api'
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, {
  createUserMessage,
  LlmAdapter,
  ToolCallId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import {
  AGENT_STEP_SPAN_NAME,
  AGENT_TURN_SPAN_NAME,
  LLM_REQUEST_SPAN_NAME,
  TOOL_EXECUTION_SPAN_NAME,
  apply,
  inject,
  name,
} from '../src/index.ts'

const SERVICE_NAME = 'dsh-runtime-observability-e2e'
const SESSION_ID = 'observability-e2e-session'
const USER_PROMPT = 'run the deterministic echo tool'
const PRIVATE_PAYLOAD = 'private-e2e-payload'

const OTLP_HTTP_BASE = process.env['DSH_OTEL_E2E_OTLP_HTTP'] ?? 'http://127.0.0.1:4318'
const JAEGER_QUERY_BASE = process.env['DSH_OTEL_E2E_JAEGER'] ?? 'http://127.0.0.1:16686'
const PROMETHEUS_BASE = process.env['DSH_OTEL_E2E_PROMETHEUS'] ?? 'http://127.0.0.1:9090'

function pluginModule() {
  return { name, inject, apply }
}

/**
 * Some developer-preview agent-loop builds read `ctx.sessionProjections` but
 * shipped stale Cordis inject metadata that omitted the capability. Keep the
 * E2E on public packages while making that known alpha skew explicit. Once the
 * published metadata includes the dependency, this returns AgentLoop unchanged.
 */
function compatibleAgentLoop() {
  const declared = AgentLoop.inject
  if (declared.includes('sessionProjections')) return AgentLoop

  return class AgentLoopWithSessionProjection extends AgentLoop {
    static override inject = [...declared, 'sessionProjections']
  }
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

class DeterministicAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  private call = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const call = this.call++

    if (call === 0) {
      const id = ToolCallId('e2e-tool-call')
      const argumentsJson = JSON.stringify({ text: PRIVATE_PAYLOAD })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield {
        type: 'tool-call-delta',
        index: 0,
        id,
        name: 'echo',
        argumentsDelta: argumentsJson,
      }
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'tool-call', id, name: 'echo', arguments: argumentsJson },
      }
      yield { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }

    if (call === 1) {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'done' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
      yield { type: 'usage', usage: { inputTokens: 12, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }

    throw new Error('DeterministicAdapter: unexpected extra model request')
  }
}

function setupOpenTelemetry() {
  context.disable()
  trace.disable()
  metrics.disable()

  const contextManager = new AsyncLocalStorageContextManager().enable()
  context.setGlobalContextManager(contextManager)

  const resource = resourceFromAttributes({ 'service.name': SERVICE_NAME })
  const traceProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [new SimpleSpanProcessor(new OTLPTraceExporter({
      url: `${OTLP_HTTP_BASE}/v1/traces`,
    }))],
  })
  trace.setGlobalTracerProvider(traceProvider)

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({ url: `${OTLP_HTTP_BASE}/v1/metrics` }),
    exportIntervalMillis: 60_000,
  })
  const meterProvider = new MeterProvider({ resource, readers: [metricReader] })
  metrics.setGlobalMeterProvider(meterProvider)

  return { contextManager, meterProvider, traceProvider }
}

async function mountHarness(adapter: DeterministicAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(pluginModule())

  expect(ctx.get('sessionProjections')).toBeDefined()
  await ctx.plugin(compatibleAgentLoop(), { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

interface JaegerSpan {
  operationName: string
  traceID: string
}

interface JaegerTrace {
  traceID: string
  spans: JaegerSpan[]
}

interface JaegerResponse {
  data?: JaegerTrace[]
}

interface PrometheusSeries {
  metric: Record<string, string>
  value: [number, string]
}

interface PrometheusResponse {
  status: string
  data?: { result?: PrometheusSeries[] }
}

async function fetchJson<T>(url: string): Promise<T | undefined> {
  try {
    const response = await fetch(url)
    if (!response.ok) return undefined
    return await response.json() as T
  } catch {
    return undefined
  }
}

async function poll<T>(read: () => Promise<T | undefined>, accept: (value: T) => boolean): Promise<T> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const value = await read()
    if (value !== undefined && accept(value)) return value
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('timed out waiting for exported observability data')
}

function findRuntimeTrace(response: JaegerResponse): JaegerTrace | undefined {
  return response.data?.find((candidate) => {
    const names = candidate.spans.map(span => span.operationName)
    return names.includes(AGENT_TURN_SPAN_NAME)
      && names.includes(AGENT_STEP_SPAN_NAME)
      && names.includes(LLM_REQUEST_SPAN_NAME)
      && names.includes(TOOL_EXECUTION_SPAN_NAME)
  })
}

describe('real DeepSeek Harness runtime observability', () => {
  it('exports one tool round-trip through Collector into Jaeger and Prometheus', async () => {
    const otel = setupOpenTelemetry()

    try {
      const adapter = new DeterministicAdapter()
      const ctx = await mountHarness(adapter)
      const executed: string[] = []

      ctx.tools.register(defineContentToolFixture({
        name: 'echo',
        description: 'deterministic e2e echo',
        parameters: { text: { type: 'string' } },
        async execute(args) {
          executed.push(String(args.text))
          return [{ type: 'text', text: `echo: ${String(args.text)}` }]
        },
      }))

      const agent = ctx.agentLoop.create(
        SessionId(SESSION_ID),
        { provider: 'mock', model: 'mock' },
      )
      const idle = waitForIdle(ctx, agent)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: USER_PROMPT }],
        source: { kind: 'user' },
      }))
      await idle

      expect(adapter.requests).toHaveLength(2)
      expect(executed).toEqual([PRIVATE_PAYLOAD])
      expect(agent.session.events.some(event => event.type === 'tool/call')).toBe(true)
      expect(agent.session.events.some(event => event.type === 'tool/result')).toBe(true)
      expect(ctx.dshRuntimeObservability.snapshot()).toMatchObject({
        active: 0,
        calls: 1,
        errors: 0,
        tools: {
          echo: { active: 0, calls: 1, errors: 0 },
        },
      })

      await otel.traceProvider.forceFlush()
      await otel.meterProvider.forceFlush()

      const jaeger = await poll(
        () => fetchJson<JaegerResponse>(
          `${JAEGER_QUERY_BASE}/api/traces?service=${encodeURIComponent(SERVICE_NAME)}&limit=20`,
        ),
        response => findRuntimeTrace(response) !== undefined,
      )
      const runtimeTrace = findRuntimeTrace(jaeger)
      expect(runtimeTrace).toBeDefined()

      const operationNames = runtimeTrace!.spans.map(span => span.operationName)
      expect(operationNames.filter(name => name === AGENT_TURN_SPAN_NAME)).toHaveLength(1)
      expect(operationNames.filter(name => name === AGENT_STEP_SPAN_NAME)).toHaveLength(1)
      expect(operationNames.filter(name => name === LLM_REQUEST_SPAN_NAME)).toHaveLength(2)
      expect(operationNames.filter(name => name === TOOL_EXECUTION_SPAN_NAME)).toHaveLength(1)
      expect(new Set(runtimeTrace!.spans.map(span => span.traceID))).toEqual(new Set([runtimeTrace!.traceID]))

      const query = encodeURIComponent('{__name__=~"dsh_tool_.*"}')
      const prometheus = await poll(
        () => fetchJson<PrometheusResponse>(`${PROMETHEUS_BASE}/api/v1/query?query=${query}`),
        response => response.status === 'success'
          && (response.data?.result ?? []).some(series =>
            series.metric['__name__']?.includes('calls') === true
            && Object.values(series.metric).includes('echo')
            && Number(series.value[1]) >= 1
          ),
      )
      expect(prometheus.status).toBe('success')

      const exported = JSON.stringify({ jaeger: runtimeTrace, prometheus: prometheus.data?.result })
      expect(exported).not.toContain(USER_PROMPT)
      expect(exported).not.toContain(PRIVATE_PAYLOAD)
      expect(exported).not.toContain(`echo: ${PRIVATE_PAYLOAD}`)
      expect(exported).not.toContain(SESSION_ID)
    } finally {
      await otel.traceProvider.shutdown()
      await otel.meterProvider.shutdown()
      otel.contextManager.disable()
      context.disable()
      trace.disable()
      metrics.disable()
    }
  }, 30_000)
})
