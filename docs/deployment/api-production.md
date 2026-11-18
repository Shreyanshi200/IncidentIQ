# Production API deployment

This guide deploys the IncidentIQ API on one Linux host with Docker, a PostgreSQL database, a DNS name, and an HTTPS reverse proxy. It is cloud-neutral: the host and PostgreSQL database can be on AWS, Azure, GCP, DigitalOcean, or your own infrastructure.

This is the appropriate production shape for the current single-operator MVP. It is not yet an active-active, multi-region deployment.

## What you need

- a released, immutable API image from GitHub Container Registry;
- a PostgreSQL database reachable only from the API host or private network;
- a Linux host with Docker Compose v2 and a reverse proxy such as Nginx;
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
- `DATABASE_URL` — the real PostgreSQL connection string, including the provider's TLS settings; and
- `PORT` — normally leave this as `3000`.

Keep `.env` readable only by the deployment operator. It contains the database password.

```sh
chmod 600 ~/incidentiq-production/.env
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

## 3. Create and store an ingestion key

Create one ingestion key for your integrations:

```sh
docker compose run --rm --no-deps --entrypoint node api apps/cli/dist/src/index.js keys create --scope ingest
```

The raw `iiq_...` key is printed once. Save it immediately in your secret manager, then add it as a secret in GitHub Actions, Kubernetes, or Alertmanager. IncidentIQ stores only its hash.

Do not put this key in application source code, a committed `.env` file, or a shell history command.

## 4. Start the API and verify it locally

```sh
docker compose up -d api
```

```sh
docker compose ps
```

```sh
curl --fail --silent --show-error http://127.0.0.1:3000/v1/health
```

Expected output:

```json
{"status":"ok"}
```

The compose configuration binds port `3000` only to `127.0.0.1`. It is therefore reachable by a reverse proxy on the same host but not directly from the internet.

## 5. Put HTTPS in front of the API

Create DNS for your chosen hostname, obtain a trusted TLS certificate, then configure your reverse proxy to forward requests to the loopback-bound container.

For Nginx, the relevant virtual-host content is:

```nginx
server {
    listen 443 ssl http2;
    server_name incidentiq.example.com;

    ssl_certificate     /etc/letsencrypt/live/incidentiq.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/incidentiq.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Your platform may provide an ingress controller, load balancer, or managed HTTPS endpoint instead of Nginx. The important properties are the same:

- public traffic reaches `https://incidentiq.example.com` on port 443;
- the proxy forwards to `http://127.0.0.1:3000` or the equivalent private service address;
- port 3000 is not publicly reachable; and
- PostgreSQL accepts connections only from IncidentIQ's private network.

Verify the public endpoint after the proxy and certificate are ready:

```sh
curl --fail --silent --show-error https://incidentiq.example.com/v1/health
```

Use this complete HTTPS base URL as `INCIDENTIQ_API_URL` in the GitHub Actions, Kubernetes, and Alertmanager integration guides. The Alertmanager receiver URL must include `/v1/integrations/alertmanager`.

## 6. Connect integrations

All current integrations authenticate with the ingestion key created above.

| Producer | Configure with |
| --- | --- |
| GitHub Actions | Repository secret `INCIDENTIQ_API_KEY` and repository variable `INCIDENTIQ_API_URL=https://incidentiq.example.com` |
| Kubernetes collector | Kubernetes Secret named `incidentiq` with `api-key`, plus `INCIDENTIQ_API_URL=https://incidentiq.example.com` |
| Alertmanager | Receiver URL `https://incidentiq.example.com/v1/integrations/alertmanager` and an `Authorization: Bearer iiq_...` header |
| Node.js SDK | `INCIDENTIQ_API_URL=https://incidentiq.example.com` and its ingestion key after the SDK has been published to npm |

Follow the individual integration guides for labels, RBAC, and test commands.

## Operations checklist

Before accepting production events, verify all of the following:

- [ ] The API health endpoint succeeds through the public HTTPS hostname.
- [ ] The database is private, encrypted in transit, and backed up.
- [ ] The `.env` file and the ingestion key are held only in approved secret storage.
- [ ] The host firewall permits public port 443 only; port 3000 is loopback-only.
- [ ] You deployed an immutable image tag, not `latest`.
- [ ] At least one producer has sent an event and `events list` (or direct database inspection) confirms it was stored.
- [ ] The GitHub Actions, Kubernetes, and Alertmanager values use the HTTPS hostname rather than a temporary development tunnel.

## Backups and recovery

Use automated backups from your managed PostgreSQL provider where available. If you operate PostgreSQL yourself, schedule encrypted backups and test restoration regularly. A manual PostgreSQL backup from a trusted operator host looks like:

```sh
pg_dump --format=custom --file=incidentiq-$(date +%F).dump "$DATABASE_URL"
```

Store backups away from the API host. Database backups contain recorded evidence and API-key hashes, so protect them as sensitive operational data.

For recovery, restore a known-good PostgreSQL backup, start the API with its matching or newer compatible image, then verify `/v1/health`. Do not assume a database migration can be rolled back automatically.

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

```sh
curl --fail --silent --show-error https://incidentiq.example.com/v1/health
```

If the new API fails before migrations have made incompatible changes, restore the previous image tag and restart it. If a migration has run, restore the database backup instead of assuming a downgrade is safe.

## Current production limits

The current release deliberately keeps operations simple. It has one API process and PostgreSQL, but not yet API-key rotation tooling, rate limiting, a durable ingestion queue, active-active replicas, or a dashboard. Plan capacity and incident response around those boundaries until the relevant roadmap versions land.
