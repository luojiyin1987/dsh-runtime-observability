import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { OpenTelemetryAgentTracing } from './agent-tracing.ts'
import { OpenTelemetryToolMetrics } from './otel-metrics.ts'
import { OpenTelemetryToolTracing } from './otel-tracing.ts'
import { ToolExecutionObserver } from './tool-observer.ts'

export {
  AGENT_STEP_SPAN_NAME,
  AGENT_TURN_SPAN_NAME,
  LLM_REQUEST_SPAN_NAME,
  OpenTelemetryAgentTracing,
} from './agent-tracing.ts'
export { OpenTelemetryToolMetrics, OTEL_METER_NAME } from './otel-metrics.ts'
export {
  OpenTelemetryToolTracing,
  OTEL_TRACER_NAME,
  TOOL_EXECUTION_SPAN_NAME,
} from './otel-tracing.ts'
export { ToolExecutionObserver } from './tool-observer.ts'
export type {
  RuntimeObservabilitySnapshot,
  ToolExecutionCompleted,
  ToolExecutionLifecycleSink,
  ToolExecutionStarted,
  ToolExecutionStats,
} from './tool-observer.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    dshRuntimeObservability: ToolExecutionObserver
  }
}

export const name = 'dsh-runtime-observability'
export const inject = ['tools', 'sessions', 'llm']

/**
 * Instrument DeepSeek Harness tool and Agent Runtime lifecycle seams and
 * project metadata-only execution data into OpenTelemetry Metrics and Traces.
 */
export function apply(ctx: Context): void {
  const observer = new ToolExecutionObserver()
  const otelMetrics = new OpenTelemetryToolMetrics()
  const toolTracing = new OpenTelemetryToolTracing()
  const agentTracing = new OpenTelemetryAgentTracing()

  ctx.provide('dshRuntimeObservability', observer)
  ctx.effect(
    () => observer.addSink(otelMetrics),
    'dsh-runtime-observability:otel-metrics',
  )

  ctx.on('session/event', (session, event) => {
    agentTracing.onSessionEvent(session, event)
  })
  ctx.on('session/disposed', (session) => {
    agentTracing.disposeSession(session)
  })
  ctx.on('llm/stream', (options, next) => agentTracing.traceLlm(options, next))

  ctx.on(
    'tools/execute',
    (exec, next): Promise<ToolExecutionResult> => {
      const parent = exec.agent === undefined
        ? undefined
        : agentTracing.contextForSession(exec.agent.session.id)
      return toolTracing.trace(
        exec.name,
        () => observer.observe(exec.name, next),
        parent,
      )
    },
  )
}
