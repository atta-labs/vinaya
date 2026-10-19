# Adapters — Vinaya

Summary: The adapters the Vinaya process uses for each generic adapter kind, and the GitHub vocabulary they speak: Issues and Milestones, labels that carry single facts, nine derived statuses.
Parent: Integration
Badges: GitHub reference adapter · claude or codex · Never the forge for the Log

## About Vinaya's adapters

This page answers the generic [Adapters](/docs/dev-process/adapters) for the Vinaya process.

Vinaya names requirements and policy. Adapters perform external operations; they do not authorize them.

## How it works

```steps
### The harness authorizes
Every write to the tracker or the code host is prepared and authorized by the harness first.

### The adapter performs or observes it
The adapter makes the comment, label, branch, pull request, publication or merge, or observes that it happened.

### The harness reconciles
The result comes back and is reconciled, so an uncertain write is never taken as done.
```

## Vinaya's adapters

| Generic adapter | Vinaya use |
| --- | --- |
| Intent source | The reference GitHub Issues and Milestones adapter; other sources may map the same work-item contract |
| Agent runtime | Supported runtimes (`claude`, `codex`, set in `dispatch`) through the portable runtime contract |
| Code host | The GitHub reference adapter for revisions, checks and publications |
| Evidence producer | Registered checks, CI and imported observations |
| Reviewer | Fresh Reviewer and Security agent Executions, normalized to a Review |
| Code host and tracker effects | Perform or observe an already-authorized comment, label, branch, pull request, publication or merge |
| Log destination | Deliver harness-emitted events without becoming control state. Never GitHub. See [Delivery](/docs/features/log/delivery). |

## The GitHub vocabulary

- **Tracker.** Issues and Milestones. Status is derived on demand, never stored, from Issue state, branch presence, pull request state, review decision and the blocked label.
- **Labels carry single facts, never status:** tranche, tier, blocked, backlog, needs, waiver, type; and hot, once that lane exists.
- **Nine derived statuses:** backlog, todo, in-flight, in-review, changes-requested, merged, blocked, dropped, incoherent.

## Configuration

The agent runtime is set under `dispatch`, and the Log destination under `logs`. See [The file and its keys](/docs/features/configuration/the-file-and-its-keys).

## What's next

```cards
- [Loader](/docs/process/integration/loader) How Vinaya is loaded
- [Adapters](/docs/dev-process/adapters) The generic adapter kinds
- [Issue kinds](/docs/process/thinking/issue-kinds) Planned, backlog, hot
- [The Operator](/docs/process/executing/the-operator) The tools that drive the forge writes
```
