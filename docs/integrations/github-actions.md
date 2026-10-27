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

## Production deployment pattern

The `feat/github-actions-context` branch was only a one-time smoke test. A typical production flow is:

```text
feature branch → pull request checks → merge to main → deploy staging
release tag vX.Y.Z → approval → deploy production
```

The IncidentIQ Action is cloud-provider agnostic. GitHub Actions can deploy an Azure App Service, Azure Container App, AKS workload, AWS service, Google Cloud service, DigitalOcean service, or self-hosted target. The provider-specific deployment step performs the deployment; the IncidentIQ Action runs after it and records the result. Keep the IncidentIQ step in the same job and run it even when deployment fails:

```yaml
on:
  push:
    branches: [main]

jobs:
  deploy-staging:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v4

      # Authenticate to Azure and deploy your application here.
      - name: Deploy to Azure
        run: ./scripts/deploy-azure.sh staging

      - name: Record deployment context
        if: always()
        uses: Shreyanshi200/IncidentIQ/integrations/github-action@<full-commit-sha>
        with:
          api-key: ${{ secrets.INCIDENTIQ_API_KEY }}
          api-url: ${{ vars.INCIDENTIQ_API_URL }}
          tenant-id: local
          service: orders
          environment: staging
          deployment-status: ${{ job.status }}
```

Use a separate production workflow triggered by release tags and protected with a GitHub Environment approval. Prefer Azure OpenID Connect credentials over a long-lived Azure password or client secret.

### What a production team needs

- A stable IncidentIQ API HTTPS URL, rather than a temporary tunnel.
- PostgreSQL for the IncidentIQ API.
- An ingestion key stored as a GitHub Actions secret and an API URL stored as a variable; environment-scoped secrets are preferable for production.
- A matching `tenant-id`, `service`, and `environment` in the workflow.
- A pinned IncidentIQ Action commit SHA or released tag.
- Network access from the GitHub runner to both Azure and the IncidentIQ API. If either service is private, use an appropriately networked self-hosted runner or private connectivity.

IncidentIQ observes the Azure deployment; it does not replace the Azure deployment action or manage Azure credentials.

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
