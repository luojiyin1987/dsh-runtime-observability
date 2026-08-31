# dsh-runtime-observability

Runtime observability plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Status

Early development. PR1 established the standalone plugin lifecycle and packaging contract. PR2 added backend-neutral `tools/execute` lifecycle aggregation. PR3 projects the same metadata-only lifecycle into OpenTelemetry Metrics.

## Current scope

- ESM TypeScript package
- hard dependency on the Harness `tools` service via `inject`
- `tools/execute` around-dispatch instrumentation
- backend-neutral runtime snapshot
- OpenTelemetry Counter / UpDownCounter / Histogram instruments
- Node.js 22/24 CI for typecheck, tests, build, and package dry-run
- DSH bundle patch metadata

The plugin does **not** create a global `MeterProvider`, configure an OTLP endpoint, or own process-wide OpenTelemetry SDK setup. It uses the provider configured by the host application. Without one, the OpenTelemetry API behaves as a no-op while the in-memory snapshot remains available.

## Development

```sh
npm install
npm run check
```

## Runtime snapshot

While the plugin is active, other Harness plugins can declare `dshRuntimeObservability` as a dependency and read aggregate metadata:

```ts
const snapshot = ctx.dshRuntimeObservability.snapshot()
```

A snapshot has this shape:

```ts
{
  active: number
  calls: number
  errors: number
  durationMs: number
  tools: {
    [toolName: string]: {
      active: number
      calls: number
      errors: number
      durationMs: number
    }
  }
}
```

## OpenTelemetry metrics

PR3 emits four instruments from the same tool lifecycle:

| Instrument | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `dsh.tool.active` | UpDownCounter | `{call}` | `tool.name` |
| `dsh.tool.calls` | Counter | `{call}` | `tool.name`, `outcome` |
| `dsh.tool.errors` | Counter | `{call}` | `tool.name` |
| `dsh.tool.duration` | Histogram | `ms` | `tool.name`, `outcome` |

`outcome` is either `success` or `error`. The histogram records each completed call directly; it is not reconstructed from the cumulative snapshot, so backends retain a real duration distribution.

The default instrumentation scope is `dsh-runtime-observability`. Applications remain responsible for configuring their preferred OpenTelemetry SDK, MetricReader, and exporter.

## Design direction

The project complements DeepSeek Harness session telemetry by instrumenting runtime execution rather than copying prompt, tool argument, or tool result payloads.

Planned sequence:

1. Bootstrap plugin lifecycle and packaging. ✅
2. Measure tool execution duration and active calls through `tools/execute`. ✅
3. Export runtime metrics through OpenTelemetry instruments. ✅
4. Add tool execution spans.
5. Instrument agent turn/step/request lifecycle.
6. Add a local Collector/Prometheus/Jaeger/Grafana example.

## Privacy boundary

Telemetry is metadata-first. Prompt content, tool arguments, tool result content, credentials, filesystem contents, and exception messages are out of scope by default. Lifecycle exporter failures are contained and must not change the outcome of the underlying tool call.

## License

MIT
