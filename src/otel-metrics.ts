import {
  metrics,
  type Counter,
  type Histogram,
  type Meter,
  type UpDownCounter,
} from '@opentelemetry/api'
import type {
  ToolExecutionCompleted,
  ToolExecutionLifecycleSink,
  ToolExecutionStarted,
} from './tool-observer.ts'

export const OTEL_METER_NAME = 'dsh-runtime-observability'

const TOOL_NAME_ATTRIBUTE = 'tool.name'
const OUTCOME_ATTRIBUTE = 'outcome'

/**
 * OpenTelemetry Metrics projection for tool lifecycle metadata.
 *
 * The class owns instruments only; it does not create or replace a global
 * MeterProvider, exporter, Collector endpoint, or process-wide OTel config.
 */
export class OpenTelemetryToolMetrics implements ToolExecutionLifecycleSink {
  private readonly active: UpDownCounter
  private readonly calls: Counter
  private readonly errors: Counter
  private readonly duration: Histogram

  constructor(meter: Meter = metrics.getMeter(OTEL_METER_NAME)) {
    this.active = meter.createUpDownCounter('dsh.tool.active', {
      description: 'Currently active DeepSeek Harness tool executions',
      unit: '{call}',
    })
    this.calls = meter.createCounter('dsh.tool.calls', {
      description: 'Completed DeepSeek Harness tool executions',
      unit: '{call}',
    })
    this.errors = meter.createCounter('dsh.tool.errors', {
      description: 'Failed DeepSeek Harness tool executions',
      unit: '{call}',
    })
    this.duration = meter.createHistogram('dsh.tool.duration', {
      description: 'DeepSeek Harness tool execution duration',
      unit: 'ms',
    })
  }

  onStart(event: ToolExecutionStarted): void {
    this.active.add(1, { [TOOL_NAME_ATTRIBUTE]: event.toolName })
  }

  onComplete(event: ToolExecutionCompleted): void {
    const outcome = event.isError ? 'error' : 'success'
    const attributes = {
      [TOOL_NAME_ATTRIBUTE]: event.toolName,
      [OUTCOME_ATTRIBUTE]: outcome,
    }

    this.active.add(-1, { [TOOL_NAME_ATTRIBUTE]: event.toolName })
    this.calls.add(1, attributes)
    this.duration.record(event.durationMs, attributes)

    if (event.isError) {
      this.errors.add(1, { [TOOL_NAME_ATTRIBUTE]: event.toolName })
    }
  }
}
