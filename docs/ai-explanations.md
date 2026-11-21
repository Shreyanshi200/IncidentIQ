# Evidence-bounded AI explanations

IncidentIQ can optionally ask OpenAI to turn one saved incident into a cited explanation and investigation plan. This is an operator-requested second opinion: deterministic correlation still creates the incident, ranks candidate causes, and remains available when AI is disabled or unavailable.

## Enable it locally

Create an OpenAI API key in your own OpenAI project. Add both server-only values to the repository `.env` file:

```text
OPENAI_API_KEY=<your-openai-api-key>
INCIDENTIQ_AI_MODEL=gpt-6-luna
```

Restart the API after changing `.env`:

```sh
pnpm api
```

Open an incident in the dashboard and select **Generate AI explanation**. IncidentIQ calls the model only after this explicit action. A successful result is cached with that incident, appears after refresh, and is included in later PDF reports. When new evidence changes the incident, the cached explanation is removed so it cannot silently describe an older timeline.

By default, IncidentIQ requests low reasoning effort, allows at most 8,000 output tokens, and rejects incident input larger than 512 KiB. Timeout, input size, output budget, hourly requests, timeline size, and reasoning effort are bounded operator settings documented in the [operations guide](operations.md). Provider failures are shown without exposing the API key: invalid credentials, unavailable model access, quota or spend limits, rate limits, timeouts, refusals, and exhausted output budgets produce distinct messages.

## Thorough local test

The test pack deliberately covers four different investigations. It is more useful than repeating one obvious failure because a safe analyst must explain strong evidence, competing evidence, and uncertainty differently.

### 1. Start with a clean tenant

This optional command permanently removes the `local` tenant's saved incidents and source events. It preserves API keys and schema migrations, so your existing ingestion key, read key, and browser session continue to work:

```sh
pnpm incidentiq data clear --tenant local --confirm
```

Skip this step if the database contains evidence you want to keep.

### 2. Load and save the four investigations

Each fixture must first load its source events and then save its deterministic investigation.

Release regression:

```sh
pnpm incidentiq fixture load demo/fixtures/production-checkout-regression.json
```

```sh
pnpm incidentiq correlate demo/fixtures/production-checkout-regression.json --save
```

Downstream payment cascade:

```sh
pnpm incidentiq fixture load demo/fixtures/downstream-cascade.json
```

```sh
pnpm incidentiq correlate demo/fixtures/downstream-cascade.json --save
```

Resource exhaustion:

```sh
pnpm incidentiq fixture load demo/fixtures/resource-exhaustion.json
```

```sh
pnpm incidentiq correlate demo/fixtures/resource-exhaustion.json --save
```

Ambiguous release versus node pressure:

```sh
pnpm incidentiq fixture load demo/fixtures/ambiguous-failure.json
```

```sh
pnpm incidentiq correlate demo/fixtures/ambiguous-failure.json --save
```

Confirm that exactly these four saved investigations are available:

```sh
pnpm incidentiq incidents list --tenant local
```

### 3. Start the product

Start the API in one terminal after setting the OpenAI values:

```sh
pnpm api
```

Start the dashboard in another terminal:

```sh
pnpm dashboard
```

Open `http://localhost:5173`. Use your existing read key or browser session. If neither is available, create a new read key:

```sh
pnpm incidentiq keys create --scope read --tenant local --label local-ai-review
```

### 4. Generate and review each explanation

Open each investigation and select **Generate AI explanation**. The expected behavior is:

| Investigation | Deterministic result | What a useful AI review should add | What it must not claim |
| --- | --- | --- | --- |
| `production-checkout-regression` | Bad release, high confidence | Connect version `3.4.0`, the first failing checkout route, rollout degradation, rollback, and recovery into one concise sequence | That the commit is proven causal or that customer impact is known |
| `downstream-cascade` | Downstream timeout, high confidence | Follow the two shared traces from `payments-api` into `checkout-api`, notice healthy pods, and use provider recovery plus alert resolution as supporting context | That Kubernetes or a checkout deployment caused the failure |
| `resource-exhaustion` | Resource exhaustion, high confidence | Relate rising memory, stable request rate, exit code `137`, restart, and post-restart recovery; recommend heap and allocation checks | That a memory leak is proven without a heap profile |
| `ambiguous-failure` | Ambiguous, low confidence | Keep release regression and node pressure as competing hypotheses and identify the evidence needed to separate them | A definite root cause or invented logs, metrics, and deployment changes |

For every result, verify all of the following:

- every cited event ID exists in the visible timeline;
- observations, hypotheses, and limitations are clearly separated;
- next checks are specific to the recorded service, version, trace, route, pod, or node;
- no secret, API key, database credential, or evidence from another incident appears; and
- refreshing the page shows the same cached explanation and generation timestamp instead of silently generating another one.

Finally, download each incident report. The PDF should include the cited AI review as an optional section while retaining the deterministic ranking and full evidence timeline.

The ambiguous scenario is the most important safety test. A longer answer is not necessarily better: the correct behavior is to preserve uncertainty and ask for discriminating evidence.

For a much harder 40-event, multi-service investigation, follow the [payment-pool cascade deep-dive](ai-deep-dive.md).

## What is sent

One request contains only the selected tenant-scoped incident:

- service, environment, incident timestamps, and deterministic ranking;
- the deterministic brief and next checks; and
- the linked timeline, including its already-redacted event attributes.

The OpenAI key, IncidentIQ ingestion and read keys, database credentials, session cookie, and evidence from other incidents or tenants are not included. The Responses API request sets `store: false`. OpenAI still processes the supplied operational evidence, so enable this feature only when your organization's data policy permits that processing.

Do not place secrets in event attributes. IncidentIQ redacts configured secret-like field names at ingestion, but no field-name filter can identify every sensitive value chosen by an application.

## Evidence boundary

The model receives no tools and cannot query your infrastructure. Its structured response must provide:

- a concise hypothesis and confidence basis;
- cited observations;
- cited investigation checks; and
- explicit limitations.

Every claim and check must cite event IDs present in the selected incident. The API rejects malformed output and citations to unknown event IDs rather than displaying or saving them. A valid citation proves only that the model referenced stored evidence; it does not prove that the model's interpretation or proposed cause is correct.

## Production configuration

Keep `OPENAI_API_KEY` in the API server's secret manager, never in the dashboard build or a producer. Set `INCIDENTIQ_AI_MODEL` explicitly so model and cost changes are deliberate. Configure the bounded AI controls through the variables in the [operations guide](operations.md), then restart the API after changing any of them.

If either value is absent, the dashboard shows **AI not configured** and all deterministic investigation features continue to work. Provider errors also leave the stored incident unchanged.

## Current boundaries

- OpenAI's Responses API is the only supported provider in this release.
- Generation is manual and cached; there is no automatic per-incident spend.
- Input size, output tokens, request duration, timeline size, and per-process hourly generations are bounded.
- AI does not change candidate scores, incident grouping, or raw evidence.
- AI does not run commands, deploy changes, or remediate production systems.
- Usage counters are process-local and reset when the supported single API process restarts; they are operational limits, not billing controls.

The integration uses OpenAI Structured Outputs through the Responses API. See the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs) and [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create) for the upstream contract.
