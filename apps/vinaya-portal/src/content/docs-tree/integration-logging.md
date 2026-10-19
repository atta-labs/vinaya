# Logging — Vinaya

Summary: How the Vinaya process fulfils Dev Process logging: what it supplies, where its events go, the header every event carries, each event type mapped to its generic family, and the generic families it has no event of its own for.
Parent: Integration
Badges: Fixed event types · Live delivery · Generic mapping · Gaps named

## About Vinaya's logging

This page answers the generic [Logging](/docs/dev-process/logging) for the Vinaya process. Every event, field by field, is in the [Vinaya Log event reference](/docs/process/events).

Vinaya's event types are fixed. Configuration says where events go and lets a team add its own [custom events](/docs/features/log/custom-events) (`logs.events`); it cannot change Vinaya's. [Studio](/docs/features/studio), [Telemetry](/docs/features/telemetry) and [Self-improvement](/docs/features/self-improvement) read these events.

## What Vinaya supplies, and what it does not

| Concern | Who |
| --- | --- |
| Event families and meaning | Harness, fixed |
| Destination (`logs`: folder or url) | The team, in Configuration |
| Identities and payloads for each event | Vinaya |
| Its own namespaced events | Vinaya: `vinaya.planning.*`, `vinaya.closeout.*` |
| Gate results | Vinaya's 37 checks write `gate` events, mapped to `gate.evaluated` |

## Where events go

- Every event is delivered live, as it happens, to the destination in `logs`: a folder or a server. By default, `<runtimeDir>/logs/`, one file per task.
- Never to GitHub: no Issue or pull-request comment, no CI artifact.
- Never control state: the Log never authorizes or resumes a run.
- A secret-shaped value is redacted, and a home path rewritten, before an event is written. See [Redaction and trust](/docs/features/log/redaction-and-trust).

## What every event carries

| Field | Meaning | Generic field |
| --- | --- | --- |
| `meta.ts`, `meta.seq`, `event_id` | When, order, identity | `event_id`, `timestamp` |
| `meta.run_id`, `lineage.run`, `lineage.attempt`, `lineage.parent` | Run, attempt, the event it continues (`lineage.attempt` is the dispatch attempt, from `VINAYA_ATTEMPT`; `lineage.parent` is planned) | `run_id`, `attempt`, `correlation_id` |
| `flow.id`, `flow.version`, `meta.vinaya`, `meta.doctrine` | Process and versions (`flow.id` is `vinaya`) | `process_id`, `process_version` |
| `input_versions` | Brief digest, objectives version, ruling ordinal, policy digest | `intent_version`, `policy_version` |
| `work.ref`, `subject.issue` | The task | `intent_id` |
| `work.repo`, `work.change`, `work.revision`, `subject.pr`, `subject.sha` | Repository, pull request, commit (`work.change` is the pull request when `VINAYA_PR` is set; `work.revision` and `subject.sha` are the commit, set on gate events only, and in pull-request CI it is the merge commit) | `change_id`, `head_revision` |
| `subject.role`, `actor_id` | Who acted | `actor` |
| `meta.host`, `runtime`, `source`, `meta.machine` | Where it ran: hook, CI, CLI or loop; the runtime; a hashed machine | `source_system` |
| `provenance` | `parent_attributed`, `env_correlated`, `self_reported` or `unavailable` (role dispatch writes `parent_attributed` for its own events; others write `env_correlated` or `unavailable`; `self_reported` is planned) | provenance strength |

## The event types

| Family · event | When it fires | Generic family |
| --- | --- | --- |
| `dev_review_loop` · `loop_started`, `resumed`, `paused`, `cancelled` | The loop starts, resumes, pauses or is cancelled | `run.started / resumed / paused / cancelled` |
| `dev_review_loop` · `stop_condition_met`, `journal_finalized`, `driver_exited` | The run ends: ready, failed, exhausted; how the driver exited | `run.completed / failed / exhausted` |
| `dev_review_loop` · `driver_heartbeat` | At most every five minutes while a loop runs | Liveness, for Mission Control |
| `dev_review_loop` · `round_started`, `round_ended` | A revision round starts and ends | `decision.recorded` (round outcome) |
| `dispatch` · `dispatched`, `outcome_received`, `dispatch_failed` | A role is dispatched and returns or fails | `execution.started / completed / failed` |
| `role_attempt` · `attempted` | One role attempt's normalized outcome | `execution.completed / failed / cancelled` |
| `usage` · `observed` | Tokens used by a dispatched turn | `execution.usage` |
| `gate` · `summary`, `checked` | A check run; each check that did not pass | `gate.evaluated` |
| `dev_review_loop` · `gate_result_read` | The loop reads the mechanical gate result | `evidence.completed` |
| `dev_review_loop` · `verdicts_read`, `findings_compared` | Reviewers' verdicts and findings are read and compared | `review.completed`, `review.finding_recorded` |
| `handoff` · `raised`, `resolved` | A pause needs a decision; the decision is made | `handoff.raised / resolved`, `human.intervened` |
| `effect` · `verified` | A write to the forge ends: success, failure or uncertain | `effect.committed / reconciled` |
| `operation` · `completed` | Every CLI command (including hook and CI runs), Operator and broker calls, custom-event refusals, sandbox probe failures | `human.intervened` (Operator calls only) |
| `dev_review_loop` · `infrastructure_retry` | A recovered or exhausted infrastructure hiccup | `run` detail |
| `dev_review_loop` · `unpushed_work_resume` | The driver resumes a Developer that stopped without pushing | `execution` detail |
| `custom` · `recorded` | A team's own declared event (`logs.events`) | Namespaced process event |

`forge_write` has a schema but no producer.

## Generic families without an event of their own

| Generic family | In Vinaya |
| --- | --- |
| `intent.created / amended` | No event of its own. Named `vinaya.planning.*`. |
| `change.produced / revised` | No event of its own; the pull request and commit ride on round events. |
| `evidence.invalidated`, `review.invalidated`, `decision.invalidated` | Not emitted; staleness is decided by the controller, not logged. |
| `review.requested` | Carried by `dispatch` · `dispatched` for reviewer roles. |
| `process.version_selected` | No event of its own; `flow.version` is on every header. |
| Close-out | No event of its own. Named `vinaya.closeout.*`. |

Studio, Telemetry and Self-improvement derive them from the events above.

## Configuration

Set the destination and any custom events under `logs` in `vinaya.config.json`. See [Log](/docs/features/log).

## What's next

```cards
- [Events](/docs/process/events) The Vinaya Log event reference, field by field
- [Logging](/docs/dev-process/logging) The generic logging contract
- [Telemetry](/docs/features/telemetry) How the record is counted
- [Conformance](/docs/process/integration/conformance) When Vinaya conforms
```
