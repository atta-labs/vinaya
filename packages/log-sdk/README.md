# @attalabs/vinaya-log-sdk

Record workflow events as OpenTelemetry traces and logs, keep a local copy, and read or send that copy from your own application or shell. The SDK and its command run without a Vinaya installation.

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

## Record by subject

| Subject | Methods |
| --- | --- |
| Run | `started`, `ended`, `alive`, `stageChanged`, `paused`, `resumed`, `cancelled`, `retried`, `stopRuleMet`, `exited` |
| Round and phase | `round.started`, `round.ended`, `phase.ended` |
| Agent and usage | `agent.sent`, `agent.stepStarted`, `agent.stepEnded`, `agent.returned`, `agent.failed`, `agent.confidenceStated`, `usage.recorded` |
| Review and checks | `review.verdicts`, `review.findingsCompared`, `checks.ran`, `checks.notPassed`, `checks.read`, `checks.local`, `checks.ci`, `checks.rerun` |
| Change | `saved`, `pushed`, `opened`, `conflicted`, `recovered`, `merged`, `reverted`, `incident` |
| Person | `asked`, `answered` |
| Forge, action and command | `forge.validated`, `forge.refused`, `forge.written`, `action.verified`, `command.completed` |
| Custom | `custom.recorded(name, fields)` |

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

Supply the base folder and the same repository name used for recording. The sender posts to the collector's `/v1/traces` and `/v1/logs` endpoints and uses `.otlp-delivery` in the repository's local Log folder to track delivery. Call it again to pick up new data or retry delivery failures. Pass `headers` to authenticate to the collector.

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

A folder source takes the repository's Log folder. To read from another system, use `createOtlpSource({ name, supply })`, where `supply(cursor)` returns OTLP JSON documents and the next cursor. Readers expose `pull()` for incremental reads, `readAll()` for a snapshot, and `follow({ signal })` as an async iterator. Save the returned `position` to resume later, and abort the signal to stop following. `narrate(record, seatNames, earlierRecords)` produces a human-readable narration line when it recognizes the record.

## Command line

Run these from the repository or directory containing your Log config. The command discovers the Git root and repository from the checkout when available. Set `VINAYA_REPO=acme/widget` to supply the repository name explicitly.

```sh
npx vinaya-log run started --run deploy-42 --json '{}'
npx vinaya-log emit acme.deploy --run deploy-42 --json '{"count":1}'
npx vinaya-log run ended --run deploy-42 --json '{}'
npx vinaya-log follow --run deploy-42
```

Built-in recording commands use a subject and a kebab-case method, such as `agent step-started`. Pass fields through `--json` or pipe a JSON object to standard input. `emit` records a declared custom event, such as `acme.deploy` in the config above. Use `follow --task <ref>` to follow a work reference, or `follow` on its own to follow the whole local folder. Press Ctrl+C to stop.
