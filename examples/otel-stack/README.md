# Local OpenTelemetry stack

A local Docker Compose stack for inspecting telemetry emitted by `dsh-runtime-observability`.

```text
DeepSeek Harness host
        |
        | OTLP gRPC :4317 / HTTP :4318
        v
OpenTelemetry Collector
        |
        +---- traces ----> Jaeger :16686
        |
        +---- metrics ---> Prometheus :9090
                              |
                              v
                         Grafana :3000
```

The stack deliberately keeps SDK ownership in the host application. The plugin still does not install a global OpenTelemetry provider, context manager, processor, or exporter.

## Pinned images

- OpenTelemetry Collector Contrib `0.159.0`
- Jaeger `2.20.0`
- Prometheus `3.14.0`
- Grafana `13.2.0`

## Start

```sh
cd examples/otel-stack
docker compose up -d
```

All host-facing ports bind to `127.0.0.1` so this development stack is not exposed on other network interfaces by default.

Configure the DeepSeek Harness host's OpenTelemetry SDK to export traces and metrics to the Collector using either:

- OTLP/gRPC: `localhost:4317`
- OTLP/HTTP: `http://localhost:4318`

The exact exporter setup belongs to the host SDK. Set a useful OpenTelemetry `service.name` resource such as `deepseek-harness`; Jaeger uses that resource when listing services.

## Inspect traces

Open <http://localhost:16686> or use the provisioned Jaeger data source in Grafana.

A tool-using Agent turn should have this shape:

```text
dsh.agent.turn
└── dsh.agent.step
    ├── dsh.llm.request
    └── dsh.tool.execute
```

The plugin does not export session ids, prompts, messages, tool arguments/results, exception messages, or stack traces.

## Inspect metrics

Open <http://localhost:9090> and search for metric names beginning with `dsh_tool` after the host has exported at least one completed tool call. The Collector's Prometheus exporter translates OpenTelemetry metric names to Prometheus-compatible names.

Grafana is available at <http://localhost:3000> with the local-only credentials:

```text
username: admin
password: admin
```

Prometheus and Jaeger are provisioned automatically as Grafana data sources, so Explore can query both without manual setup.

## Stop

```sh
docker compose down
```

To also delete local Prometheus and Grafana volumes:

```sh
docker compose down -v
```

## Validate configuration

The repository CI runs the same semantic checks used here:

```sh
docker compose -f examples/otel-stack/compose.yaml config

docker run --rm \
  -v "$PWD/examples/otel-stack/otel-collector.yaml:/etc/otelcol-contrib/config.yaml:ro" \
  otel/opentelemetry-collector-contrib:0.159.0 \
  validate --config=/etc/otelcol-contrib/config.yaml

docker run --rm \
  -v "$PWD/examples/otel-stack/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  --entrypoint /bin/promtool \
  prom/prometheus:v3.14.0 \
  check config /etc/prometheus/prometheus.yml
```

This example is for local development and demonstrations, not a production monitoring deployment.
