import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context as OtelContext,
  type Span,
  type Tracer,
} from '@opentelemetry/api'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'

export const OTEL_TRACER_NAME = 'dsh-runtime-observability'
export const TOOL_EXECUTION_SPAN_NAME = 'dsh.tool.execute'

const TOOL_NAME_ATTRIBUTE = 'tool.name'
const OUTCOME_ATTRIBUTE = 'outcome'
const ERROR_TYPE_ATTRIBUTE = 'error.type'

function safely(action: () => void): void {
  try {
    action()
  } catch {
    // Telemetry must never change tool execution semantics.
  }
}

function structuredErrorType(result: ToolExecutionResult): string | undefined {
  if (!result.isError) return undefined

  const info = result.error.info
  if (info?.code !== undefined) return String(info.code)
  if (info?.name !== undefined) return info.name
  return undefined
}

/**
 * OpenTelemetry tracing projection for one DeepSeek Harness tool dispatch.
 *
 * The tracer is host-owned: this class does not install a TracerProvider,
 * context manager, processor, exporter, or OTLP endpoint. Without a configured
 * provider the OpenTelemetry API simply produces no-op spans.
 */
export class OpenTelemetryToolTracing {
  constructor(private readonly tracer: Tracer = trace.getTracer(OTEL_TRACER_NAME)) {}

  async trace(
    toolName: string,
    next: () => Promise<ToolExecutionResult>,
  ): Promise<ToolExecutionResult> {
    let span: Span | undefined
    let spanContext: OtelContext

    try {
      span = this.tracer.startSpan(
        TOOL_EXECUTION_SPAN_NAME,
        {
          kind: SpanKind.INTERNAL,
          attributes: { [TOOL_NAME_ATTRIBUTE]: toolName },
        },
        context.active(),
      )
      spanContext = trace.setSpan(context.active(), span)
    } catch {
      // Instrumentation failed before application work started. Ending a span
      // is best-effort, then the tool runs exactly once without tracing.
      if (span !== undefined) safely(() => span?.end())
      return next()
    }

    let nextStarted = false

    try {
      const result = await context.with(spanContext, () => {
        nextStarted = true
        return next()
      })

      const outcome = result.isError ? 'error' : 'success'
      safely(() => span?.setAttribute(OUTCOME_ATTRIBUTE, outcome))

      if (result.isError) {
        safely(() => span?.setStatus({ code: SpanStatusCode.ERROR }))
        const errorType = structuredErrorType(result)
        if (errorType !== undefined) {
          safely(() => span?.setAttribute(ERROR_TYPE_ATTRIBUTE, errorType))
        }
      }

      return result
    } catch (error) {
      if (!nextStarted) {
        // A context-manager failure happened before `next()` was entered. Only
        // this path is safe to fall back: the tool has not executed yet.
        safely(() => span?.end())
        return next()
      }

      safely(() => span?.setAttribute(OUTCOME_ATTRIBUTE, 'error'))
      safely(() => span?.setStatus({ code: SpanStatusCode.ERROR }))
      // Deliberately do not recordException(error): exception events may export
      // sensitive messages and stacks outside the metadata-only boundary.
      throw error
    } finally {
      if (nextStarted) safely(() => span?.end())
    }
  }
}
