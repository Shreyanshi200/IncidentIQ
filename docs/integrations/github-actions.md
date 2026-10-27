# GitHub Actions integration

The IncidentIQ Action records one deployment event with GitHub's repository, commit, workflow, run, and actor metadata. It is deliberately fail-open: an export problem logs a warning but does not fail your deployment job.

## Prerequisites

1. Start or deploy an IncidentIQ API as described in [Getting started](../getting-started.md).
2. Ensure the API is reachable from the GitHub runner over HTTPS. `localhost` cannot be reached by GitHub-hosted runners.
3. Create an ingestion key with `pnpm incidentiq keys create --scope ingest`.
4. In your repository's **Settings → Secrets and variables → Actions**, create:
   - Secret `INCIDENTIQ_API_KEY`: the raw `iiq_...` ingestion key.
   - Variable `INCIDENTIQ_API_URL`: the API base URL, for example `https://incidentiq.example.com`.

For a temporary local test, a Cloudflare quick tunnel can provide the HTTPS URL. Do not use a quick tunnel for production.

## Add the Action to a deployment workflow

For an Action installed from this repository, pin the complete commit SHA until a released version tag is available:

```yaml
- name: Record deployment context in IncidentIQ
  if: always()
  uses: Shreyanshi200/IncidentIQ/integrations/github-action@<full-commit-sha>
  with:
    api-key: ${{ secrets.INCIDENTIQ_API_KEY }}
    api-url: ${{ vars.INCIDENTIQ_API_URL }}
    tenant-id: local
    service: orders
    environment: production
    deployment-status: ${{ job.status }}
```

After `v0.3.0` is released, replace the commit SHA with `v0.3.0`. Pinning a full commit SHA is safest for production workflows.

The Action needs a checkout only when you run the local copy inside this repository:

```yaml
- uses: actions/checkout@v4

- uses: ./integrations/github-action
  with:
    api-key: ${{ secrets.INCIDENTIQ_API_KEY }}
    api-url: ${{ vars.INCIDENTIQ_API_URL }}
    tenant-id: local
    service: demo-service
    environment: staging
    deployment-status: success
```

## Inputs

| Input | Required | Meaning |
| --- | --- | --- |
| `api-key` | Yes | IncidentIQ ingestion key. Keep it in a GitHub secret. |
| `api-url` | Yes | Public base URL of the IncidentIQ API. Do not add `/v1/events/batch`. |
| `tenant-id` | Yes | Must match the tenant assigned to the key. Current CLI-created keys use `local`. |
| `service` | Yes | Your stable deployable-service name, such as `orders`. |
| `environment` | Yes | Your target environment, such as `production` or `staging`. |
| `deployment-status` | No | `success` by default. `failure`, `failed`, and `cancelled` become error-severity events. |

## Verify the integration

The Action log should contain:

```text
IncidentIQ recorded deployment context for orders
```

That log is printed only after the API accepts the event. You can also verify storage from an operator checkout connected to the same database:

```sh
pnpm incidentiq events list
```

Look for `source: "github_actions"` and `event_type: "deployment"`. The record's `attributes` include the GitHub repository, commit SHA, ref, workflow, run ID, run URL, attempt, and actor.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `api-key is required` | Ensure the key is in the **Secrets** tab, named `INCIDENTIQ_API_KEY`, and referenced as `${{ secrets.INCIDENTIQ_API_KEY }}`. |
| `api-url is required` | Add repository variable `INCIDENTIQ_API_URL`; include `https://` and only the API base URL. |
| Action logs a warning but deployment stays green | Expected fail-open behavior. Check API reachability, the key, tenant ID, and API logs. |
| No event appears | Check for the Action warning, then confirm API reachability, the key, tenant ID, and that `pnpm incidentiq events list` targets the same database. |
