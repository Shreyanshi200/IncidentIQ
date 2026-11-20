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

IncidentIQ requests low reasoning effort with an 8,000-token output ceiling. This leaves room for reasoning plus the validated structured response while keeping the operator-triggered request bounded. Provider failures are shown without exposing the API key: invalid credentials, unavailable model access, quota or spend limits, rate limits, timeouts, refusals, and exhausted output budgets produce distinct messages.

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
pnpm incidentiq keys create --scope read
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

## Deep-dive stress scenario

Use this scenario when you want a substantially harder investigation than the four focused fixtures. It contains 40 ordered events across `checkout-api` and `payments-api`, four evidence sources, five shared traces, misleading checkout resource symptoms, and two separate rollbacks.

The fixture is a curated multi-service investigation. IncidentIQ's automatic incident grouping currently groups activity by tenant, service, and environment; it does not yet discover and merge an arbitrary cross-service incident by itself. Loading and saving this fixture tests correlation, investigation presentation, reporting, and AI reasoning over a realistic unified evidence set without claiming that cross-service discovery is already automatic.

For the cleanest comparison, first clear the local tenant. This is optional and permanently removes only that tenant's evidence and incidents; it preserves keys and migrations:

```sh
pnpm incidentiq data clear --tenant local --confirm
```

Load the complete evidence set:

```sh
pnpm incidentiq fixture load demo/fixtures/production-payment-pool-cascade.json
```

Run deterministic correlation and save the investigation:

```sh
pnpm incidentiq correlate demo/fixtures/production-payment-pool-cascade.json --save
```

Confirm that it was saved:

```sh
pnpm incidentiq incidents list --tenant local
```

Before opening **AI Review**, inspect the Analysis and Evidence tabs and write down your own leading hypothesis. The deterministic result should be **downstream timeout** with high confidence. Several alternatives remain visible because the checkout release, checkout CPU and memory pressure, pod failures, and a payments deployment are all plausible at first glance.

A strong AI review should:

- identify the `payments-api` database-pool configuration change as the leading, still-unproven hypothesis;
- cite the payments release, pool saturation and runtime sample, shared payment-to-checkout traces, ineffective checkout rollback, and recovery after the payments rollback;
- treat checkout CPU, memory, restart, and crash-loop signals as likely secondary symptoms rather than the initiating failure;
- use the healthy external-provider observation as evidence against a provider outage; and
- state that database-server metrics, query logs, connection-lifecycle evidence, and the actual configuration diff would still be needed to establish root cause.

It must not claim that checkout version `3.5.0` caused the incident merely because it deployed first, invent a customer-impact figure, cite absent evidence, or describe the database-pool regression as proven. Compare its event-ID citations with the Evidence tab, then download the report and confirm the same bounded reasoning appears there.

This scenario answers a harder question than “can the model summarize logs?”: can the platform keep competing evidence visible, follow propagation across services, use a failed rollback as counterevidence, and distinguish recovery correlation from causal proof?

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

Keep `OPENAI_API_KEY` in the API server's secret manager, never in the dashboard build or a producer. Set `INCIDENTIQ_AI_MODEL` explicitly so model and cost changes are deliberate. Restart the API after rotating the key or changing the model.

If either value is absent, the dashboard shows **AI not configured** and all deterministic investigation features continue to work. Provider errors also leave the stored incident unchanged.

## Current boundaries

- OpenAI's Responses API is the only supported provider in this release.
- Generation is manual and cached; there is no automatic per-incident spend.
- AI does not change candidate scores, incident grouping, or raw evidence.
- AI does not run commands, deploy changes, or remediate production systems.
- Retention controls, request budgets, and broader operational guardrails are planned for v0.8.1.

The integration uses OpenAI Structured Outputs through the Responses API. See the official [Structured Outputs guide](https://developers.openai.com/api/docs/guides/structured-outputs) and [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create) for the upstream contract.
