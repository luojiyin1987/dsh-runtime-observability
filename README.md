# dsh-runtime-observability

Runtime observability plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Status

Early development. PR1 established the standalone plugin lifecycle and packaging contract. PR2 added backend-neutral `tools/execute` lifecycle aggregation. PR3 projects the same metadata-only lifecycle into OpenTelemetry Metrics. PR4 adds OpenTelemetry spans around each tool dispatch.

## Current scope

- ESM TypeScript package
- hard dependency on the Harness `tools` service via `inject`
- `tools/execute` around-dispatch instrumentation
- backend-neutral runtime snapshot
- OpenTelemetry Counter / UpDownCounter / Histogram instruments
- OpenTelemetry `dsh.tool.execute` spans with parent-context propagation
- Node.js 22/24 CI for typecheck, tests, build, and package dry-run
- DSH bundle patch metadata

The plugin does **not** create global `MeterProvider` / `TracerProvider` instances, configure an OTLP endpoint, install a context manager, or own process-wide OpenTelemetry SDK setup. It uses the providers and context propagation configured by the host application. Without them, the OpenTelemetry API behaves as a no-op while the in-memory snapshot remains available.

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

| Instrument | Type | Unit | Attributes |
| --- | --- | --- | --- |
| `dsh.tool.active` | UpDownCounter | `{call}` | `tool.name` |
| `dsh.tool.calls` | Counter | `{call}` | `tool.name`, `outcome` |
| `dsh.tool.errors` | Counter | `{call}` | `tool.name` |
| `dsh.tool.duration` | Histogram | `ms` | `tool.name`, `outcome` |

`outcome` is either `success` or `error`. The histogram records each completed call directly; it is not reconstructed from the cumulative snapshot, so backends retain a real duration distribution.

## OpenTelemetry tracing

PR4 wraps the same `tools/execute` delegation in one internal span:

```text
parent span
└── dsh.tool.execute
    └── nested work / child spans
```

The span uses the instrumentation scope `dsh-runtime-observability` and records only metadata:

- `tool.name`
- `outcome = success | error`
- `error.type` when a normalized DeepSeek Harness error exposes a structured `code` or `name`

Normalized failures receive OpenTelemetry `ERROR` status. A thrown downstream wrapper error also marks the span as `ERROR`, but the plugin deliberately does not call `recordException()` because exception events may contain sensitive messages and stack traces.

The tool span inherits the host application's currently active OpenTelemetry context and remains active while `next()` runs, so nested instrumentation automatically becomes a child. Concurrent tool calls therefore receive independent span contexts.

Tracing setup failures are contained. The plugin only falls back to untraced execution when instrumentation fails **before** `next()` starts; once application work has begun it is never retried, preventing duplicate side effects.

## Design direction

The project complements DeepSeek Harness session telemetry by instrumenting runtime execution rather than copying prompt, tool argument, or tool result payloads.

Planned sequence:

1. Bootstrap plugin lifecycle and packaging. ✅
2. Measure tool execution duration and active calls through `tools/execute`. ✅
3. Export runtime metrics through OpenTelemetry instruments. ✅
4. Add tool execution spans. ✅
5. Instrument agent turn/step/request lifecycle.
6. Add a local Collector/Prometheus/Jaeger/Grafana example.

## Privacy boundary

Telemetry is metadata-first. Prompt content, tool arguments, tool result content, credentials, filesystem contents, exception messages, and stack traces are out of scope by default. Observability failures are contained and must not change the outcome of the underlying tool call.

## License

MIT
