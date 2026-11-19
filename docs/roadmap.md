# Release roadmap

IncidentIQ is currently a single-operator, self-hosted incident intelligence platform. Version 0.7.1 is the latest completed product release; completed changes are listed in the [changelog](../CHANGELOG.md).

## Planned releases

| Version | Outcome |
| --- | --- |
| 0.8.0 | Evidence-bounded AI explanations and suggested next investigation steps, grounded only in stored evidence |
| 0.8.1 | Operational polish: safer API-key handling, retention controls, cost controls, and production guardrails |
| 0.9.0 | ClickHouse as an optional scalable store for historical evidence and investigations |
| 0.9.1 | Kafka-based streaming ingestion for high-volume, near-real-time evidence delivery |
| 1.0.0 | Stable single-operator release with clear setup, reliable integrations, operating guidance, and documented compatibility boundaries |

The current PostgreSQL path remains the default while it is sufficient. Kafka and ClickHouse will be introduced as scale choices, not mandatory dependencies for every installation.

## Future extensibility

These are possible expansion areas rather than commitments to the current MVP:

- multi-user authentication, organizations, roles, and audit history;
- incident acknowledgement, assignment, resolution, and time-bounded suppression;
- notifications and workflow integrations such as Slack, PagerDuty, and Jira;
- managed collector configuration, API-key rotation, and organization-wide policies;
- cluster-wide and multi-cluster Kubernetes collection;
- dependency graphs and cross-service incident grouping; and
- a managed IncidentIQ offering alongside self-hosted deployment.

## Product principles

- Preserve raw source evidence and make every conclusion traceable.
- Keep deterministic behavior available even when AI explanations are added.
- Require explicit infrastructure choices only when user scale justifies them.
- Keep integrations fail-open so observability failures do not break production workloads or deployments.
- Treat rankings and AI output as investigation guidance, not proof of root cause.
