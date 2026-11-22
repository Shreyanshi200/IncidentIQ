# AI investigation deep-dive

Use this test when the four focused fixtures in the [AI explanation guide](ai-explanations.md) are no longer challenging enough. It contains 40 ordered events across `checkout-api` and `payments-api`, four evidence sources, five shared traces, misleading checkout resource symptoms, and separate checkout and payments rollbacks.

This is a curated unified investigation. Automatic incident records stay local to one tenant, environment, and service, while IncidentIQ now presents a unified view when shared traces or explicit dependency failures link them. This workflow tests correlation, investigation presentation, reporting, and AI reasoning without claiming that it can infer an arbitrary dependency graph.

## 1. Optionally clear the test tenant

This permanently removes only `cross-service-test` incidents and evidence. It preserves API keys and migrations.

```sh
pnpm incidentiq data clear --tenant cross-service-test --confirm
```

## 2. Ingest the evidence

```sh
pnpm incidentiq fixture ingest demo/fixtures/production-payment-pool-cascade.json --tenant cross-service-test
```

This requires the API to be running and `INCIDENTIQ_API_KEY` to contain an active ingestion key for tenant `cross-service-test`. Follow the key setup in the [cross-service correlation guide](cross-service-correlation.md#test-locally) if needed.

```sh
pnpm incidentiq incidents list --tenant cross-service-test
```

The list should contain separate automatic incidents for `checkout-api` and `payments-api`; the dashboard joins them only through recorded cross-service evidence.

## 3. Investigate before using AI

Open either production incident in the dashboard. Read the Analysis and Evidence tabs and record your own leading hypothesis before selecting **Generate AI explanation**.

The deterministic result should rank **downstream timeout** with high confidence. Checkout deployment timing, CPU and memory pressure, pod failures, and the payments deployment should remain visible as competing clues.

## 4. Evaluate the AI review

A useful review should:

- identify the `payments-api` database-pool configuration change as the leading but still unproven hypothesis;
- cite the payments release, pool saturation, shared payment-to-checkout traces, ineffective checkout rollback, and recovery after the payments rollback;
- treat checkout CPU, memory, restart, and crash-loop signals as likely secondary symptoms;
- use the healthy external-provider observation as evidence against a provider outage; and
- request database metrics, query logs, connection-lifecycle evidence, and the actual configuration diff before claiming root cause.

It must not claim that checkout version `3.5.0` caused every failure, invent customer impact, cite absent evidence, or describe the pool regression as proven.

## 5. Verify the evidence boundary

Check every cited event ID against the Evidence tab. Confirm that competing evidence and missing information remain explicit. Refresh the page to verify that the valid explanation is cached, then download the PDF and confirm that it contains the same bounded assessment as a concise summary. Exact citations remain in the dashboard and are not repeated throughout the report.

This scenario tests more than log summarization: the platform must follow propagation across services, use a failed rollback as counterevidence, keep plausible alternatives visible, and distinguish recovery correlation from causal proof.
