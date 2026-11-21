# Prometheus Alertmanager integration

Use this integration when you already run Prometheus and Alertmanager. Prometheus evaluates your CPU, memory, latency, and error-rate rules; Alertmanager reliably sends each firing and resolved alert to IncidentIQ. IncidentIQ does not poll Prometheus, scrape metrics, or need access to your cluster.

## What IncidentIQ receives

The API accepts Alertmanager v4 webhook payloads at:

```text
POST /v1/integrations/alertmanager
```

It needs a normal `iiq_...` ingestion key as a Bearer token. Alertmanager retries delivery, and IncidentIQ deduplicates retries using the alert fingerprint, start time, and lifecycle state.

Each alert must include these labels:

| Label | Why it is needed |
| --- | --- |
| `alertname` | Human-readable alert name |
| `service` | Stable IncidentIQ service name, such as `orders` |
| `namespace` | Kubernetes namespace or another stable workload boundary |

These optional labels make the evidence more useful:

| Label | Values | Meaning |
| --- | --- | --- |
| `severity` | `info`, `warning`, `critical` | IncidentIQ event severity; unlabelled firing alerts are `error` |
| `environment` | for example `production` | IncidentIQ environment; defaults to `production` |
| `incidentiq_signal` | `cpu_throttling`, `memory_saturation`, `latency_spike`, `error_rate_spike` | Maps an alert to a specific reliability signal; other alerts become `prometheus_alert` |

## 1. Create an IncidentIQ key

Run this from a checkout connected to the IncidentIQ database:

```sh
pnpm incidentiq keys create --scope ingest --tenant local --label alertmanager
```

Store the displayed key in your secret manager. Alertmanager should read it from a mounted secret file, never from committed YAML.

## 2. Add Prometheus alert rules

Use the PromQL expressions that already power your alerts. They must retain `service` and `namespace` labels, because those identify the IncidentIQ evidence. The following is an example rule shape; adapt metric names and labels to your instrumentation.

```yaml
groups:
  - name: incidentiq-reliability
    rules:
      - alert: HighLatency
        expr: histogram_quantile(0.95, sum by (le, namespace, service) (rate(http_server_request_duration_seconds_bucket{namespace="payments"}[5m]))) > 1
        for: 5m
        labels:
          severity: critical
          incidentiq_signal: latency_spike
          service: '{{ $labels.service }}'
          namespace: '{{ $labels.namespace }}'
          environment: production
        annotations:
          summary: p95 request latency is above one second
```

Use the same label convention for the other reliability rules:

| Alert condition | `incidentiq_signal` | Typical threshold |
| --- | --- | --- |
| Container CPU throttle ratio | `cpu_throttling` | Greater than `0.25` for five minutes |
| Working-set memory divided by its limit | `memory_saturation` | Greater than `0.90` for five minutes |
| p95 request latency | `latency_spike` | Greater than the service SLO |
| 5xx requests divided by all requests | `error_rate_spike` | Greater than `0.05` for five minutes |

## 3. Configure Alertmanager

The IncidentIQ API must be reachable over HTTPS from Alertmanager. Add a receiver to your Alertmanager configuration and point it to the API. This example reads the API key from a mounted secret file:

```yaml
route:
  receiver: incidentiq
  group_by: [alertname, service, namespace]

receivers:
  - name: incidentiq
    webhook_configs:
      - url: https://incidentiq.example.com/v1/integrations/alertmanager
        send_resolved: true
        max_alerts: 100
        timeout: 10s
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/secrets/incidentiq-api-key
```

Keep `send_resolved: true`: it lets IncidentIQ record when the alert recovered. Alertmanager owns retry and backoff behaviour, so a temporary IncidentIQ outage does not require a polling workaround.

## 4. Verify delivery safely

Set the key only in the current terminal:

```sh
read -rs INCIDENTIQ_API_KEY
```

```sh
export INCIDENTIQ_API_KEY
```

```sh
printf '\n'
```

Post the included firing-alert example to a local API:

```sh
curl -i \
  --request POST http://localhost:3000/v1/integrations/alertmanager \
  --header "Authorization: Bearer $INCIDENTIQ_API_KEY" \
  --header 'Content-Type: application/json' \
  --data @docs/examples/alertmanager-firing.json
```

Expected response:

```json
{"accepted":1,"duplicates":0}
```

Run the same command again. A real Alertmanager retry is safely reported as a duplicate:

```json
{"accepted":0,"duplicates":1}
```

Post the matching resolved alert. It has the same fingerprint and start time, but a separate lifecycle state:

```sh
curl -i \
  --request POST http://localhost:3000/v1/integrations/alertmanager \
  --header "Authorization: Bearer $INCIDENTIQ_API_KEY" \
  --header 'Content-Type: application/json' \
  --data @docs/examples/alertmanager-resolved.json
```

Expected response:

```json
{"accepted":1,"duplicates":0}
```

Inspect the stored evidence:

```sh
pnpm incidentiq events list
```

Look for `source: "alertmanager"`, `event_type: "latency_spike"`, and `resource: "service/payments/orders"`.

## Full local Prometheus and Alertmanager test

The files in [`docs/examples`](../examples) run a disposable Prometheus and Alertmanager pair. The test rule intentionally fires after ten seconds, and you can reload it as a resolved alert. Docker Desktop and `cloudflared` must be available.

Build and start the local IncidentIQ API in one terminal:

```sh
pnpm build
```

```sh
pnpm api
```

In another terminal, expose the API through a temporary HTTPS tunnel:

```sh
cloudflared tunnel --protocol http2 --url http://localhost:3000
```

Copy its `https://...trycloudflare.com` URL. In a third terminal, enter an ingestion key and set the tunnel base URL:

```sh
read -rs INCIDENTIQ_API_KEY
```

```sh
export INCIDENTIQ_API_KEY
```

```sh
printf '\n'
```

```sh
export INCIDENTIQ_TUNNEL_URL=https://your-tunnel.trycloudflare.com
```

Construct the exact IncidentIQ webhook endpoint from it:

```sh
export INCIDENTIQ_WEBHOOK_URL="${INCIDENTIQ_TUNNEL_URL}/v1/integrations/alertmanager"
```

Create a temporary configuration directory. The generated Alertmanager configuration contains your key, so it is deliberately outside the repository:

```sh
IIQ_MONITOR_DIR=$(mktemp -d)
```

```sh
cp docs/examples/prometheus-local.yml "$IIQ_MONITOR_DIR/prometheus.yml"
```

```sh
cp docs/examples/incidentiq-test-rules.yml "$IIQ_MONITOR_DIR/incidentiq-test-rules.yml"
```

Confirm both files exist before starting containers. This prevents Docker from treating a missing file as a directory mount:

```sh
test -f "$IIQ_MONITOR_DIR/prometheus.yml" -a -f "$IIQ_MONITOR_DIR/incidentiq-test-rules.yml"
```

```sh
sed \
  -e "s|__INCIDENTIQ_WEBHOOK_URL__|$INCIDENTIQ_WEBHOOK_URL|g" \
  -e "s|__INCIDENTIQ_API_KEY__|$INCIDENTIQ_API_KEY|g" \
  docs/examples/alertmanager-local.template.yml > "$IIQ_MONITOR_DIR/alertmanager.yml"
```

Verify that the generated webhook URL includes the IncidentIQ endpoint path before starting Alertmanager:

```sh
grep -q '/v1/integrations/alertmanager' "$IIQ_MONITOR_DIR/alertmanager.yml"
```

Start the disposable monitoring network and containers:

```sh
docker network inspect incidentiq-alert-test >/dev/null 2>&1 || docker network create incidentiq-alert-test
```

```sh
docker run --detach \
  --name incidentiq-alertmanager-test \
  --network incidentiq-alert-test \
  --network-alias alertmanager \
  --publish 9093:9093 \
  --mount type=bind,src="$IIQ_MONITOR_DIR/alertmanager.yml",dst=/etc/alertmanager/alertmanager.yml,readonly \
  prom/alertmanager:v0.34.1 \
  --config.file=/etc/alertmanager/alertmanager.yml
```

```sh
docker run --detach \
  --name incidentiq-prometheus-test \
  --network incidentiq-alert-test \
  --publish 9090:9090 \
  --mount type=bind,src="$IIQ_MONITOR_DIR/prometheus.yml",dst=/etc/prometheus/prometheus.yml,readonly \
  --mount type=bind,src="$IIQ_MONITOR_DIR/incidentiq-test-rules.yml",dst=/etc/prometheus/incidentiq-test-rules.yml,readonly \
  prom/prometheus:v3.15.1 \
  --config.file=/etc/prometheus/prometheus.yml \
  --web.enable-lifecycle
```

Wait about 20 seconds for the rule to fire, then verify the alert and IncidentIQ evidence:

```sh
curl --silent http://localhost:9090/api/v1/alerts
```

```sh
pnpm incidentiq events list | grep -C 10 '"source": "alertmanager"'
```

Change the test expression from true to false, reload Prometheus, then wait another 20 seconds for the resolved event:

```sh
perl -0pi -e 's/vector\(1\)/vector(0)/' "$IIQ_MONITOR_DIR/incidentiq-test-rules.yml"
```

```sh
curl --request POST http://localhost:9090/-/reload
```

```sh
sleep 20
```

```sh
pnpm incidentiq events list | grep -C 10 '"alert_status": "resolved"'
```

Clean up the disposable containers, network, and temporary configuration when finished:

```sh
docker rm --force incidentiq-prometheus-test incidentiq-alertmanager-test
```

```sh
docker network rm incidentiq-alert-test
```

```sh
rm -rf "$IIQ_MONITOR_DIR"
```

## Current limit

This integration receives alert lifecycle notifications; it does not retain raw metric samples or manage Prometheus rule files. Alertmanager groups alerts before delivery, so configure `group_by` with `alertname`, `service`, and `namespace` to keep each evidence record attributable.
