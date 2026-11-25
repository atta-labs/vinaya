# @attalabs/vinaya-log-sdk

Record workflow events as OpenTelemetry traces and logs, keep a local copy, and read or send that copy from your own application or shell. The SDK and its command run without a Vinaya installation. The full description of the package (its model, every function, the local copy, sending and the rules a handle keeps) is in the [Log SDK spec](./specs/log-sdk.md).

## Install and record

Use Node.js 22.13 or later.

```sh
npm install @attalabs/vinaya-log-sdk
```

```js
import { connect } from '@attalabs/vinaya-log-sdk'

const log = connect({
  runId: 'deploy-42',
  repository: 'acme/widget',
  runtimeDir: '/var/tmp/widget-runtime',
  onError: console.error
})

try {
  log.run.started()
  log.run.ended()
} finally {
  await log.shutdown()
}
```

Pass `identity` to `connect` to say what ran the run: any of `runnerName`, `runnerVersion`, `cliVersion`, `flowId`, `flowVersion`, `processDigest` and `settingsDigest`. Each part given is written once, as a resource attribute on every record (`vinaya.runner.name`, `vinaya.runner.version`, `vinaya.cli.version`, `vinaya.flow.id`, `vinaya.flow.version`, `vinaya.process.digest`, `vinaya.settings.digest`); a part not given is not written. The SDK fills `os.type` (OpenTelemetry's value for the machine's operating system, such as `darwin`, `linux` or `windows`) and `vinaya.ci` (`true` when the `CI` environment variable is set to anything but empty or `false`; `identity.ci` overrides it) itself. `log.agent.sent` takes an optional `effort` text, written as `vinaya.agent.effort` on the agent's started event and span.

Every text value the SDK writes is at most 500 characters after redaction; a longer one is cut so that it ends with `…`, which counts within the 500. A declared custom event's text field over 500 characters is still refused.

Reuse the handle for the life of a run. Call `flush()` to flush processors during the run and `shutdown()` when finished.

## Settings

`connect()` reads `log.config.json` in `repoRoot` (the current working directory by default). If that file is absent, it reads the `logs` and `runtimeDir` keys from `vinaya.config.json` when present. Pass `destination` and `runtimeDir` directly to override those settings.

```json
{
  "runtimeDir": "/var/tmp/widget-runtime",
  "logs": {
    "folder": "/var/tmp/workflow-logs",
    "otlp": {
      "url": "https://collector.example.com",
      "headers": {}
    },
    "events": {
      "acme.deploy": { "fields": { "count": "number" } }
    }
  }
}
```

- `logs.folder` is an absolute base folder outside the repository. The SDK uses `<runtimeDir>/logs` if no eligible folder is configured. The runtime directory defaults to `~/.vinaya/runtime/<owner>-<repo>` and can be set to an absolute path.
- `logs.otlp.url` is the HTTP(S) OpenTelemetry collector base address. `logs.otlp.headers` holds collector headers. Pass these settings to `sendLocalCopy()` when delivering the local copy. The handle writes locally during recording.
- `logs.events` declares custom event names and their fields. Supply declarations inline under `destination.events` or in the config file.
- Set `"logs": false` or pass `destination: false` to turn recording off. The handle still exposes the same methods.

### Read the settings yourself

The same settings reader `connect()` and the command line use is on the public entry, so a loop that sends or follows the Log reads settings the way the SDK does:

- `resolveSettings({ repoRoot, repository?, vinayaHome?, passed? })` reads `log.config.json` or `vinaya.config.json` under `repoRoot`, applies the settings passed in, and returns `{ ok: true, settings, declarations }` or `{ ok: false, error }`.
- `repoSegment(repository)` returns the `<owner>-<repo>` folder name the Log folder and the local copy key by, or `unresolved` when the repository is unknown or unsafe as a folder name.
- `defaultRuntimeDir(repository, vinayaHome?)` returns the runtime directory used when none is set: `<vinayaHome>/runtime/<owner>-<repo>`, with `vinayaHome` defaulting to `~/.vinaya`.

The types `PassedSettings`, `ResolvedSettings` and `SettingsResult` describe their arguments and results.

### Read the fields of an emit command

`readFields(args, readStdin)` reads the event name and the JSON object of a `vinaya-log emit`-style command from its arguments (`<event> --json '<object>'`) or, when `--json` is absent, from standard input, and returns `{ ok: true, name, fields }` or `{ ok: false }` with a `message` when the JSON was unreadable or not an object. `EMIT_USAGE` is the usage text such a command prints when the event is missing.

### The version records carry

Every record a handle writes carries the `version` field of this package's own `package.json`, as `vinaya.sdk.version` on its resource and as its instrumentation scope's version. The version is read from the package's manifest next to the module, so it is the same from the source and from the built package, and never a constant written into the code. The command-line package `@attalabs/vinaya` depends on this package at the same version.

## Record by subject

| Subject | Methods |
| --- | --- |
| Run | `started`, `ended`, `alive`, `stageChanged`, `paused`, `resumed`, `cancelled`, `retried`, `stopRuleMet`, `exited` |
| Round and phase | `round.started`, `round.ended`, `phase.ended` |
| Agent and usage | `agent.sent`, `agent.stepStarted`, `agent.stepEnded`, `agent.returned`, `agent.failed`, `agent.confidenceStated`, `usage.recorded` |
| Review and checks | `review.verdicts`, `review.findingsCompared`, `checks.ran`, `checks.notPassed`, `checks.read`, `checks.local`, `checks.ci`, `checks.rerun` |
| Change | `saved`, `pushed`, `opened`, `conflicted`, `recovered`, `merged`, `reverted`, `incident`, `closed` |
| Person | `asked`, `answered` |
| Forge, action and command | `forge.validated`, `forge.refused`, `forge.written`, `action.verified`, `command.completed` |
| Custom | `custom.recorded(name, fields)` |

### A run across processes

A run's records link to it whichever process writes them. When `run.started` finds that another process already wrote the run's `vinaya.run.started` to the run's local copy, the handle writes no second start: it carries on that run. Its records nest under the same run span, it takes up the open round and the last stage from the copy, and it sends `run.alive` after two minutes with no record until `run.ended` or `shutdown`. `run.ended`, `round.ended`, `run.resumed` and `person.answered` called in a process that did not start the span write it once, whole, from the start time you give or else from the span's started event in the copy (`vinaya.run.started`, `vinaya.round.started`, `vinaya.pause.started`, `vinaya.person.asked`), with that event's start attributes. With neither, the call reports through `onError` and writes nothing. `vinaya-log` follows the same lookup rule for its span-end subcommands.

`change.merged`, `change.reverted`, `change.incident` and `change.closed` (a change closed without merging) link to the handle's own run unless you pass a `runId`. `person.asked` takes an optional `howToAnswer` short text, such as the command to run; it is redacted, cut to 500 characters and written as `vinaya.person.how_to_answer` on the asked event and on the whole person span.

Use the package's TypeScript declarations for each method's payload. Call `log.writeSpan()` when you already have a span's start and end times. The package also exports the event catalogue, schema, custom-event validation, ID, redaction, stored-line and earlier-event conversion helpers.

## Local copy and delivery

The SDK writes under `<base folder>/<owner>-<repo>`, using `unresolved` when it has no usable repository name. Each run and writer has numbered segments named `<run>~<writer>~<index>.traces.jsonl` or `<run>~<writer>~<index>.logs.jsonl`. Each line contains an OTLP JSON document.

```js
import { sendLocalCopy } from '@attalabs/vinaya-log-sdk'

const report = await sendLocalCopy({
  folder: '/var/tmp/widget-runtime/logs',
  repository: 'acme/widget',
  url: 'https://collector.example.com'
})
console.log(report.sent, report.setAside, report.failures)
```

Supply the base folder and the same repository name used for recording. The sender posts to the collector's `/v1/traces` and `/v1/logs` endpoints and uses `.otlp-delivery` in the repository's local Log folder to track delivery. Call it again to pick up new data or retry delivery failures. Pass `headers` to authenticate to the collector. A line holding a record that fails the Log's contract (a `vinaya.*` span name, event name or attribute name outside the catalogue) is never posted: it is set aside with a rejected receipt naming the first failing name, listed in `report.setAside`, and not posted by a later send. A line that is valid JSON but holds no OTLP record is posted as before.

## Read, follow and narrate

```js
import { createFolderSource, createReader, narrate } from '@attalabs/vinaya-log-sdk'

const reader = createReader(createFolderSource({
  folder: '/var/tmp/widget-runtime/logs/acme-widget',
  runId: 'deploy-42'
}))
const { records, gaps } = await reader.readAll()
for (const record of records) {
  const line = narrate(record)
  if (line) console.log(line.text)
}
if (gaps.length) console.warn(gaps)
```

A folder source takes the repository's Log folder. To read from another system, use `createOtlpSource({ name, supply })`, where `supply(cursor)` returns OTLP JSON documents and the next cursor. Readers expose `pull()` for incremental reads, `readAll()` for a snapshot, and `follow({ signal })` as an async iterator. Save the returned `position` to resume later, and abort the signal to stop following. `narrate(record, seatNames, earlierRecords)` produces one human-readable narration line (a kind and a sentence) when it recognizes the record, and `null` otherwise; it never throws. It narrates every record type the SDK writes: the span ends (`invoke_workflow`, `vinaya.round`, `vinaya.phase`, `invoke_agent`, `execute_tool`, `vinaya.checks`, `vinaya.person`, `vinaya.pause`, with or without their filled-in part), every catalogue event, and a declared custom event. A step's agent is read from the `vinaya.agent.started` record among `earlierRecords` that has the step's parent span id; without one the step reads as "a role". A why, decision, stop rule, exit kind or result the wording does not know reads as its code. Content attributes are never narrated. A record that fails the Log's contract (see `checkRecordContract`) is never handed: it is reported in `gaps` as kind `contract`, with its place, its writer and the first failing name, and the records around it are still handed.

## Command line

Run these from the repository or directory containing your Log config. The command discovers the Git root and repository from the checkout when available. Set `VINAYA_REPO=acme/widget` to supply the repository name explicitly.

```sh
npx vinaya-log run started --run deploy-42 --json '{}'
npx vinaya-log emit acme.deploy --run deploy-42 --json '{"count":1}'
npx vinaya-log run ended --run deploy-42 --json '{}'
npx vinaya-log follow --run deploy-42
```

Built-in recording commands use a subject and a kebab-case method, such as `agent step-started`. Pass fields through `--json` or pipe a JSON object to standard input. `emit` records a declared custom event, such as `acme.deploy` in the config above. Use `follow --task <ref>` to follow a work reference, or `follow` on its own to follow the whole local folder. Press Ctrl+C to stop.
