# Dashboard

The IncidentIQ dashboard is a separate React application in `apps/dashboard`. It shows which services, environments, and evidence sources have reached IncidentIQ. Incident timelines and filters are intentionally planned for the next dashboard release.

## Security model

The static dashboard files have no embedded API key or tenant data. The page sends the operator's separate `read` key once to `POST /v1/dashboard/session`. The API validates the key and returns an eight-hour session cookie with `HttpOnly` and `SameSite=Strict`; production HTTPS also adds `Secure`.

The raw read key is not stored in browser storage. JavaScript cannot read the session cookie, a refresh can safely restore the dashboard, and signing out clears the cookie. Revoking the underlying read key also invalidates its sessions.

Never paste an `ingest` key into the dashboard. An ingestion key can write events; a read key can only load the dashboard overview.

The server's `INCIDENTIQ_SESSION_SECRET` is different from both API keys. It signs browser cookies, stays only on the API server, and is never pasted into the dashboard.

| Credential | Created with | Used by | Stored where |
| --- | --- | --- | --- |
| Ingestion key (`iiq_...`) | `keys create --scope ingest` | SDKs and integrations that send evidence | Producer secret manager; only its hash is in IncidentIQ |
| Read key (`iiq_...`) | `keys create --scope read` | Operator opening the dashboard | Operator password manager; only its hash is in IncidentIQ |
| Session secret | `openssl rand -base64 48` | API signing dashboard cookies | API server environment only |

## Run it locally

Complete the [getting-started setup](getting-started.md) first. PostgreSQL and the API must be running.

In one terminal, start the API:

```sh
pnpm api
```

In a second terminal, create a read-only key. Copy the `iiq_...` value when it is printed; it cannot be shown again.

```sh
pnpm incidentiq keys create --scope read
```

In a third terminal, start the dashboard development server:

```sh
pnpm dashboard
```

Open this address in your browser:

```text
http://localhost:5173
```

Paste the read key and select **Open dashboard**. The dashboard development server proxies `/v1` requests to `http://localhost:3000`, so the API and dashboard work together without enabling browser CORS. Refreshing the page restores the secure session for up to eight hours; **Sign out** ends it immediately.

For local use, `INCIDENTIQ_SESSION_SECRET` is optional. If it is unset, the API creates a temporary secret at startup, so restarting the API signs out existing dashboard sessions.

## What the overview means

- **Services** groups accepted evidence by stable service name. It lists each environment, source, event count, and most recent event time.
- **Environments** counts the services and evidence recorded for each environment.
- **Connected sources** shows the integrations that have actually delivered at least one event, such as `node_sdk`, `github_actions`, `kubernetes`, or `alertmanager`.

If a section is empty, IncidentIQ has not received matching evidence for that tenant yet. Send test events through one of the integration guides, then select **Refresh**.

## Deploy it with the production API

Build the static files from the same released repository version as the API:

```sh
pnpm --filter @incidentiqhq/dashboard build
```

The generated files are in `apps/dashboard/dist`. Serve those files from the same HTTPS hostname as the API and proxy `/v1` to the API container. Keeping both on one origin avoids CORS configuration and lets the dashboard use the protected overview endpoint safely.

Follow the [production API deployment guide](deployment/api-production.md#6-deploy-the-dashboard) for the exact upload, Nginx, read-key, verification, upgrade, and rollback steps.
