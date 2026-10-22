# IncidentIQ

Evidence-first production incident investigation, starting as a CLI and local demo.

```text
apps/cli/                       CLI commands and PostgreSQL access
packages/event-schema/          Versioned shared contracts
packages/correlation/           Deterministic, inspectable cause ranking
infrastructure/postgres/        Shared database migrations
demo/fixtures/                  Repeatable incident scenarios
```

## Version 0.0.4

The project is TypeScript on Node.js. It validates versioned contracts, stores normalized events in PostgreSQL, and presents deterministic fixture investigations in a reviewer-friendly CLI before any AI is introduced.

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
pnpm incidentiq correlate demo/fixtures/deployment-regression.json --save
pnpm incidentiq incidents list
pnpm incidentiq incidents explain deployment-regression
pnpm incidentiq incidents export deployment-regression --format json
```

`fixture load` is idempotent: loading the same fixture twice never duplicates source events. `correlate` returns plain-text timeline, ranked causes, score factors, and next checks. Add `--save` to persist an investigation for listing, explanation, or JSON export.
