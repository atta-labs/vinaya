# @attalabs/vinaya-log-sdk

## 0.47.0

### Minor Changes

- 15d3609: The command line depends on the Log SDK as a real package: the published `@attalabs/vinaya` lists `@attalabs/vinaya-log-sdk` at its own version, imports it by name and bundles none of its source. Every record a Log handle writes now names the package's own version, read from its `package.json`, as `vinaya.sdk.version` and as its instrumentation scope's version, where it named `0.0.0` before. The settings reader (`resolveSettings`, `repoSegment`, `defaultRuntimeDir`) and the emit argument reader (`readFields`, `EMIT_USAGE`) are now on the public entry.
  
  The `SDK_VERSION` constant is no longer exported; the version is read from the package manifest and recorded on each record. A caller that imported `SDK_VERSION` reads the same value from the `version` field of `@attalabs/vinaya-log-sdk/package.json`, which the package exports.
- 3432004: A run's local copy is now cleaned after a keep window. The Log settings accept `logs.keepDays`, a whole number of days of at least 1 (90 when absent); any other value is refused when the settings load, naming the key. When a Log handle opens with recording on, it deletes from its repository's local-copy folder every traces and logs file last written longer ago than the window, with that file's delivery state; newer files stay. `connect()` takes an optional `keepDays`, and `DEFAULT_KEEP_DAYS` and `ResolvedSettings.keepDays` are on the public entry. An unattended run keeps the default window.
- 00bed3b: The Log SDK checks every record against the contract again before sending it and when reading it. `checkRecordContract` is exported: a `vinaya.*` span name, event name or attribute name outside the catalogue (and not under `vinaya.earlier.`) fails. The sender sets such a line aside with a rejected receipt naming the name, and the reader reports the record as a gap of kind `contract` without handing it.
- b43cdae: A usage record keeps its tokens and says why its cost is unknown: `log.usage.recorded` takes `costUnknownReason`, a short code written as `vinaya.usage.cost_unknown_reason` beside every token figure given. A cost wins over the reason, and the existing `unknownReason` still means no figure is known and drops them all. `vinaya-log usage recorded` takes the field, and the usage line reads the tokens with the reason, or the cost and whether it is exact or estimated.

### Patch Changes

- 5abef8d: A declared custom event written through a Log handle is marked reported, whatever provenance the handle was opened with; every other record keeps the handle's provenance. A custom event the handle refuses now writes one `vinaya.command.completed` record (action `log.emit`, result `refused`, the reason as its error type, the name as target only when shaped like a declared name, never a field value) and still reaches `onError`. `vinaya-log emit` with a refused event writes that record to the run's local copy and still exits non-zero.
- 1362cbb: A Log writer now keeps at most one open local-copy file per signal: a run that alternates spans and events appends to one traces file and one logs file instead of starting a new file on every switch, and a file still rolls over at 8 MiB. The folder source follows both of a writer's growing files, so a follow polled between a span and an event hands both, each once, with no gap; a half-written last line is reported as abandoned only once the writer has a later file of the same signal. A position saved by the earlier folder source, and a local copy written in the earlier layout, still read with no record skipped or repeated.
- cefb5be: Three Log fixes. With `logs: false` in the settings, a harness process now writes no local copy at all, also when it was handed its runtime directory or runs unattended; an unattended process reads the switch from the default branch's settings, as it does its OpenTelemetry address. A Log SDK reader started at a run's beginning now expects each writer's first record to be numbered 1, the number every SDK writer gives it, so a run read from its start reports no gap; a writer whose records start at 0 is still read in full. An agent turn dispatched with review inputs records the brief, objectives, ruling and policy versions of those inputs on its records (`vinaya.input.*`), on the standalone dispatch and on the Engine runner, while the run's other records and a turn with none carry no versions.
- 86bd515: The Log SDK schema's comment on the driver's own mid-round resume event now states what the event records without naming the review that asked for it. No schema, type or behaviour changes.
- 494e719: Redact every string value again before posting a local-copy record, including large records. Shorten whole home paths within strings as well as at the start.
- ec1a558: The package README links to the Log SDK's repository spec for the full description.
- 98d6dc1: The stored-record contract module also exports the record check on `vinaya.*` names (`reservedNamesOf`, `checkReservedNames` and the `ReservedName` type) and `traceIdFor`, so the package entry exports them and a reader that loads only the contract modules — the Log server's Worker — reaches them through the same module as the store.
- abdcc4e: Sending the local copy skips what an earlier send finished at a fixed cost: one summary in the delivery folder lists the files staged to their end with their sizes, so a file at that size is neither read nor marked again, and a record whose sent receipt is listed is not opened. A missing or unreadable summary is rebuilt from the size markers. A send now stages the newest file first and posts each record as soon as it is staged, with up to eight requests in flight, before the records earlier sends left unsent.

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
