import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { OpenTelemetryToolMetrics } from './otel-metrics.ts'
import { ToolExecutionObserver } from './tool-observer.ts'

export { OpenTelemetryToolMetrics, OTEL_METER_NAME } from './otel-metrics.ts'
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
 * project its metadata-only lifecycle into OpenTelemetry Metrics.
 */
export function apply(ctx: Context): void {
  const observer = new ToolExecutionObserver()
  const otelMetrics = new OpenTelemetryToolMetrics()

  ctx.provide('dshRuntimeObservability', observer)
  ctx.effect(
    () => observer.addSink(otelMetrics),
    'dsh-runtime-observability:otel-metrics',
  )

  ctx.on(
    'tools/execute',
    (exec, next): Promise<ToolExecutionResult> => observer.observe(exec.name, next),
  )
}
