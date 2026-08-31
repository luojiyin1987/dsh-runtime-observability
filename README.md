# dsh-runtime-observability

Runtime observability plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Status

Early development. PR1 establishes the standalone plugin package and validates its Cordis lifecycle contract. It intentionally does **not** emit traces or metrics yet.

## PR1 scope

- ESM TypeScript package
- hard dependency on the Harness `tools` service via `inject`
- observe-only subscription to the authoritative `tools/result` seam
- lifecycle test covering `PENDING -> ACTIVE -> DISPOSED`
- Node.js 22/24 CI for typecheck, tests, build, and package dry-run
- DSH bundle patch metadata

The listener is deliberately a no-op in this first change. Runtime measurement starts in PR2 at the `tools/execute` around-dispatch seam.

## Development

```sh
npm install
npm run check
```

## Design direction

The project will complement DeepSeek Harness session telemetry by instrumenting runtime execution rather than copying prompt, tool argument, or tool result payloads.

Planned sequence:

1. Bootstrap plugin lifecycle and packaging.
2. Measure tool execution duration and active calls through `tools/execute`.
3. Export OpenTelemetry metrics.
4. Add tool execution spans.
5. Instrument agent turn/step/request lifecycle.
6. Add a local Collector/Prometheus/Jaeger/Grafana example.

## Privacy boundary

Telemetry should be metadata-first. Prompt content, tool arguments, tool result content, credentials, and filesystem contents are out of scope by default.

## License

MIT
