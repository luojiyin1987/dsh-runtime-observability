import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { OpenTelemetryToolMetrics } from './otel-metrics.ts'
import { OpenTelemetryToolTracing } from './otel-tracing.ts'
import { ToolExecutionObserver } from './tool-observer.ts'

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
export const inject = ['tools']

/**
 * Instrument the DeepSeek Harness `tools/execute` around-dispatch seam and
 * project metadata-only execution data into OpenTelemetry Metrics and Traces.
 */
export function apply(ctx: Context): void {
  const observer = new ToolExecutionObserver()
  const otelMetrics = new OpenTelemetryToolMetrics()
  const otelTracing = new OpenTelemetryToolTracing()

  ctx.provide('dshRuntimeObservability', observer)
  ctx.effect(
    () => observer.addSink(otelMetrics),
    'dsh-runtime-observability:otel-metrics',
  )

  ctx.on(
    'tools/execute',
    (exec, next): Promise<ToolExecutionResult> =>
      otelTracing.trace(exec.name, () => observer.observe(exec.name, next)),
  )
}
