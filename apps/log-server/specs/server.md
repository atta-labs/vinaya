# Log server — the reference destination for Vinaya log events

Status: draft

Everything below ships.

A small server that receives the events a Vinaya installation delivers to a `logs.url` destination (`apps/cli/specs/log.md` § The destination), keeps every one of them, lets a reader page through them from any position, and pushes each new one to live viewers as it arrives. It runs on Cloudflare's free plan and costs nothing at the volume measured below. Any Vinaya adopter can deploy their own copy; the sending side needs no change, because the server accepts exactly what the CLI already sends.

It is telemetry, never authority. Nothing in Vinaya reads this server to decide dispatch, approval, publication or recovery, and an outage here never fails or slows a run: the sender keeps events in its local retry queue until the server is back.

## 1. Shape: one Worker, one Durable Object per repository

- **The Worker** (`src/worker.ts`) is the only public entry point. It checks the bearer token for the route, validates the repository segments in the path, and forwards the request unread to that repository's Durable Object. It never parses a body: a free-plan Worker gets 10 ms of CPU per request, and forwarding a stream costs none of it.
- **`RepoLog`** (`src/repo-log.ts`), one SQLite-backed Durable Object per repository (named `<owner>/<repo>`, lower-cased), is the store, the reader and the live hub for that repository. Because one object owns one repository's log, every write to it is serialized: arrival order is well defined, and the position a reader continues from is simply the row number.

The path and method grammar of § 5 lives in one pure module (`src/route.ts`) that both halves parse with: the Worker to decide which token a request needs, and the object so that a request reaching it by any other means is still refused rather than trusted.

Nothing else: no D1 database, no R2 bucket, no scheduled job.

## 2. Free-plan budget

Measured on this repository's own local logs from the day check events started being recorded: about 7,000 events a day on average, 15,925 on the busiest day, 925 bytes per event (3 to 15 MB a day). CI adds 10 to 41 check runs a day on top. The design is sized against 20,000 events a day.

| Limit (Workers Free) | Use at 20,000 events a day | Allowance |
|---|---|---|
| Worker requests | at most one per delivered batch, so at most 20,000 | 100,000 a day |
| Durable Object requests | one per ingest, one per read page, one per live connection | 100,000 a day |
| Durable Object SQLite rows written | two per new event (the row and its identity index): 40,000 | 100,000 a day |
| Durable Object SQLite rows read | reads page through by row number, never a scan | 5,000,000 a day |
| Durable Object CPU per request | a 5 MiB batch parses and inserts in milliseconds | 30 seconds |
| Outgoing WebSocket messages | one per event per viewer | not billed |
| Durable Object storage | about 8 MB a day | 5 GB per account, 10 GB per object |

**The one ceiling that arrives on its own is storage: about eighteen months at the measured volume.** The stats route (§ 5) reports each repository's size so that day is visible long before it comes. Moving closed months to compressed archive storage is the planned answer and is not built here.

## 3. Identity and duplicates

Every stored event has one identity: `meta.event_id` for a `schema: 2` line, `${meta.run_id}:${meta.seq}` for a `schema: 1` line — `recordIdentity` from `@attalabs/aeg-core`'s log module, the same function the sender's storage contract uses, so the server and the sender can never disagree about what counts as the same event. The identity column is `UNIQUE` and every insert is `INSERT OR IGNORE`: a batch resent after a lost acknowledgement stores nothing new and reports the repeats as duplicates.

Each line is classified with that module's `classifyStoredLine`, the same read-side validation and redaction the sender runs before it posts:

- **`ok`** — stored, as the redacted line `classifyStoredLine` returns.
- **`unknown_version`** — a `meta.schema` the server's copy of the schema does not know yet. Stored with its identity and `status: 'unknown_version'`, verbatim, never dropped: a newer sender talking to an older server loses nothing. A line this build cannot validate is also one it must not rewrite, so no redaction is re-applied to it — the sender already redacted before it posted.
- **`invalid`**, or a line with no identity at all, or a line over 1 MiB — kept in a separate rejected record with the reason, never in the event sequence.

`classifyStoredLine(raw, home)` rewrites absolute paths under `home` to `~/…`. The server is not the machine that produced the event and has no such directory, so it passes the empty string: every other redaction the function applies — GitHub tokens, `Authorization: Bearer …` values — still runs, and no path rewriting happens on arrival at all.

**Content never makes the server refuse a body.** A sender whose queue holds one bad line must not be stuck behind it forever, so a well-formed request is always answered `200`, with every line either stored, a duplicate, or rejected and counted.

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
```

The `UNIQUE` index on `event_id` is the only index either table carries: each additional one is another row written per event against the daily allowance in § 2.

One ingest is one SQLite transaction: a request answered `200` has every one of its lines durably stored, and a request that fails stored none of them.

**Rows are never deleted, and the counts in § 5 depend on it.** Nothing here removes a row, which is what lets `seq` be a plain rowid rather than an AUTOINCREMENT column — and, for the same reason, lets the stats route read `MAX(rowid)` as the exact count of each table. `COUNT(*)` would be a scan: at eighteen months of the measured volume that is millions of row reads for one stats call, against a daily read allowance of five million. A later change that deletes rows — the archiving of closed months § 2 names — has to replace those two reads with real counters in the same change.

## 5. The wire contract

Every route lives under `/v1/repos/<owner>/<repo>/`. `<owner>` and `<repo>` match `[A-Za-z0-9._-]+`; anything else is `400`. An unknown path is `404`, a wrong method `405`.

Two tokens, both Worker secrets, never in the repository:

- **`INGEST_TOKEN`** — write-only. Accepted on the ingest route only. This is the value CI holds as `VINAYA_LOG_TOKEN`.
- **`READ_TOKEN`** — read-only. Accepted on the read, stats and live routes only.

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

`{"repo":"<owner>/<repo>","events":n,"rejected":n,"bytes":n,"oldest_ts":"…","newest_ts":"…","last_seq":n}` — `repo` is the object's own lower-cased name, `bytes` is the Durable Object's own database size, and `oldest_ts`/`newest_ts` are the `meta.ts` of the first and last events in arrival order (`null` when the log is empty). Counts come from `MAX(rowid)`, for the reason § 4 gives.

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

## 6. Deploying a copy

From `apps/log-server`, logged in to Cloudflare with `wrangler login`:

```bash
bunx wrangler deploy
bunx wrangler secret put INGEST_TOKEN
bunx wrangler secret put READ_TOKEN
```

The Durable Object class is declared with `new_sqlite_classes` in its migration: SQLite-backed objects are the only kind the free plan offers. Then point `logs.url` at the ingest route (§ 5) on the default branch, set `VINAYA_LOG_TOKEN` to the ingest token as a repository secret for CI and in the shell environment for local runs.

Setting `logs.url` moves local runs off the default local folder as well: a Vinaya installation delivers to exactly one destination.

## 7. Tests run the real runtime

The suite runs under Cloudflare's Vitest pool for Workers: every test drives the actual Worker in `workerd`, with the actual SQLite-backed Durable Object behind it, configured from this package's own `wrangler.jsonc`. There is no hand-written stand-in for the runtime, so a behaviour the tests prove is one a deployed copy has. The two secrets a deployment holds as Worker secrets are supplied to the pool as bindings, which is the one thing a test environment cannot read from a deployment.

The pool's own per-test storage isolation is off, because it cannot pop a SQLite-backed object's directory: it asserts that every file it finds there is a `.sqlite`, and SQLite's `-shm` sidecar trips that assertion, failing the run whatever the tests did. The tests isolate through § 1's own boundary instead — one repository is one object, so a test that needs an empty log asks for a repository name no other test uses.

## 8. What this server is not

- Not an authority: nothing reads it to decide what happens next.
- Not a query engine: readers page through the sequence and compute on their own copy (the Log's sync and readers).
- Not a place for secrets, prompts or transcripts: the sender redacts before sending and `classifyStoredLine` redacts again on arrival.
- Not shared between repositories: one object per repository, one sequence per object.
