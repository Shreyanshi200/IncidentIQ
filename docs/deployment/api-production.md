# Production API deployment

This guide deploys the IncidentIQ API on one Linux host with Docker, a PostgreSQL database, a DNS name, and an HTTPS reverse proxy. It is cloud-neutral: the host and PostgreSQL database can be on AWS, Azure, GCP, DigitalOcean, or your own infrastructure.

This is the appropriate production shape for the current single-operator MVP. It is not yet an active-active, multi-region deployment.

## What you need

- a released, immutable API image from GitHub Container Registry;
- a PostgreSQL database reachable only from the API host or private network;
- a Linux host with Docker Compose v2 and a reverse proxy such as Nginx;
- a trusted operator workstation with Git, Node.js 24, pnpm 11.6, and `rsync` for building and uploading the dashboard;
- SSH or equivalent management access restricted to the operator's IP or private network;
- a DNS record, for example `incidentiq.example.com`, pointing to that host; and
- a certificate for that DNS name.

Do not expose PostgreSQL to the public internet. Do not expose the API container port directly; expose HTTPS through the reverse proxy instead.

## 1. Prepare the deployment files

On the server, clone the repository at the release you are deploying. The checkout provides the deployment examples and is also useful when investigating an issue later.

```sh
git clone https://github.com/Shreyanshi200/IncidentIQ.git
```

```sh
cd IncidentIQ
```

```sh
git checkout v<released-version>
```

Create a small deployment directory and copy the checked-in examples into it:

```sh
mkdir -p ~/incidentiq-production
```

```sh
cp docs/examples/api-production.compose.yml ~/incidentiq-production/compose.yml
```

```sh
cp docs/examples/api-production.env.example ~/incidentiq-production/.env
```

Edit `~/incidentiq-production/.env`. Replace all placeholders:

- `INCIDENTIQ_API_IMAGE` — an immutable `sha-<commit-sha>` tag from a successful merge to `main`;
- `DATABASE_URL` — the real PostgreSQL connection string, including the provider's TLS settings;
- `INCIDENTIQ_SESSION_SECRET` — at least 32 random bytes used to sign short-lived dashboard sessions;
- `INCIDENTIQ_INCIDENT_GAP_MINUTES` — positive minutes of inactivity after which a matching error starts a new incident, normally `10`;
- `INCIDENTIQ_CONTEXT_LOOKBACK_MINUTES` — positive minutes of preceding evidence included and evaluated for cause correlation, normally `10`;
- optional `OPENAI_API_KEY` and `INCIDENTIQ_AI_MODEL` — set both only when your data policy permits OpenAI to process selected incident evidence; and
- optional `CLICKHOUSE_URL`, database, and credentials — set these only when a separately operated ClickHouse archive is justified by measured historical volume; and
- the request, session, and AI guardrail values — keep the checked-in defaults unless your measured workload requires a bounded change;
- `NODE_ENV` — keep this as `production` so the API requires a stable session secret and emits structured request logs; and
- `PORT` — normally leave this as `3000`.

Keep `.env` readable only by the deployment operator. It contains the database password.

When ClickHouse is enabled, its password is also contained in this file. The API sends archived records asynchronously, so ClickHouse is not part of the readiness probe and temporary archive downtime does not reject ingestion. Follow the [ClickHouse guide](../clickhouse.md) for backfill, queue monitoring, retention ownership, and verification before pruning PostgreSQL data.

Do not enable `INCIDENTIQ_POSTGRES_HOT_RETENTION_DAYS` on the first ClickHouse startup. Backfill existing tenants, confirm `archive status` reaches zero, verify representative events and incidents in ClickHouse, and only then enable a conservative hot window and restart the API.

Generate the server-only dashboard session secret on a trusted machine:

```sh
openssl rand -base64 48
```

Copy the printed value after `INCIDENTIQ_SESSION_SECRET=` in `~/incidentiq-production/.env`. This value does not start with `iiq_`, is never pasted into the dashboard, and must remain stable across API restarts. Rotating it immediately signs out every dashboard session.

Do not confuse the server secret with the API keys created later:

| Credential | Purpose | Location |
| --- | --- | --- |
| `INCIDENTIQ_SESSION_SECRET` | Signs eight-hour browser session cookies | API server `.env` or managed secret store |
| Ingestion key (`iiq_...`) | Lets an integration send evidence | Integration secret store; IncidentIQ keeps only its hash |
| Read key (`iiq_...`) | Lets an operator open one tenant's dashboard | Operator password manager; IncidentIQ keeps only its hash |
| `OPENAI_API_KEY` | Optional operator-requested AI explanations | API server secret manager; never the dashboard or an integration |

```sh
chmod 600 ~/incidentiq-production/.env
```

Validate the Compose file and required variables without printing their secret values:

```sh
cd ~/incidentiq-production
```

```sh
docker compose config --quiet
```

If the GHCR image is private, authenticate Docker with a GitHub token that has `read:packages` permission before pulling it. Public images do not need this step.

```sh
docker login ghcr.io
```

## 2. Apply database migrations

The API image includes the IncidentIQ CLI specifically so the production host does not need a Node.js or pnpm installation. From the deployment directory, pull the selected image and run the idempotent migration command:

```sh
cd ~/incidentiq-production
```

```sh
docker compose pull api
```

```sh
docker compose run --rm --no-deps --entrypoint node api apps/cli/dist/src/index.js init
```

Expected output:

```text
PostgreSQL is ready and migrations are applied.
```

The command records each applied SQL migration in `schema_migrations`; running it again is safe. Take a database backup before applying a new application version.

## 3. Create and store API keys

Create an ingestion key for each independent producer or secret boundary. The following command creates one key; repeat it when GitHub Actions, Kubernetes, Alertmanager, or an application should not share credentials:

```sh
docker compose run --rm --no-deps --entrypoint node api apps/cli/dist/src/index.js keys create --scope ingest --tenant local --label production-ingestion
```

The raw `iiq_...` key is printed once. Save it immediately in your secret manager, then add it as a secret in GitHub Actions, Kubernetes, or Alertmanager. IncidentIQ stores only its hash.

Create a separate read key for the dashboard operator:

```sh
docker compose run --rm --no-deps --entrypoint node api apps/cli/dist/src/index.js keys create --scope read --tenant local --label production-dashboard
```

Save this second `iiq_...` value in the operator's password manager. Do not give it to an integration. Both keys belong to the explicit `local` tenant, so the dashboard only returns that tenant's data. Use the [operations guide](../operations.md) to list metadata and rotate, expire, or revoke a key without exposing its raw value.

Do not put any key in application source code, a committed `.env` file, or a shell history command.

## 4. Start the API and verify it locally

```sh
docker compose up -d api
```

```sh
docker compose ps
```

```sh
curl --fail --silent --show-error http://127.0.0.1:3000/v1/health/ready
```

Expected output:

```json
{"status":"ok"}
```

The compose configuration binds port `3000` only to `127.0.0.1`. It is therefore reachable by a reverse proxy on the same host but not directly from the internet.

## 5. Prepare DNS and HTTPS

Create DNS for your chosen hostname and obtain a trusted TLS certificate. Keep port `3000` private; the reverse proxy in the next step is the only public entry point.

Certificate setup depends on the host. If you use Let's Encrypt HTTP validation, port 80 must be reachable while the certificate is issued and can then redirect to HTTPS. DNS validation does not require public port 80. Restrict SSH to the operator's IP or private management network rather than exposing it globally.

Your platform may provide an ingress controller, load balancer, or managed HTTPS endpoint instead of Nginx. The required properties are:

- public traffic reaches `https://incidentiq.example.com` on port 443;
- `/v1` requests reach the private API service;
- dashboard files and `/v1` use the same HTTPS origin;
- port 3000 is not publicly reachable; and
- PostgreSQL accepts connections only from IncidentIQ's private network.

## 6. Deploy the dashboard

On the trusted operator workstation, clone the repository if it is not already available:

```sh
git clone https://github.com/Shreyanshi200/IncidentIQ.git
```

```sh
cd IncidentIQ
```

Use the same released repository version as the API:

```sh
git checkout v<released-version>
```

Install the locked dependencies and build the static files:

```sh
pnpm install --frozen-lockfile
```

```sh
pnpm --filter @incidentiqhq/dashboard build
```

On the production host, create a directory owned by the current deployment account and readable by Nginx:

```sh
sudo install -d -o "$(id -un)" -g "$(id -gn)" -m 0755 /var/www/incidentiq
```

From the operator workstation, upload only the generated static files. Replace `operator` and the hostname with the real SSH destination:

```sh
rsync --archive --delete apps/dashboard/dist/ operator@incidentiq.example.com:/var/www/incidentiq/
```

Configure Nginx to serve the dashboard and forward only `/v1` requests to the loopback-bound API:

```nginx
server {
    listen 80;
    server_name incidentiq.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name incidentiq.example.com;

    ssl_certificate     /etc/letsencrypt/live/incidentiq.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/incidentiq.example.com/privkey.pem;

    root /var/www/incidentiq;
    index index.html;

    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header X-Frame-Options DENY always;

    location /v1/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

The certificate paths above are the usual Let's Encrypt paths. Replace them when your provider or certificate manager stores the files elsewhere.

IncidentIQ trusts this single reverse-proxy hop when applying per-client dashboard session limits. Keep the API bound to loopback as shown above. Do not expose port `3000` directly or insert another proxy layer without updating the deployment topology.

Validate the configuration before reloading Nginx:

```sh
sudo nginx -t
```

```sh
sudo systemctl reload nginx
```

Verify both routes through the public hostname:

```sh
curl --fail --silent --show-error https://incidentiq.example.com/v1/health/ready
```

```sh
curl --fail --silent --show-error https://incidentiq.example.com/ | grep -q '<title>IncidentIQ</title>'
```

Open `https://incidentiq.example.com` in a browser, paste the read key created in step 3, refresh the page once, then select **Sign out**. The raw read key is sent once and replaced by an eight-hour `HttpOnly`, `Secure`, `SameSite=Strict` cookie. The stable session secret keeps valid sessions working across API restarts.

If AI explanations are enabled, open a saved incident and generate one explanation. Confirm that the result is labeled **AI-generated**, each observation and check links to stored evidence, and a later PDF contains the optional AI evidence review. Read the [AI explanations guide](../ai-explanations.md) before production use; the selected redacted incident is sent to OpenAI with response storage disabled.

## 7. Connect integrations

All current integrations authenticate with an ingestion key created above.

| Producer | Configure with |
| --- | --- |
| GitHub Actions | Repository secret `INCIDENTIQ_API_KEY` and repository variable `INCIDENTIQ_API_URL=https://incidentiq.example.com` |
| Kubernetes collector | Kubernetes Secret named `incidentiq` with `api-key`, plus `INCIDENTIQ_API_URL=https://incidentiq.example.com` |
| Alertmanager | Receiver URL `https://incidentiq.example.com/v1/integrations/alertmanager` and an `Authorization: Bearer iiq_...` header |
| Node.js SDK | `INCIDENTIQ_API_URL=https://incidentiq.example.com` and its ingestion key |

Follow the individual integration guides for labels, RBAC, and test commands.

Use the complete HTTPS base URL as `INCIDENTIQ_API_URL`. The Alertmanager receiver URL must additionally include `/v1/integrations/alertmanager`.

After sending a real or test event, verify storage from the production directory without installing Node.js on the host:

```sh
docker compose run --rm --no-deps --entrypoint node api apps/cli/dist/src/index.js events list
```

## Operations checklist

Before accepting production events, verify all of the following:

- [ ] The API liveness and readiness endpoints succeed through the public HTTPS hostname.
- [ ] The dashboard loads through the same hostname, accepts the read key, survives a page refresh, and signs out cleanly.
- [ ] The database is private, encrypted in transit, and backed up.
- [ ] The `.env` file, stable session secret, ingestion keys, and read key are held only in approved secret storage.
- [ ] The host firewall permits public 443, optional 80 for certificate validation and redirect, and restricted SSH or management access; port 3000 is loopback-only.
- [ ] You deployed an immutable image tag, not `latest`.
- [ ] At least one producer has sent an event and `events list` (or direct database inspection) confirms it was stored.
- [ ] The GitHub Actions, Kubernetes, and Alertmanager values use the HTTPS hostname rather than a temporary development tunnel.

## Hosting troubleshooting

If the image does not pull, first verify that the owner is lowercase, the `sha-...` tag matches a successful **Publish images** workflow run, and Docker is logged in when the GHCR package is private:

```sh
docker compose pull api
```

If the API does not become healthy, inspect its logs. Database reachability, TLS settings in `DATABASE_URL`, and unapplied migrations are the usual causes:

```sh
docker compose logs --tail=100 api
```

If the hostname returns an API 404 instead of the dashboard, Nginx is still proxying `/` to port 3000. Use the split `location /v1/` and static `location /` configuration from step 6, confirm the files exist in `/var/www/incidentiq`, then validate and reload Nginx.

If the dashboard rejects a key, create it with `--scope read`; an ingestion key is intentionally refused. If refresh immediately signs the operator out after an API restart, confirm that the same `INCIDENTIQ_SESSION_SECRET` is still loaded by the container.

## Backups and recovery

Use automated backups from your managed PostgreSQL provider where available. If you operate PostgreSQL yourself, schedule encrypted backups and test restoration regularly. A manual PostgreSQL backup from a trusted operator host looks like:

```sh
pg_dump --format=custom --file=incidentiq-$(date +%F).dump "$DATABASE_URL"
```

Store backups away from the API host. Database backups contain recorded evidence and API-key hashes, so protect them as sensitive operational data.

For recovery, restore a known-good PostgreSQL backup, start the API with its matching or newer compatible image, then verify `/v1/health/ready`. Do not assume a database migration can be rolled back automatically.

## Upgrade procedure

1. Pick the new immutable image tag from a successful `main` build.
2. Back up PostgreSQL.
3. Change `INCIDENTIQ_API_IMAGE` in `~/incidentiq-production/.env`.
4. Pull the image, run migrations, and restart the API:

```sh
cd ~/incidentiq-production
```

```sh
docker compose pull api
```

```sh
docker compose run --rm --no-deps --entrypoint node api apps/cli/dist/src/index.js init
```

```sh
docker compose up -d api
```

5. Check out the same release on the operator workstation, rebuild the dashboard, and repeat the upload command from step 6.
6. Verify both the API and dashboard:

```sh
curl --fail --silent --show-error https://incidentiq.example.com/v1/health/ready
```

```sh
curl --fail --silent --show-error https://incidentiq.example.com/ | grep -q '<title>IncidentIQ</title>'
```

If the new API fails before migrations have made incompatible changes, restore the previous image tag and restart it. Rebuild and upload the dashboard from that same previous release. If a migration has run, restore the database backup instead of assuming a downgrade is safe.

## Current production limits

The current release deliberately supports one API process and PostgreSQL. Key lifecycle, dry-run retention, request limits, and bounded AI usage are available, but their rate counters are process-local. It does not yet include a durable ingestion queue, active-active replicas, distributed quotas, or bundled dashboard hosting. The dashboard remains a separate static build; see the [dashboard guide](../dashboard.md) and [operations guide](../operations.md).
