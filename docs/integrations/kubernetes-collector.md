# Kubernetes workload collector

The Kubernetes collector observes workload failures in one namespace and exports normalized evidence through the IncidentIQ API. It uses Kubernetes' official Node.js client and only needs read-only access to Pods and Events.

## Signals collected

- `oom_killed` when a container terminates with `OOMKilled`
- `crash_loop_back_off` when a container is waiting in `CrashLoopBackOff`
- `pod_restart` when a container restart count is greater than zero
- `failed_scheduling` for unschedulable Pods or `FailedScheduling` Events
- `unhealthy` for Kubernetes `Unhealthy` Events, such as failed readiness probes

Every event uses a deterministic ID derived from the cluster, Pod UID, signal type, and source occurrence. The API therefore rejects duplicate observations safely after a collector restart.

## Requirements

1. An IncidentIQ API URL reachable from the cluster.
2. An ingestion key for the API's tenant.
3. One stable application label on monitored Pods. The default is `app.kubernetes.io/name`.
4. A collector deployment in each namespace you want to observe.

The collector intentionally ignores Pods without the configured service label. A Pod name is not a stable service identifier and would make evidence difficult to correlate.

## Build the image

After v0.4.0 reaches `main`, use the immutable collector image built by CI:

```text
ghcr.io/shreyanshi200/incidentiq-kubernetes-collector:sha-<commit-sha>
```

Until then, or when using your own registry, build the collector from the repository root and push it to a registry your cluster can pull from:

```sh
docker build \
  -f integrations/kubernetes-collector/Dockerfile \
  -t your-registry/incidentiq-kubernetes-collector:0.4.0 \
  .

docker push your-registry/incidentiq-kubernetes-collector:0.4.0
```

## Deploy to one namespace

Create the ingestion-key secret in the target namespace:

```sh
kubectl -n payments create secret generic incidentiq \
  --from-literal=api-key=iiq_your_key
```

Update the image, API URL, environment, and cluster name in [`collector.yaml`](../../integrations/kubernetes-collector/deploy/collector.yaml), then deploy it to that namespace:

```sh
kubectl -n payments apply -f integrations/kubernetes-collector/deploy/collector.yaml
```

The manifest creates a ServiceAccount, Role, RoleBinding, and Deployment. Its Role permits only `list` for `pods` and `events` in that namespace. It cannot create, modify, delete, or watch Kubernetes resources.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `INCIDENTIQ_API_KEY` | Yes | — | IncidentIQ ingestion key |
| `INCIDENTIQ_API_URL` | No | `http://localhost:3000` | IncidentIQ API base URL |
| `INCIDENTIQ_TENANT_ID` | No | `local` | Must match the ingestion key's tenant |
| `INCIDENTIQ_ENVIRONMENT` | Yes | — | Target environment, for example `production` |
| `INCIDENTIQ_CLUSTER_NAME` | Yes | — | Stable cluster identifier used for deduplication |
| `INCIDENTIQ_KUBERNETES_NAMESPACE` | Yes | — | Namespace to observe |
| `INCIDENTIQ_SERVICE_LABEL` | No | `app.kubernetes.io/name` | Pod label used as the IncidentIQ service name |
| `INCIDENTIQ_POLL_INTERVAL_MS` | No | `30000` | Polling interval in milliseconds |

## Verify collection

Inspect the collector logs:

```sh
kubectl -n payments logs deployment/incidentiq-kubernetes-collector
```

Then use the IncidentIQ CLI against the API database:

```sh
pnpm incidentiq events list
```

Look for `source: "kubernetes"` and resources such as `pod/payments/orders-...`.

## Local kind smoke test

Use this only with a disposable local cluster. It creates a deliberately crash-looping Pod and sends its evidence to your local IncidentIQ API through a temporary HTTPS tunnel.

### 1. Start IncidentIQ

In terminal 1, from the repository root:

```sh
export DATABASE_URL=postgresql://incidentiq:incidentiq@localhost:5432/incidentiq
docker compose up -d postgres
pnpm incidentiq init
pnpm incidentiq keys create --scope ingest
pnpm api
```

Copy the `iiq_...` key printed by `keys create`.

In terminal 2, create a temporary public URL for the local API:

```sh
cloudflared tunnel --protocol http2 --url http://localhost:3000
```

Copy the displayed `https://...trycloudflare.com` URL and keep both terminals running.

### 2. Create a disposable cluster

Install [kind](https://kind.sigs.k8s.io/docs/user/quick-start) if needed, then run:

```sh
kind create cluster --name incidentiq-v04 --wait 2m

docker build \
  -f integrations/kubernetes-collector/Dockerfile \
  -t incidentiq-kubernetes-collector:v0.4.0-test \
  .

kind load docker-image incidentiq-kubernetes-collector:v0.4.0-test --name incidentiq-v04
```

### 3. Deploy the collector

In terminal 3, enter the ingestion key without adding it to shell history, then set the API URL you copied above:

```sh
read -rs INCIDENTIQ_API_KEY
export INCIDENTIQ_API_KEY
printf '\n'

export INCIDENTIQ_API_URL=https://your-tunnel.trycloudflare.com

kubectl create namespace payments
kubectl -n payments create secret generic incidentiq --from-literal=api-key="$INCIDENTIQ_API_KEY"
kubectl -n payments apply -f integrations/kubernetes-collector/deploy/collector.yaml
kubectl -n payments set image deployment/incidentiq-kubernetes-collector collector=incidentiq-kubernetes-collector:v0.4.0-test
kubectl -n payments set env deployment/incidentiq-kubernetes-collector \
  INCIDENTIQ_API_URL="$INCIDENTIQ_API_URL" \
  INCIDENTIQ_ENVIRONMENT=local \
  INCIDENTIQ_CLUSTER_NAME=incidentiq-v04
kubectl -n payments rollout status deployment/incidentiq-kubernetes-collector --timeout=2m
```

### 4. Trigger and verify a workload signal

Create a labeled Pod that repeatedly exits:

```sh
kubectl -n payments run orders-failure \
  --image=busybox:1.36 \
  --restart=Always \
  --labels=app.kubernetes.io/name=orders \
  --command -- /bin/sh -c 'exit 1'

kubectl -n payments get pods -w
```

When `orders-failure` reaches `CrashLoopBackOff`, stop the watch with `Ctrl+C`. The collector polls every 30 seconds. Inspect its logs:

```sh
kubectl -n payments logs deployment/incidentiq-kubernetes-collector --tail=100
```

You should see a message that Kubernetes workload signals were exported. Back in terminal 1 or a fourth terminal, verify the evidence:

```sh
pnpm incidentiq events list
```

Look for `source: "kubernetes"`, `service: "orders"`, and event types `pod_restart` or `crash_loop_back_off`.

### 5. Clean up

Stop the Cloudflare tunnel with `Ctrl+C`, then delete only the disposable cluster:

```sh
kind delete cluster --name incidentiq-v04
```

## Current limit

This first collector polls rather than maintains Kubernetes watches. It is namespace-scoped and relies on deterministic event IDs plus API deduplication for safe repeated observations. Use it for a controlled initial rollout; a future collector iteration can add watch checkpoints and cluster-wide configuration.
