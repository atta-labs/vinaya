# Log SDK — recording, keeping, sending and reading a workflow's events

Status: draft

Everything below ships.

`@attalabs/vinaya-log-sdk` records the events of a workflow run as OpenTelemetry traces and logs, keeps a local copy of what it wrote, sends that copy to an OTLP/HTTP collector, and reads and narrates it back. It runs without a Vinaya installation: any application or shell script can use it, through the `connect` function or the `vinaya-log` command.

Its users are the Vinaya command line, which records every run through it and depends on this package at the same version; the Log server and any other OTLP/HTTP collector, which receive what it sends; and adopters who record their own workflows and declare their own events.

It is telemetry, never authority. Nothing in a run waits on the Log to decide, and a failure in it never stops the run.

## 1. The OpenTelemetry model

- **A run is a trace.** The trace id derives from the run id alone, so every process that writes for the run lands in the same trace.
- **Spans nest.** The run is the root span `invoke_workflow {process}`; a round `vinaya.round {n}` nests under it; an agent `invoke_agent {seat}` under its round; and a step `execute_tool {tool}` under its agent. Pauses (`vinaya.pause`), people asked (`vinaya.person {kind}`), checks (`vinaya.checks {where}`) and phases (`vinaya.phase {phase}`) are spans under the run or round they belong to.
- **Events are log records** named `vinaya.<subject>.<what>`, linked to the span they happened in. A declared custom event has its own `<namespace>.<name>`.
- **Every span start writes a started event** of its own (`vinaya.run.started`, `vinaya.round.started`, `vinaya.agent.started`, `vinaya.pause.started`, `vinaya.person.asked` and the like), so a reader sees a span that never ended. A call that ends a span the process did not start writes the span whole, from that started event.
- **Names come from the catalogue.** Standard names are the OpenTelemetry and GenAI ones (`gen_ai.agent.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`, `error.type`); every other name is `vinaya.*`.
- **The resource is set once per run:** the repository, the SDK's own version as `vinaya.sdk.version`, `os.type`, `vinaya.ci`, and each part of the identity the caller gave (`vinaya.runner.name`, `vinaya.runner.version`, `vinaya.cli.version`, `vinaya.flow.id`, `vinaya.flow.version`, `vinaya.process.digest`, `vinaya.settings.digest`). A part not given is not written.

The GenAI conventions version the SDK stamps on its records is:

<!-- VINAYA:CLAIM: packages/log-sdk/src/contract/catalogue.ts contains:export const GENAI_CONVENTIONS_VERSION = 'semantic-conventions-genai@main-2026-11-18' -->

## 2. The functions

`connect(options)` returns the handle. Every other function is a method of the handle, named `log.<subject>.<method>`. The table is the whole surface: each function has a row, and each row a function.

| Function | OpenTelemetry | Records |
| -- | -- | -- |
| `connect` | — | Opens the Log: destination, credential, declared events |
| `log.run.started` | span `invoke_workflow {process}` starts (the trace's root) | Work reference and title, process and its version, round limit, seats, model per seat |
| `log.run.ended` | that span ends | Rounds, total time, time to green, files changed, ready or stopped |
| `log.run.alive` | event `vinaya.run.alive` | Sent automatically when an open run has written nothing for two minutes: round, phase |
| `log.run.stageChanged` | event `vinaya.run.stage_changed` | Develop, local checks, review, ready push, focused checks, change opened, waiting on CI, waiting for merge, paused for a person |
| `log.run.paused` | span `vinaya.pause` starts | Round, why |
| `log.run.resumed` | that span ends | By a person or by the run |
| `log.run.cancelled` | event `vinaya.run.cancelled` | Round, by a person |
| `log.run.retried` | event `vinaya.run.retried` | What failed, tries, recovered or not |
| `log.run.stopRuleMet` | event `vinaya.run.stop_rule_met` | Approved, round limit, no progress, escalated, person stop, confidence, a fixed finding came back, same finding, same failure, time budget |
| `log.run.exited` | event `vinaya.run.exited` | Finished, paused, restarted, error, signal; exit code; error kind |
| `log.round.started` | span `vinaya.round {n}` starts | Round, starting commit |
| `log.round.ended` | that span ends | Files changed, lines added and removed, outcome |
| `log.phase.ended` | span `vinaya.phase {phase}` | Developer, local checks, review, push, CI, other; step |
| `log.agent.sent` | span `invoke_agent {seat}` starts | `gen_ai.agent.name` (the seat), `gen_ai.provider.name`, `gen_ai.request.model`, the coding agent and its version, round |
| `log.agent.stepStarted` | span `execute_tool {tool}` starts, under the agent | `gen_ai.tool.name`, `gen_ai.tool.call.id`; kind (reading, searching, editing, creating, removing, running tests, type-checking, git, GitHub, tool request, skill, fetching, delegating, reporting, running, writing, checking, publishing); file or command |
| `log.agent.stepEnded` | that span ends | Worked or failed (`error.type`), first error line |
| `log.agent.returned` | the agent span ends | What came out (change opened, round pushed, verdict, escalation, plan, done), attempt, `gen_ai.response.model` |
| `log.agent.failed` | the agent span ends with `error.type` | Timeout, crash, refused, wrote outside its place, usage limit with reset time |
| `log.agent.confidenceStated` | event `vinaya.agent.confidence_stated` | Confidence 0–100 or not given, its reason, after an extra turn |
| `log.usage.recorded` | on the agent span | `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cache_read.input_tokens`; cost when known, exact or estimated; or why unknown. The one place for tokens. With tokens and no cost, `vinaya.usage.cost_unknown_reason` says why the cost is unknown; a cost never rides with it, and the reason for unknown usage (`vinaya.usage.unknown_reason`) still drops every figure |
| `log.review.verdicts` | event `vinaya.review.verdicts` | Each seat's verdict, blocking count, each finding (identity, severity, place, blocking or not) |
| `log.review.findingsCompared` | event `vinaya.review.findings_compared` | Findings open, resolved, new, recurring |
| `log.checks.ran` | span `vinaya.checks {where}` | Where (hook, local, push, CI); ran, passed, failed, skipped, which failed |
| `log.checks.notPassed` | event `vinaya.checks.not_passed` | One check, its version, its result, the reason |
| `log.checks.read` | event `vinaya.checks.read` | Round, checks green or not |
| `log.checks.local` | span `vinaya.checks local` | Passed or not |
| `log.checks.ci` | span `vinaya.checks ci` | Green, red, pending or skipped; failing checks; wait time |
| `log.checks.rerun` | span `vinaya.checks rerun` | Failed tests run again: failed, affected, total |
| `log.change.saved` | event `vinaya.change.saved` | Branch, commit |
| `log.change.pushed` | event `vinaya.change.pushed` | Passed or refused, tests picked, failed, time |
| `log.change.opened` | event `vinaya.change.opened` | The change, its commit |
| `log.change.conflicted` | event `vinaya.change.conflicted` | Sent back after a conflict, which re-entry |
| `log.change.recovered` | event `vinaya.change.recovered` | Unsaved work picked up |
| `log.change.merged` | event `vinaya.change.merged` | When, by whom; linked to the run's trace |
| `log.change.closed` | event `vinaya.change.closed` | Closed without merging: when, by whom; linked to the run's trace |
| `log.change.reverted` | event `vinaya.change.reverted` | When, why |
| `log.change.incident` | event `vinaya.change.incident` | Severity, link |
| `log.person.asked` | span `vinaya.person {kind}` starts | Kind (authority, strategy, product), why, the decision asked for; how to answer, when the loop records it (short text, for example the command to run) |
| `log.person.answered` | that span ends | The answer, who gave it |
| `log.forge.validated` | event `vinaya.forge.validated` | A forge write checked before it is made |
| `log.forge.refused` | event `vinaya.forge.refused` | A forge write refused, and why |
| `log.forge.written` | event `vinaya.forge.written` | A forge write made |
| `log.action.verified` | event `vinaya.action.verified` | One outside action: success, failure, uncertain |
| `log.command.completed` | event `vinaya.command.completed` | A command: ok, error, refused, timeout, cancelled, unavailable |
| `log.custom.recorded` | event `<namespace>.<name>` | A declared event and its fields |

The handle also has `flush()`, `shutdown()` and `writeSpan()` (a span whose start and end times the caller already has), which record nothing of their own.

An open run that has written nothing for two minutes writes `vinaya.run.alive` by itself, until `log.run.ended` or `shutdown`. The interval is:

<!-- VINAYA:CLAIM: packages/log-sdk/src/writer/run.ts contains:export const HEARTBEAT_MS = 2 * 60 * 1000 -->

When another process already wrote the run's started record to the run's local copy, `log.run.started` writes no second start: the handle carries that run on, nesting under the same run span.

## 3. The local copy

Recording writes under `<base folder>/<owner>-<repo>`, with `unresolved` for the repository segment when no safe name is known. The base folder is `logs.folder` when set to an absolute path outside the repository, and `<runtimeDir>/logs` otherwise.

Each writer of a run has its own numbered segments, so two processes never write the same file. Each line is one OTLP JSON document, and a line once written is never changed. The names are `<run>~<writer>~<index>.traces.jsonl` and `<run>~<writer>~<index>.logs.jsonl`, the index padded to twelve digits:

<!-- VINAYA:CLAIM: packages/log-sdk/src/local-copy/file-exporters.ts contains:const INDEX_WIDTH = 12 -->
<!-- VINAYA:CLAIM: packages/log-sdk/src/local-copy/file-exporters.ts contains:~${writerId}~${'0'.repeat(INDEX_WIDTH)}.traces.jsonl -->

A run id that is not safe as a file-name part is written as `unresolved`.

## 4. Sending

`sendLocalCopy({ folder, repository, url, headers?, home? })` posts each line of the local copy to the collector's `/v1/traces` or `/v1/logs`, as OTLP/HTTP with a JSON body (`Content-Type: application/json`, as the OTLP specification requires for JSON). It applies redaction again to every string value in a line's parsed JSON before posting, regardless of line size. The `home` option defaults to the process's home directory. The local copy and the original line bytes used for receipts stay intact. A `2xx` response marks the line sent. A response below `400`, at `500` or above, or one of `401`, `403`, `404`, `408` and `429`, or a failed connection or timeout, leaves the line to be tried again by the next call and is reported in `failures`. Any other `4xx` response sets the line aside (below).

Delivery state is kept in `.otlp-delivery` inside the repository's folder, with a receipt per line: a line sent once is not sent again, and a line set aside has a rejected receipt and is never posted by a later call. A segment missing from the middle of a writer's numbering is reported as lost. The report holds `sent`, `setAside` and `failures`.

<!-- VINAYA:CLAIM: packages/log-sdk/src/sender/send.ts contains:const state = join(directory, '.otlp-delivery') -->
<!-- VINAYA:CLAIM: packages/log-sdk/src/sender/send.ts contains:const retryableClientStatuses = new Set([401, 403, 404, 408, 429]) -->

A line is set aside, with a rejected receipt and an entry in `setAside` (not in `failures`), when it is not valid JSON, when its record fails the contract (a `vinaya.*` span, event or attribute name outside the catalogue; the entry names the first failing name), or when the collector answers with a `4xx` status that is not in the retried set above. Valid JSON with no `vinaya.*` names also goes through redaction before posting.

## 5. Settings

`connect()` reads `log.config.json` in `repoRoot` (the working directory by default) or, when that is absent, the `logs` and `runtimeDir` keys of `vinaya.config.json`; what the caller passes overrides both. The same reader is public as `resolveSettings`.

- `runtimeDir` — absolute path of the runtime directory; default `<vinayaHome>/runtime/<owner>-<repo>`, `vinayaHome` being `~/.vinaya`.
- `logs.folder` — the base folder of § 3.
- `logs.otlp.url` and `logs.otlp.headers` — the collector, for the caller to give `sendLocalCopy`.
- `logs.events` — the declared custom events and their fields.
- `logs: false`, or `destination: false` — the handle records nothing and keeps every function.

## 6. Reading and narrating

`createReader` over `createFolderSource` (the local copy) or `createOtlpSource` (any system that supplies OTLP JSON) returns the records in order. `pull()` reads incrementally, `readAll()` takes a snapshot, and `follow({ signal })` is an async iterator; a saved `position` resumes a read. A record that fails the contract is not handed out: it is reported in `gaps` as kind `contract` with its place, writer and first failing name.

`narrate(record, seatNames, earlier)` returns one line, a kind and a sentence, for any record the SDK writes, and `null` for anything else. It never throws. `seatNames` maps a seat to the reading's name for it; a step's agent is read from the agent's started record among `earlier`. A value the wording does not know reads as its code. The signature is:

<!-- VINAYA:CLAIM: packages/log-sdk/src/narration/narrate.ts contains:export function narrate( -->
<!-- VINAYA:CLAIM: packages/log-sdk/src/narration/narrate.ts contains:seatNames?: SeatNames, -->
<!-- VINAYA:CLAIM: packages/log-sdk/src/narration/narrate.ts contains:earlier: readonly unknown[] = [] -->

## 7. The rules every handle keeps

- **It never throws.** A failure goes to `onError`; a handle that could not open records nothing and still has every function.
- **Absent is absent.** A field not given is not written, never an empty value or a default.
- **No content is recorded.** Prompts, replies and file contents are not attributes; only names, counts, results and short reasons are.
- **Free text is capped at 500 characters** after redaction; a longer value is cut so that it ends with `…`, which counts within the 500. A declared custom event's text field over the cap is refused.

<!-- VINAYA:CLAIM: packages/log-sdk/src/contract/custom.ts contains:export const CUSTOM_TEXT_MAX_LENGTH = 500 -->

- **Every record is checked again** against the contract before it is sent and when it is read (§ 4, § 6).
- **Redaction runs before writing, sending and reading.** It replaces recognized secrets and shortens a whole home directory to `~` at the start of a string or after whitespace, a quote, `=`, `:` or `(`. It ignores trailing separators in the configured home and recognizes colon-separated path lists. With home `/home/al`, `file=/home/al/work` becomes `file=~/work` and `PATH=/home/al:/usr/bin` becomes `PATH=~:/usr/bin`. A prefix-sharing path such as `file="/home/al ice/work"` stays intact because the space belongs to the quoted directory name.

<!-- VINAYA:CLAIM: packages/log-sdk/src/contract/redact.ts contains:out = out.replace(new RegExp(bare + '|' + quoted, 'g'), '$1$2~') -->

- **One version is shared with the CLI.** Records carry the version of this package's own manifest, as `vinaya.sdk.version` and as the instrumentation scope's version; the command-line package depends on this package at that same version.

<!-- VINAYA:CLAIM: packages/log-sdk/src/contract/version.ts contains:export const SDK_VERSION: string = manifest.version -->

- **Narration uses the reading's seat names** (§ 6).
