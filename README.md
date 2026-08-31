# dsh-runtime-observability

Runtime observability plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Status

Early development. PR1 established the standalone plugin lifecycle and packaging contract. PR2 instruments the `tools/execute` around-dispatch seam with a backend-neutral in-memory aggregate.

## Current scope

- ESM TypeScript package
- hard dependency on the Harness `tools` service via `inject`
- `tools/execute` around-dispatch instrumentation
- active tool-call gauges
- completed call and error counters
- aggregate execution duration globally and per tool
- lifecycle-owned `dshRuntimeObservability` Cordis service
- Node.js 22/24 CI for typecheck, tests, build, and package dry-run
- DSH bundle patch metadata

No OpenTelemetry exporter is included yet. The current service exposes a snapshot that PR3 can project into OTel instruments without changing the collection boundary.

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

## Design direction

The project complements DeepSeek Harness session telemetry by instrumenting runtime execution rather than copying prompt, tool argument, or tool result payloads.

Planned sequence:

1. Bootstrap plugin lifecycle and packaging. ✅
2. Measure tool execution duration and active calls through `tools/execute`. ✅
3. Export OpenTelemetry metrics.
4. Add tool execution spans.
5. Instrument agent turn/step/request lifecycle.
6. Add a local Collector/Prometheus/Jaeger/Grafana example.

## Privacy boundary

Telemetry is metadata-first. Prompt content, tool arguments, tool result content, credentials, filesystem contents, and exception messages are out of scope by default.

## License

MIT
