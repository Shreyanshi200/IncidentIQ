# AI investigation deep-dive

Use this test when the four focused fixtures in the [AI explanation guide](ai-explanations.md) are no longer challenging enough. It contains 40 ordered events across `checkout-api` and `payments-api`, four evidence sources, five shared traces, misleading checkout resource symptoms, and separate checkout and payments rollbacks.

This is a curated unified investigation. Automatic incident grouping currently works within one tenant, service, and environment; dependency-aware discovery and merging are planned for v0.8.2. This workflow tests correlation, investigation presentation, reporting, and AI reasoning without claiming that dependency-wide discovery is already automatic.

## 1. Optionally clear the local tenant

This permanently removes only `local` incidents and evidence. It preserves API keys and migrations. Skip it when the database contains evidence you need.

```sh
pnpm incidentiq data clear --tenant local --confirm
```

## 2. Load and correlate the evidence

```sh
pnpm incidentiq fixture load demo/fixtures/production-payment-pool-cascade.json
```

```sh
pnpm incidentiq correlate demo/fixtures/production-payment-pool-cascade.json --save
```

```sh
pnpm incidentiq incidents list --tenant local
```

The saved incident ID should be `production-payment-pool-cascade`.

## 3. Investigate before using AI

Open the incident in the dashboard. Read the Analysis and Evidence tabs and record your own leading hypothesis before selecting **Generate AI explanation**.

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

Check every cited event ID against the Evidence tab. Confirm that competing evidence and missing information remain explicit. Refresh the page to verify that the valid explanation is cached, then download the PDF and confirm the same bounded assessment and citations appear there.

This scenario tests more than log summarization: the platform must follow propagation across services, use a failed rollback as counterevidence, keep plausible alternatives visible, and distinguish recovery correlation from causal proof.
