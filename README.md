# dsh-runtime-observability

Runtime observability plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Status

Early development. PR1 established the standalone plugin lifecycle and packaging contract. PR2 added backend-neutral `tools/execute` lifecycle aggregation. PR3 projects the same metadata-only lifecycle into OpenTelemetry Metrics. PR4 adds OpenTelemetry spans around each tool dispatch. PR5 traces Agent turns, steps, and Agent-loop model requests. PR6 adds a reproducible local OpenTelemetry observability stack. PR7 adds a real Harness Runtime end-to-end observability gate.

## Current scope

- ESM TypeScript package
- hard dependencies on the Harness `tools`, `sessions`, and `llm` services via `inject`
- `tools/execute` around-dispatch instrumentation
- durable `session/event` observation for Agent turn/step boundaries
- `llm/stream` around-dispatch instrumentation for real model-call latency
- backend-neutral runtime snapshot
- OpenTelemetry Counter / UpDownCounter / Histogram instruments
- OpenTelemetry tool and Agent lifecycle spans
- local Collector / Jaeger / Prometheus / Grafana example
- real DeepSeek Harness Agent-loop E2E through Collector, Jaeger, and Prometheus
- Node.js 22/24 CI for typecheck, tests, build, and package dry-run
- DSH bundle patch metadata

The plugin does **not** create global `MeterProvider` / `TracerProvider` instances, configure an OTLP endpoint, install a context manager, or own process-wide OpenTelemetry SDK setup. It uses the providers and context propagation configured by the host application. Without them, the OpenTelemetry API behaves as a no-op while the in-memory snapshot remains available.

## Development

```sh
npm install
npm run check
```

The system E2E is intentionally separate from the normal unit/build gate because it requires the local observability stack:

```sh
docker compose -f examples/otel-stack/compose.yaml up -d
npm run test:e2e
docker compose -f examples/otel-stack/compose.yaml down -v
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

The runtime trace follows the Agent execution hierarchy:

```text
dsh.agent.turn
└── dsh.agent.step
    ├── dsh.llm.request
    └── dsh.tool.execute
        └── nested work / child spans
```

### Tool spans

Each `tools/execute` delegation produces one `dsh.tool.execute` span carrying only metadata:

- `tool.name`
- `outcome = success | error`
- `error.type` when a normalized DeepSeek Harness error exposes a structured `code` or `name`

Normalized failures receive OpenTelemetry `ERROR` status. A thrown downstream wrapper error also marks the span as `ERROR`, but the plugin deliberately does not call `recordException()` because exception events may contain sensitive messages and stack traces.

### Agent turn and step spans

DeepSeek Harness records `turn/start`, `step/start`, `step/end`, and `turn/end` as durable session events. The plugin observes the post-commit `session/event` feed and creates:

- `dsh.agent.turn` with `agent.turn` and terminal `outcome`
- `dsh.agent.step` with `agent.turn`, `agent.step`, and `outcome`

Turn and step span timestamps come from each durable `SessionEvent.time`, not from observer callback wall-clock time, so asynchronous notification delay does not inflate lifecycle latency.

The session id is used only as a process-local correlation key and is not exported as a span attribute.

### LLM request spans

`agent/request` is a call-configuration waterfall, not the model call itself. The plugin therefore instruments `llm/stream`, the around-dispatch seam that encloses the actual streaming request, and emits `dsh.llm.request` with:

- `llm.provider`
- `llm.model`
- bounded terminal `outcome`
- structured `error.type` when available

Only requests marked by DeepSeek Harness as Agent-loop requests and carrying a loop-supplied `sessionId` are traced. Auxiliary one-shot model calls are deliberately excluded.

The LLM span is explicitly parented to the current step context. Tool spans use the same process-local session correlation, so concurrent sessions remain isolated even when their executions overlap.

Tracing setup failures are contained. Instrumentation never retries application work after it has started, preventing duplicate tool or model side effects.

## Local observability stack

A pinned Docker Compose example is available under [`examples/otel-stack`](./examples/otel-stack/README.md):

```text
DeepSeek Harness host
        |
        | OTLP
        v
OpenTelemetry Collector
        |
        +---- traces ----> Jaeger
        |
        +---- metrics ---> Prometheus
                              |
                              v
                            Grafana
```

The example keeps exporter/SDK ownership outside the plugin. It provisions Prometheus and Jaeger as Grafana data sources and binds host-facing ports to loopback for local development.

```sh
cd examples/otel-stack
docker compose up -d
```

## Real Harness Runtime E2E

`e2e/runtime-observability.e2e.ts` composes the public DeepSeek Harness runtime services used by the real Agent loop: LLM, Session, Session Projection, System Prompt, Tools, Agent Registry, and Agent Loop. A deterministic local adapter produces one tool call, the registered tool executes, and the same Agent turn makes a second model request to finish.

The E2E host owns the OpenTelemetry SDK and OTLP exporters, matching the plugin's production ownership boundary. Telemetry flows through the Docker stack rather than an in-memory test exporter:

```text
real DSH Agent turn
  -> OTLP/HTTP
  -> Collector
  -> Jaeger + Prometheus
```

The gate verifies:

- one `dsh.agent.turn`
- one `dsh.agent.step`
- two `dsh.llm.request` spans
- one `dsh.tool.execute` span
- all runtime spans are present in one Jaeger trace
- Prometheus receives a successful tool-call counter
- the plugin snapshot reports one completed tool call and zero active/error calls
- prompt text, tool arguments, tool result text, and session id are absent from exported telemetry

The adapter and tool are deterministic fixtures only; orchestration, session boundaries, tool dispatch, Agent-loop request marking, plugin hooks, OTLP transport, Collector processing, Jaeger ingestion, and Prometheus scraping are real runtime paths.

## Design direction

The project complements DeepSeek Harness session telemetry by instrumenting runtime execution rather than copying prompt, tool argument, or tool result payloads.

Implemented sequence:

1. Bootstrap plugin lifecycle and packaging. ✅
2. Measure tool execution duration and active calls through `tools/execute`. ✅
3. Export runtime metrics through OpenTelemetry instruments. ✅
4. Add tool execution spans. ✅
5. Instrument Agent turn/step/model-request lifecycle. ✅
6. Add a local Collector/Prometheus/Jaeger/Grafana example. ✅
7. Prove the full observability path with a real Harness Runtime E2E gate. ✅

## Privacy boundary

Telemetry is metadata-first. Prompt content, conversation messages, tool arguments, tool result content, credentials, filesystem contents, session ids, exception messages, and stack traces are out of scope by default. Observability failures are contained and must not change the outcome of the underlying Agent, model, or tool operation.

## License

MIT
