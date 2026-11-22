# @attalabs/vinaya-log-sdk

## 0.46.0

### Minor Changes

- 7f5d028: A run's records link to it whichever process writes them: a later process carries on a started run, writes its run, round, pause and person spans whole from the start in the local copy and sends the alive event, and merged, reverted and incident link to the handle's run by default. The handle gains `change.closed` for a change closed without merging, and `person.asked` takes an optional how-to-answer text.
- 38ca5e3: Every record says what ran its run, and each agent turn its effort: `connect` takes an optional `identity` (runner, CLI, flow, process digest and settings digest) written as resource attributes, fills `os.type` and `vinaya.ci` itself, and `agent.sent` takes an optional `effort`.
- b2ccbc0: The Log SDK and the command-line package release on one version. A handle given no service version writes no `service.version` resource attribute instead of the SDK's version in its place.
- bfb01b1: `narrate` gives one plain line for every record the Log SDK writes: every span end, every catalogue event and a declared custom event. A failed agent turn now reads as a failed line, a step reads with its agent taken from the agent's started record among the records read before, and a code the wording does not know reads as its code.

### Patch Changes

- a4e75b2: `vinaya task status --follow` shows the narrative again on every runner: a run that records no steps of its own (the Engine runner today) shows each agent step from the driver log, an agent turn converted from an earlier role attempt is narrated with its seat ("The developer finished its turn." instead of "A role finished its turn."), and a run read from its local copy no longer reports a false "sequence 0 never arrived" gap, because a Log SDK writer numbers its records from 1.
- 3cd8d2c: Every text value the writer stores, including each text in a list, is at most 500 characters after redaction; a longer one is cut so that it ends with `…`. A custom event's text field over 500 characters is still refused.

## 0.1.0

### Minor Changes

- d2f4075: Release the Vinaya Log SDK for standalone use. Record workflow events with the SDK or the `vinaya-log` command, keep a local OpenTelemetry copy, send it to a collector, and read or narrate recorded activity.
