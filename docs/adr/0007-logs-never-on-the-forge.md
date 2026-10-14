# 0007. Logs never on the forge

**Status:** Accepted

**Date:** 2026-09-23

## Context

Every run produces telemetry: dispatches, rounds, gate outcomes, forge writes and token use. The forge is the obvious place to put it, because every role already reads Issues and pull requests, and CI can store artifacts. But telemetry is high volume and machine-shaped, while Issues and pull requests are read by people and by gates that parse fixed positions. Telemetry written there adds noise to the record people review, costs forge requests, and can be edited by anyone who can write a comment.

Earlier, events were collected during a round and flushed at its end, so a run that died mid-round lost them.

## Decision

We will deliver every log event live, as it is emitted, to the destination `vinaya.config.json`'s `logs` setting names: exactly one of a folder or a server. With no setting, events go to a folder under the repository's own runtime directory. Telemetry is never written to a tracker or a code host: no Issue or pull-request comment and no CI artifact. A pull-request body carries no token table; the log is the one place a turn's token use is recorded.

## Considered options

- Comments on the Issue or pull request. Every role can already read them, but they bury the review record in machine output and spend forge requests on every event.
- CI artifacts. They are attached to a run and need no extra service, but they expire, exist only for CI runs, and are not readable while a local run is still going.
- Batching events and flushing them at the end of a round. This needs fewer writes, but a run that dies mid-round loses everything since the last flush; this was the approach the decision replaced.
- Live delivery to a configured folder or server. This is the chosen option.

## Consequences

Events are readable while a run is still going and survive a run that dies. The forge holds only what people and gates need to read. A server destination needs a local retry queue for when it is unreachable, and its credentials come from an environment variable rather than the committed config.

Anyone who wants run telemetry needs access to the configured folder or server; it cannot be found on the forge. Because a pull request under review could redirect a destination in its own change, an unattended run reads the destination from the default branch's configuration only.

## Where it is applied

`apps/cli/specs/log.md` describes the destinations, live delivery and the retry queue. `apps/cli/src/lib/log-sink.ts` resolves the destination and appends each event, and `resolveTrustAnchorLogsDestination` in `apps/cli/src/lib/config.ts` reads it from the default branch for an unattended run. The `logs` setting in `vinaya.config.json` names this repository's server.
