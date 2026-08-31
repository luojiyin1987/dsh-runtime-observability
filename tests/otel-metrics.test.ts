import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics'
import { describe, expect, it } from 'vitest'
import { OpenTelemetryToolMetrics } from '../src/otel-metrics.ts'
import { ToolExecutionObserver } from '../src/tool-observer.ts'

const success = {
  isError: false,
  value: null,
  content: [],
} satisfies ToolExecutionResult

const failure = {
  isError: true,
  error: { message: 'failed' },
  content: [],
} satisfies ToolExecutionResult

function metricByName(exporter: InMemoryMetricExporter, name: string) {
  return exporter
    .getMetrics()
    .flatMap((resource) => resource.scopeMetrics)
    .flatMap((scope) => scope.metrics)
    .find((metric) => metric.descriptor.name === name)
}

describe('OpenTelemetryToolMetrics', () => {
  it('exports active, calls, errors, and per-call duration without payload data', async () => {
    const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
    const reader = new PeriodicExportingMetricReader({
      exporter,
      exportIntervalMillis: 60_000,
    })
    const provider = new MeterProvider({ readers: [reader] })

    try {
      const sink = new OpenTelemetryToolMetrics(
        provider.getMeter('dsh-runtime-observability-test'),
      )
      let now = 0
      const observer = new ToolExecutionObserver(() => now)
      observer.addSink(sink)

      await observer.observe('bash', async () => {
        now = 12
        return success
      })
      await observer.observe('bash', async () => {
        now = 20
        return failure
      })

      await provider.forceFlush()

      const active = metricByName(exporter, 'dsh.tool.active')
      const calls = metricByName(exporter, 'dsh.tool.calls')
      const errors = metricByName(exporter, 'dsh.tool.errors')
      const duration = metricByName(exporter, 'dsh.tool.duration')

      expect(active?.dataPoints).toEqual([
        expect.objectContaining({
          attributes: { 'tool.name': 'bash' },
          value: 0,
        }),
      ])

      expect(calls?.dataPoints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attributes: { 'tool.name': 'bash', outcome: 'success' },
            value: 1,
          }),
          expect.objectContaining({
            attributes: { 'tool.name': 'bash', outcome: 'error' },
            value: 1,
          }),
        ]),
      )

      expect(errors?.dataPoints).toEqual([
        expect.objectContaining({
          attributes: { 'tool.name': 'bash' },
          value: 1,
        }),
      ])

      expect(duration?.dataPoints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            attributes: { 'tool.name': 'bash', outcome: 'success' },
            value: expect.objectContaining({ count: 1, sum: 12 }),
          }),
          expect.objectContaining({
            attributes: { 'tool.name': 'bash', outcome: 'error' },
            value: expect.objectContaining({ count: 1, sum: 8 }),
          }),
        ]),
      )

      const serialized = JSON.stringify(exporter.getMetrics())
      expect(serialized).not.toContain('failed')
      expect(serialized).not.toContain('arguments')
      expect(serialized).not.toContain('content')
    } finally {
      await provider.shutdown()
    }
  })
})
