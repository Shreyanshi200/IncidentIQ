# IncidentIQ

Evidence-first production incident investigation, starting as a CLI and local demo.

```text
apps/cli/                       CLI commands and PostgreSQL access
packages/event-schema/          Versioned shared contracts
packages/correlation/           Deterministic, inspectable cause ranking
infrastructure/postgres/        Shared database migrations
demo/fixtures/                  Repeatable incident scenarios
```

## Version 0.0.3

The project is TypeScript on Node.js. It validates versioned contracts, stores normalized events in PostgreSQL, and deterministically ranks fixture evidence before any AI is introduced.

```sh
cp .env.example .env
docker compose up -d postgres

pnpm test
pnpm incidentiq version
pnpm incidentiq init
pnpm incidentiq fixture validate demo/fixtures/deployment-regression.json
pnpm incidentiq fixture load demo/fixtures/deployment-regression.json
pnpm incidentiq events list
pnpm incidentiq correlate demo/fixtures/deployment-regression.json
```

`fixture load` is idempotent: loading the same fixture twice never duplicates source events. `correlate` returns a timeline, ranked causes, score factors, and a confidence band without storing an investigation.
