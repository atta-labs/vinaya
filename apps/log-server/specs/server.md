# Log server — the reference destination for Vinaya log events

Status: draft

Everything below ships.

A small server that receives the events a Vinaya installation delivers to a `logs.url` destination (`harness/kernel/log/log.md` § The destination), keeps every one of them, lets a reader page through them from any position, and pushes each new one to live viewers as it arrives. It runs on Cloudflare. The free plan's daily write limit is the first ceiling a busy installation meets (§ 2), and this repository's own deployment has run on the paid Workers plan since 2026-10-01, after reaching it. Any Vinaya adopter can deploy their own copy; the sending side needs no change, because the server accepts exactly what the CLI already sends.

It is telemetry, never authority. Nothing in Vinaya reads this server to decide dispatch, approval, publication or recovery, and an outage here never fails or slows a run: the sender keeps events in its local retry queue until the server is back.

## 1. Shape: one Worker, one Durable Object per repository

- **The Worker** (`src/worker.ts`) is the only public entry point. It checks the bearer token for the route, validates the repository segments in the path, and forwards the request unread to that repository's Durable Object. It never parses a body: a free-plan Worker gets 10 ms of CPU per request, and forwarding a stream costs none of it.
- **`RepoLog`** (`src/repo-log.ts`), one SQLite-backed Durable Object per repository (named `<owner>/<repo>`, lower-cased), is the store, the reader and the live hub for that repository. Because one object owns one repository's log, every write to it is serialized: arrival order is well defined, and the position a reader continues from is simply the row number.

The same object also keeps the repository's OpenTelemetry records — the spans and log records a harness process sends over OTLP/HTTP — in a second table with its own sequence (§ 4), beside the events and sharing nothing with their storage: no OpenTelemetry record is ever an event, reaches the events read or live routes, or is counted by the stats route. A pure module (`src/otlp.ts`) splits an export request into one-record documents, computes each record's identity (§ 3), checks its `vinaya.*` names against the Log SDK's catalogue and redacts its string values; the object stores what it returns.

The path and method grammar of § 5 lives in one pure module (`src/route.ts`) that both halves parse with: the Worker to decide which token a request needs, and the object so that a request reaching it by any other means is still refused rather than trusted.

Nothing else: no D1 database, no R2 bucket, no scheduled job.

## 2. Plan budget

Measured 2026-09-26 to 2026-09-30 by reading every stored event from each of the three delivering repositories (atta-labs/vinaya, attalabs, onchain-rewind) through the read route and the stats route's byte count. Peak day 2026-09-27 carried about 43,000 events across the three, totaling about 40 MB of database growth at peak. The free plan hits its first ceiling — the daily rows-written cap — before storage becomes a constraint. The figures in the table below are the free plan's; a paid plan lifts them.

| Limit (Workers Free) | Measured 2026-09-26 to 2026-09-30 | Allowance |
|---|---|---|
| Worker requests | one per batch; at peak 43,000 events in one batch on 2026-09-27 yields one request | 100,000 a day |
| Durable Object requests | one per ingest, one per read page, one per live connection | 100,000 a day |
| Durable Object SQLite rows written | two per new event (the row and its identity index): peak about 87,000 a day on 2026-09-27 | 100,000 a day |
| Durable Object SQLite rows read | reads page through by row number, never a scan | 5,000,000 a day |
| Durable Object CPU per request | a 5 MiB batch parses and inserts in milliseconds | 30 seconds |
| Outgoing WebSocket messages | one per event per viewer | not billed |
| Durable Object storage | about 40 MB a day at peak | 5 GB per account, 10 GB per object |

**The first ceiling is the daily rows-written cap: at peak measured volume (about 87,000 rows a day on 2026-09-27), the free plan's 100,000 daily limit is reached.** When ingest past that cap is attempted, the sender's ingest request is refused; the sender keeps the batch in its retry queue and resends it later. Storage (about 40 MB a day at peak) would reach the 5 GB account cap in roughly four months at the measured volume.

**OpenTelemetry records cost three rows written each**: the row, its `record_id` identity index, and the `trace_id` index that lets one run be read without a scan (§ 4). The Log SDK writes a started log record for every span it starts, beside the span itself, so a span costs six rows written in all. A request is one Worker request and one Durable Object request, however many records it carries; the Log SDK's sender posts one record per request.

The cap was reached on 2026-10-01: a backlog of events queued on developers' machines flushed at once, writes were refused, and every route answered with an error until the plan changed. Senders keep their events in the local retry queue meanwhile, so the loss is bounded by the queue's size. Three ways were open to reduce or absorb the volume; the reference deployment took the third:
- Record fewer repeated events at the source.
- Retire (delete) old rows from the log, tracked against the daily allowance.
- Move to a paid plan on Cloudflare with higher daily limits.

## 3. Identity and duplicates

Every stored event has one identity: `meta.event_id` for a `schema: 2`, `schema: 3` or `schema: 4` line, `${meta.run_id}:${meta.seq}` for a `schema: 1` line — `recordIdentity` from the kernel's Log schema (`harness/kernel/log`), the same function the sender's storage contract uses, so the server and the sender can never disagree about what counts as the same event. The identity column is `UNIQUE` and every insert is `INSERT OR IGNORE`: a batch resent after a lost acknowledgement stores nothing new and reports the repeats as duplicates. Every other `meta` field is stored as the sender wrote it — `meta.doctrine`, for one, is `doctrine@<id>` from a sender running in a repository that holds the doctrine at `harness/processes/vinaya-strict`, and the package version from an installed one.

Each line is classified with that module's `classifyStoredLine`, the same read-side validation and redaction the sender runs before it posts:

- **`ok`** — stored, as the redacted line `classifyStoredLine` returns.
- **`unknown_version`** — a `meta.schema` the server's copy of the schema does not know yet. Stored with its identity and `status: 'unknown_version'`, verbatim, never dropped: a newer sender talking to an older server loses nothing. The sender writes `schema: 4` (`harness/kernel/log/log.md`); until the server is redeployed with the current schema module, every event it sends is stored this way, verbatim, and it validates them once redeployed. A line this build cannot validate is also one it must not rewrite, so no redaction is re-applied to it — the sender already redacted before it posted.
- **`invalid`** also covers a field the server's copy of the schema does not know: the review finding's optional `location`, `deferral_reason` and `description` are accepted only once the server runs a schema that has them, and a line without them reads the same as before. Deploy the server before releasing a CLI that sends them. The same holds for `loop_started`'s optional `title` — the task Issue's title, which lets a reader name a run from that one stored event: a server running a schema with it stores a titled `loop_started` as `ok`, with the title as sent, and an untitled one exactly as before.
- **`invalid`**, or a line with no identity at all, or a line over 1 MiB — kept in a separate rejected record with the reason, never in the event sequence.

`classifyStoredLine(raw, home)` rewrites absolute paths under `home` to `~/…`. The server is not the machine that produced the event and has no such directory, so it passes the empty string: every other redaction the function applies — GitHub tokens, `Authorization: Bearer …` values — still runs, and no path rewriting happens on arrival at all.

**Content never makes the server refuse a body.** A sender whose queue holds one bad line must not be stuck behind it forever, so a well-formed request is always answered `200`, with every line either stored, a duplicate, or rejected and counted.

### OpenTelemetry records

An OpenTelemetry record has one identity too, and the same `UNIQUE` column and `INSERT OR IGNORE` make a resent export request store nothing new and count its records as duplicates:

- **A span** is `span:<traceId>:<spanId>`, both ids as lower-case hex: OTLP's JSON encoding writes them as case-insensitive hex. A span is never identified by its name or its times, so a span sent again after its attributes or end time changed is still the one record. A span with no trace id or span id (absent, malformed, or all zeros) is refused.
- **A log record** is `log:<sha256 of the canonical record with its resource and scope>` — the one-record document (§ 5) as it arrived, with every object's keys sorted. Equal records are one record; the same record under another resource or scope is another. The Log SDK's started event and the span it starts are two records with two identities, and both are kept.

Each record of a request is classified on its own, and one refused record never refuses the request:

- **stored** — a record whose `vinaya.*` span name, event name and attribute names are all in the Log SDK's catalogue (`reservedNamesOf` and `checkReservedNames`, the same check the sender runs before it posts), or that carries none — a team's own tracing, with only standard or other names, is stored as it comes. Every string value is passed through the Log's `redact` with no home directory first, exactly as an event line is.
- **refused** — a record with a `vinaya.*` name outside the catalogue (reason `contract:<the failing name>`), a span with no identity (`invalid:<why>`), or a record over 1 MiB with its resource and scope (`too_large:<bytes>`, kept with the record alone, its size reckoned before its document is built), kept in `otlp_rejected` with its reason and counted in the export response's partial success (§ 5).

## 4. Storage

```
events(
  seq         INTEGER PRIMARY KEY,   -- arrival order; the read cursor. Never AUTOINCREMENT:
                                     -- rows are never deleted, so rowid is already monotonic,
                                     -- and AUTOINCREMENT costs one more row write per insert
  event_id    TEXT NOT NULL UNIQUE,  -- § 3 identity
  status      TEXT NOT NULL,         -- 'ok' | 'unknown_version'
  ts          TEXT,                  -- meta.ts as sent, for stats only
  received_at INTEGER NOT NULL,      -- server clock, epoch milliseconds
  line        TEXT NOT NULL          -- the event line as stored
)
rejected(
  id          INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL,
  reason      TEXT NOT NULL,         -- 'too_large:<bytes>' | 'invalid:<why>' | 'no_identity'
  line        TEXT                   -- first 64 KiB of the line, for diagnosis
)
otlp_records(
  seq         INTEGER PRIMARY KEY,   -- arrival order of OpenTelemetry records; its own sequence
  record_id   TEXT NOT NULL UNIQUE,  -- § 3 record identity
  kind        TEXT NOT NULL,         -- 'span' | 'log'
  trace_id    TEXT,                  -- lower-case hex; indexed, for one run's records
  received_at INTEGER NOT NULL,      -- server clock, epoch milliseconds
  line        TEXT NOT NULL          -- the record as a one-record OTLP JSON document, redacted
)
otlp_rejected(
  id          INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL,
  kind        TEXT NOT NULL,         -- 'span' | 'log'
  reason      TEXT NOT NULL,         -- 'contract:<name>' | 'invalid:<why>' | 'too_large:<bytes>'
  line        TEXT                   -- first 64 KiB of the redacted record, for diagnosis
)
```

The `UNIQUE` index on `event_id` is the only index `events` and `rejected` carry: each additional one is another row written per event against the daily allowance in § 2. `otlp_records` carries two — the `UNIQUE` index on `record_id` and one on `trace_id` (`otlp_records_trace_id`), which is what reads one run's records without a scan. A refused OpenTelemetry record goes to `otlp_rejected`, never to `rejected`, so the stats route's `rejected` count and the rejected route's report stay about events alone.

One OpenTelemetry export request is one SQLite transaction too: a request answered `200` has every record stored, a duplicate, or kept in `otlp_rejected`.

One ingest is one SQLite transaction: a request answered `200` has every one of its lines durably stored, and a request that fails stored none of them.

**Rows are never deleted, and the counts in § 5 depend on it.** Nothing here removes a row from any of the four tables, which is what lets `seq` be a plain rowid rather than an AUTOINCREMENT column — and, for the same reason, lets the stats route read `MAX(rowid)` as the exact count of each table. `COUNT(*)` would be a scan: at the measured volume before the storage cap is reached (roughly four months), that is millions of row reads for one stats call, against a daily read allowance of five million. Any future change that deletes rows has to replace those two `MAX(rowid)` reads with real counters to keep stats calls bounded.

**The rule holds under replay.** Replaying rejected rows (§ 5, "Replay") only inserts into `events`: a replayed row stays in `rejected`, neither deleted nor updated, and no row in either table is renumbered, so both `MAX(rowid)` counts stay exact. The rejected count is the number of lines ever refused on arrival, not the number still unrecovered.

## 5. The wire contract

Every route lives under `/v1/repos/<owner>/<repo>/`. `<owner>` and `<repo>` match `[A-Za-z0-9._-]+`; anything else is `400`. An unknown path is `404`, a wrong method `405`.

Two tokens, both Worker secrets, never in the repository:

- **`INGEST_TOKEN`** — write-only. Accepted on the ingest route, the two OpenTelemetry ingest routes and the rejected route's replay (`POST`) only. This is the value CI holds as `VINAYA_LOG_TOKEN`.
- **`READ_TOKEN`** — read-only. Accepted on the read, stats, rejected (`GET`), live and OpenTelemetry records routes only.

Each token is compared in constant time — both values are hashed and the fixed-width digests compared byte by byte, so neither a token's length nor the position of its first wrong byte is observable in the time taken. Presenting one token on the other's route is `401`, the same as no token. A token is never logged and never echoed in a response. A route whose secret is not configured at all answers `500`, never `200`: an unset secret must not become a token that matches the empty string.

### Ingest

```
POST /v1/repos/<owner>/<repo>/events
authorization: Bearer <INGEST_TOKEN>
content-type: application/x-ndjson

<one event per line>
```

| Status | Meaning | What the sender does |
|---|---|---|
| `200` | every line stored, a duplicate, or rejected; body `{"accepted":n,"duplicates":n,"rejected":n,"last_seq":n}` | removes the batch from its queue |
| `401` | missing or wrong token | keeps the batch, warns |
| `413` | body over 8 MiB | keeps the batch (the sender never sends more than 5 MiB) |
| `5xx` | the server failed; nothing was stored | keeps the batch, resends it later |

Blank lines are ignored, so a body ending in a newline is not a line of its own.

This is exactly the request `drainOutboxToWebhook` already makes, so the `logs` setting that points at it is the whole integration:

```json
{ "logs": { "url": "https://<worker>.<subdomain>.workers.dev/v1/repos/<owner>/<repo>/events",
            "headers": { "authorization": "Bearer ${VINAYA_LOG_TOKEN}" } } }
```

### Read

```
GET /v1/repos/<owner>/<repo>/events?after=<seq>&limit=<n>
authorization: Bearer <READ_TOKEN>
```

Returns `application/x-ndjson`, one stored event per line, in `seq` order, starting after `after` (default `0`), at most `limit` lines (default and maximum `1000`):

```
{"seq":12,"status":"ok","event":{…the stored line…}}
```

`after` and `limit` must be non-negative integers when present, and `limit` must be at least `1`; anything else is `400`. A `limit` above `1000` is served as `1000` rather than refused.

The response header `vinaya-log-next-after` carries the `seq` to pass as `after` for the next page; an empty body means the reader is caught up, and the header then repeats the `after` that was asked for. The same line shape is what the live feed sends.

### Stats

```
GET /v1/repos/<owner>/<repo>/stats
authorization: Bearer <READ_TOKEN>
```

`{"repo":"<owner>/<repo>","events":n,"rejected":n,"bytes":n,"oldest_ts":"…","newest_ts":"…","last_seq":n,"schema_digest":"sha256:…"}` — `repo` is the object's own lower-cased name, `bytes` is the Durable Object's own database size, and `oldest_ts`/`newest_ts` are the `meta.ts` of the first and last events in arrival order (`null` when the log is empty). Counts come from `MAX(rowid)`, for the reason § 4 gives.

`schema_digest` names the event validator this deployment bundled: `logEventSchemaDigest` from the kernel's Log schema (`harness/kernel/log`), the SHA-256 of a canonical description built by walking the validator's own structure — every object's accepted keys, sorted, every union member, literal, enum value and string or number bound — never a hand-maintained constant, a version number or the source text. The same validator gives the same digest in any process; validators that accept a different key give different ones. The CLI computes its own with the same function and compares the two (`harness/kernel/log/log.md`, the self-test and doctor's `[logs]` finding), so a server left on an older schema — one that rejects or stores verbatim what senders now consider valid — is visible before its rejected count is. A refinement's predicate is opaque code the walk cannot read; only its presence is described.

### Rejected

```
GET /v1/repos/<owner>/<repo>/rejected
authorization: Bearer <READ_TOKEN>
```

Why lines were refused, so lost events can be diagnosed. `{"repo":"<owner>/<repo>","window":1000,"reasons":[{"reason":"…","count":n,"sample":{"received_at":n,"line":"…"}}],"recent":[{"id":n,"received_at":n,"reason":"…","line":"…"}]}`.

`reasons` counts the newest `window` (`1000`) rejected rows by reason, most frequent first; a repository with fewer rows counts them all. `sample` is the newest line in that window for the reason, with the time the server received it: the line is redacted with the same `redact` the sink applies, then cut to its first 512 bytes (redaction first, so a cut never splits a secret into something the patterns miss), so the sender of a refused line can be identified without reading the full record. `sample.line` is `null` when the stored line is. `recent` is the newest twenty rejected rows, newest first, each with the reason and the line as stored — already truncated to the first 64 KiB (§ 4), and possibly `null`. Both come from a read of the table's tail, never a scan of all of it, for the read-budget reason § 4 gives. Nothing beyond what the `rejected` table holds is returned, and the stats route's `rejected` count is unchanged.

The reason values are `invalid:<why>` (the line failed the schema's validation; `<why>` is the validator's own reason), `too_large:<bytes>` (the line was over 1 MiB) and `no_identity` (the line carried no `event_id`). `reasons` groups every `too_large:<bytes>` as `too_large`, because the size would otherwise make each oversized line its own group; `recent` shows the full stored value.

### Replay

```
POST /v1/repos/<owner>/<repo>/rejected
authorization: Bearer <INGEST_TOKEN>
```

Runs the newest `window` (`1000`) rejected rows — read by `id` descending exactly as the rejected report reads them, a bounded read of the table's tail — back through the same per-line decision ingest makes (§ 3), oldest first, for the day a redeploy brings the server's validator level with its senders'. A row whose line validates now is inserted into `events` as an ordinary event, identified by its `event_id` like any other and keeping the time the server first received it; a line already stored — by an earlier replay, or resent by its sender after the redeploy — is counted a duplicate and inserted nowhere; a line that still fails, or a row with no line kept, stays where it is. No row in either table is deleted, updated or renumbered (§ 4). One replay is one transaction, and its new events reach live viewers only after it commits, exactly as an ingest's do. The request body is not read.

`200` with `{"replayed":n,"duplicates":n,"still_rejected":n,"last_seq":n}`. The route takes the ingest token: the read token, a wrong token and no token are all `401`, exactly as on the ingest route.

### Live

```
GET /v1/repos/<owner>/<repo>/live?after=<seq>
upgrade: websocket
sec-websocket-protocol: vinaya-log.v1, bearer.<READ_TOKEN>
```

A browser cannot set an `authorization` header on a WebSocket, so the read token travels as a second subprotocol; the server answers with `vinaya-log.v1` alone and never echoes the token. A client that can set headers — a test, `curl`, a server-side reader — may present the token as `authorization: Bearer <READ_TOKEN>` instead, exactly as on the read route. Either way a missing token, a wrong one and the ingest token are all `401`, checked before anything else about the request, so a caller with no token learns nothing else about the route. A request that is not a WebSocket upgrade, or one that does not ask for `vinaya-log.v1`, is `400`; `after` must be a non-negative integer when present, or `400`, and no socket is opened.

On connect the server sends every stored event after `after`, in `seq` order, as one message per event in the same line shape the read route returns. When more than 1,000 are waiting it sends `{"type":"resync","after":<seq>}` — the position to resume paging from, which is the one the viewer asked for — and closes with code `1013`, rather than replaying an unbounded stretch of the log down one socket; the viewer pages with the read route until it is within 1,000 of the head and reconnects.

Then each new event follows the moment its ingest commits, in `seq` order: only the rows that ingest actually inserted, never the duplicates it counted, and never before they are durably stored. **There is no gap and no repeat between the catch-up and the live part.** The catch-up query and the socket's registration happen in one synchronous turn of the object, with no `await` between them, so no ingest can commit in between: the object is single-threaded only for as long as it does not yield. The replay ends at the head the object had in that turn, and a broadcast only ever carries rows inserted after it. A send to a viewer that has gone away never fails the ingest that is broadcasting — its events are already stored.

Connections use the Durable Object hibernation API, so an idle viewer costs nothing: sockets are accepted with `ctx.acceptWebSocket`, the runtime's own registry is the only place they live, and they survive the object being evicted from memory. Viewers never need to send anything — protocol pings are answered by the runtime, and an incoming message costs twenty times an outgoing one, so anything a viewer does send is ignored.

### OpenTelemetry

Three routes keep a repository's OpenTelemetry records (§ 3, "OpenTelemetry records"), beside the routes above and never on them: no OpenTelemetry record appears on the events read, live, stats or rejected routes. There is no live feed of them, and only OTLP's JSON encoding is accepted, never its protobuf one.

#### Ingest

```
POST /v1/repos/<owner>/<repo>/otlp/v1/traces
POST /v1/repos/<owner>/<repo>/otlp/v1/logs
authorization: Bearer <INGEST_TOKEN>
content-type: application/json

<one OTLP/HTTP JSON export request: ExportTraceServiceRequest or ExportLogsServiceRequest>
```

The two are OTLP/HTTP's signal paths under the address `/v1/repos/<owner>/<repo>/otlp`: the Log SDK's sender, given that address, posts to exactly these. The token is checked first, so a caller with a wrong token learns nothing else about the request.

| Status | Meaning |
|---|---|
| `200` | every record stored, a duplicate, or refused. Body `{}` when none was refused; otherwise `{"partialSuccess":{"rejectedSpans":"<n>","errorMessage":"…"}}` on traces, `rejectedLogRecords` on logs — the count as a decimal string, as OTLP's JSON encoding writes a 64-bit integer, and the message naming the reasons. The `vinaya-log-stored`, `vinaya-log-duplicates` and `vinaya-log-refused` headers carry the three counts |
| `400` | the body is not JSON, or not the export request's shape (its groups, scopes or record lists are not objects and arrays); nothing was stored |
| `401` | missing or wrong token — the read token included |
| `405` | a method other than `POST` |
| `413` | body over 8 MiB, or a request whose records, each with its resource and scope, come to more than 32 MiB together (each counted at most at 1 MiB); nothing was stored |
| `415` | a `content-type` other than `application/json` (parameters such as `charset` are accepted) |
| `5xx` | the server failed; nothing was stored |

A field this server does not know is carried through as it came, as OTLP's JSON encoding requires of a receiver. A refusal body, here as on every route, is `{"error":"…"}`.

#### Records

```
GET /v1/repos/<owner>/<repo>/otlp/records?after=<seq>&limit=<n>&run=<run id>
authorization: Bearer <READ_TOKEN>
```

Returns `application/x-ndjson`, one stored record per line, in arrival order, starting after `after` (default `0`), at most `limit` lines (default and maximum `1000`):

```
{"seq":5,"kind":"span","record":{"resourceSpans":[{"resource":{…},"scopeSpans":[{"scope":{…},"spans":[{…}]}]}]}}
```

`record` is the record as a one-record OTLP JSON document — its resource and its scope with that one record under them — so a reader can hand it to any OTLP JSON consumer unchanged. `after`, `limit` and the `vinaya-log-next-after` header follow the events read route's rules exactly. `run`, when present, keeps only that run's records: those on the trace whose id the Log SDK derives from the run id (`traceIdFor`), read through the `trace_id` index. An empty `run` is `400`, as a malformed `after` or `limit` is. The ingest token, a wrong token and no token are all `401`.

## 6. Deploying a copy

This repository's own instance runs at `https://vinaya-log-server.estevez-dani.workers.dev`, one Worker deployed from this package to the account that also holds `atta-labs/vinaya`'s repository secrets. The default branch's `vinaya.config.json` points `logs.url` at that Worker's ingest route for `atta-labs/vinaya` (§ 5); the ingest credential is never in that file — it is read from the `VINAYA_LOG_TOKEN` environment variable, set as a repository secret for CI and exported in the shell for local runs.

An adopter points their own repository at their own copy the same way, from `apps/log-server`, logged in to Cloudflare with `wrangler login`:

```bash
bunx wrangler deploy
bunx wrangler secret put INGEST_TOKEN
bunx wrangler secret put READ_TOKEN
```

The Durable Object class is declared with `new_sqlite_classes` in its migration: SQLite-backed objects are the only kind the free plan offers, and a paid plan offers them too. Then point `logs.url` at the ingest route (§ 5) for their own `<owner>/<repo>` on the default branch, set `VINAYA_LOG_TOKEN` to the ingest token as a repository secret for CI and in the shell environment for local runs.

Setting `logs.url` moves local runs off the default local folder as well: a Vinaya installation delivers to exactly one destination.

**Pointing a repository's harness at the OpenTelemetry routes.** `logs.otlp` names the address a harness process sends its run's records to — the repository's routes with the `events` tail replaced by `otlp` — with the same credential reference:

```json
{ "logs": { "otlp": { "url": "https://<worker>.<subdomain>.workers.dev/v1/repos/<owner>/<repo>/otlp",
                      "headers": { "authorization": "Bearer ${VINAYA_LOG_TOKEN}" } } } }
```

It sits beside `logs.url`, `logs.headers` and `logs.readHeaders`, which keep delivering events as before. An unattended process reads it from the default branch, as it reads `logs.url`. A process whose environment does not set the credential variable the headers name resolves no address and posts nothing: its records wait in the local copy until the variable is set. Records sent before the server is deployed with these routes are not lost: the old server answers `404`, which the Log SDK's sender retries, so they wait in the local copy and are sent on the first send after the deploy.

**How the Worker reaches the store and the redaction.** The kernel's Log modules (`harness/kernel/log/store.ts`, `redact.ts`, `schema.ts`) re-export the Log SDK package, `@attalabs/vinaya-log-sdk`, by its name. The Worker needs only the stored-event contract (the store's `classifyStoredLine` and `recordIdentity`, `redact`, the schemas), and the package's full entry also holds the writer and the sender, which use Node modules the Worker runtime does not provide. So the Worker's bundle (`wrangler.jsonc` `alias`) and the test pool (`vitest.config.ts`) resolve the package name to `src/log-sdk-contract.ts`, which re-exports those contract modules alone. For the OpenTelemetry routes the store module also re-exports the record check on `vinaya.*` names (`reservedNamesOf`, `checkReservedNames`) and the run's trace id (`traceIdFor`), so they arrive through the same path. No OpenTelemetry package is bundled: export requests are read as plain objects. No route, sequence number or token depends on this.

## 7. Tests run the real runtime

The suite runs under Cloudflare's Vitest pool for Workers: every test drives the actual Worker in `workerd`, with the actual SQLite-backed Durable Object behind it, configured from this package's own `wrangler.jsonc`. There is no hand-written stand-in for the runtime, so a behaviour the tests prove is one a deployed copy has. The two secrets a deployment holds as Worker secrets are supplied to the pool as bindings, which is the one thing a test environment cannot read from a deployment.

The pool's own per-test storage isolation is off, because it cannot pop a SQLite-backed object's directory: it asserts that every file it finds there is a `.sqlite`, and SQLite's `-shm` sidecar trips that assertion, failing the run whatever the tests did. The tests isolate through § 1's own boundary instead — one repository is one object, so a test that needs an empty log asks for a repository name no other test uses.

The OpenTelemetry routes' tests post export requests the Log SDK's own sender posted for a recorded run, never hand-written bodies: `src/fixtures/sdk-export.json` is captured by running a run through the SDK's `connect()` and sending its local copy with `sendLocalCopy` and a capturing `fetch`. The SDK's `tests/sender-capture.test.ts` captures afresh on every run and fails when the bodies differ from the fixture in anything but ids and times, so a change to what the sender posts is caught there; `VINAYA_CAPTURE_SDK_EXPORT=1` on that test rewrites the fixture.

## 8. What this server is not

- Not an authority: nothing reads it to decide what happens next.
- Not a query engine: readers page through the sequence and compute on their own copy (the Log's sync and readers).
- Not a place for secrets, prompts or transcripts: the sender redacts before sending and `classifyStoredLine` redacts again on arrival.
- Not shared between repositories: one object per repository, which keeps one sequence for its events and another for its OpenTelemetry records.
