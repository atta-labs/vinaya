# Logging — definition

Summary: What a process must do so that its runs are recorded by the Log. The harness writes the Log; the process supplies the facts it needs: identities, payload schemas, its own events and a mapping table.
Parent: Dev Process
Badges: Common event families · Identities · Mapping table · Harness-written

## About logging

The [Log](/docs/features/log) belongs to the harness. A process does not write it, configure its destination or change its event families. It supplies the facts the harness needs to write it.

A process cannot redefine what a common event means. The Log is an audit and telemetry record; it never authorizes or recovers a Run.

## How it works

```steps
### The process declares its facts
For every common event it says how its own objects map to the common identities, and what process facts it attaches.

### The harness emits the event
The harness function that owns each act builds, validates and correlates the common event. Gate results are written as `gate.evaluated`, for generic and process-specific gates alike.

### The Log delivers it
The event goes to the destination the team set under `logs` in [Configuration](/docs/features/configuration): a folder or a server.

### The features read it
[Telemetry](/docs/features/telemetry) counts the record and [Studio](/docs/features/studio) shows it, without any process-specific hidden data.
```

## Who does what

| Concern | Owner |
| --- | --- |
| Event families and their meaning | Harness, fixed |
| Emitting, validating, delivering and correlating common events | Harness, from the function that owns each act |
| Where events go (`logs`: a folder or a server) | The team, in Configuration |
| Identities and declared payload schemas for each event | Process |
| Its own namespaced events | Process (optional) |
| Gate results | Harness, as `gate.evaluated`, for generic and process-specific gates alike |

## Required event families

```text
run.started / paused / resumed / completed / failed / cancelled / exhausted
intent.created / intent.amended
execution.started / paused / resumed / completed / failed / cancelled / exhausted
execution.usage
change.produced / change.revised
evidence.completed / invalidated
review.requested / completed / invalidated
review.finding_recorded
decision.recorded / invalidated
gate.evaluated
effect.requested / committed / reconciled
handoff.raised / resolved
human.intervened
process.version_selected
```

## What every event carries

```text
event_id, timestamp, process_id, process_version, policy_version,
run_id, intent_id, intent_version, execution_id, attempt,
change_id, base_revision, head_revision, patch_identity, actor, source_system,
correlation_id, outcome, provenance strength and safe payload
```

Usage records tokens, wall time and cost per Execution.

## What a process must declare

1. **Identities.** For every common event, how its own objects map to the identities above: its task to `intent_id`, its review round to the Review identity, and so on.
2. **Payload schemas.** The schema of any process facts it attaches to common events.
3. **Its own events, if any.** Namespaced under the process (for example `vinaya.planning.*`), versioned, with a schema.
4. **A mapping table.** Which of its moments fire which common family, and which families it does not produce, with how readers derive them.

## Conformance

The events the harness emits must hold enough contract data for Mission Control in Studio and for comparable statistics in Telemetry, without process-specific hidden data. [Conformance](/docs/dev-process/conformance) checks this.

## Each process documents its side

A process documents how it fulfils this contract on its own Integration › Logging page. For the Vinaya process, see [Logging](/docs/process/integration/logging).

## Configuration

None for the process. The team sets the destination under `logs`; see [Log](/docs/features/log) and [Delivery](/docs/features/log/delivery).

## What's next

```cards
- [Vinaya's logging](/docs/process/integration/logging) How the Vinaya process fulfils this contract
- [Event contract](/docs/features/log/event-contract) The portable event contract the harness writes
- [Conformance](/docs/dev-process/conformance) Proving the events are enough
- [Telemetry](/docs/features/telemetry) The record, counted
```
