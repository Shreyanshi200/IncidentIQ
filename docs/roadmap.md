# Release roadmap

IncidentIQ is currently a single-operator, self-hosted incident intelligence platform. Version 0.9.0 is the latest completed product release. Completed changes are listed in the [changelog](../CHANGELOG.md).

## Planned releases

| Version | Outcome |
| --- | --- |
| 0.9.1 | Kafka-based streaming ingestion for high-volume, near-real-time evidence delivery |
| 1.0.0 | Stable single-operator release with clear setup, reliable integrations, operating guidance, and documented compatibility boundaries |

The current PostgreSQL path remains the default while it is sufficient. ClickHouse was introduced in v0.9.0 and Kafka remains planned as an optional scale choice; neither is mandatory for every installation.

## Recently completed

### v0.9.0 — ClickHouse hot/cold tiering

- Kept PostgreSQL as the transactional operational store and default deployment.
- Added an optional ClickHouse archive for redacted source events and current incident snapshots.
- Delivered archive work through a durable PostgreSQL outbox so ClickHouse downtime does not reject ingestion or lose accepted evidence.
- Added positive archive confirmation before deletion, configurable automatic PostgreSQL hot retention, and archive/tiering state in the dashboard.
- Added a tenant-scoped, read-only dashboard for filtering and inspecting archived ClickHouse incident snapshots without mixing them into active PostgreSQL results.
- Added explicit backfill, queue-status, local testing, retention-boundary, and production configuration guidance.

## Future extensibility

These are possible expansion areas rather than commitments to the current MVP:

- multi-user authentication, organizations, roles, and audit history;
- incident acknowledgement, assignment, resolution, and time-bounded suppression;
- notifications and workflow integrations such as Slack, PagerDuty, and Jira;
- managed collector configuration and organization-wide policies;
- cluster-wide and multi-cluster Kubernetes collection;
- a managed IncidentIQ offering alongside self-hosted deployment.

## Product principles

- Preserve raw source evidence and make every conclusion traceable.
- Keep deterministic behavior available even when AI explanations are added.
- Require explicit infrastructure choices only when user scale justifies them.
- Keep integrations fail-open so observability failures do not break production workloads or deployments.
- Treat rankings and AI output as investigation guidance, not proof of root cause.
