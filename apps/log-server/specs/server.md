# Log server — the reference destination for Vinaya log events

Status: draft

Everything below ships.

A small server that receives the events a Vinaya installation delivers to a `logs.url` destination (`apps/cli/specs/log.md` § The destination), keeps every one of them, lets a reader page through them from any position, and pushes each new one to live viewers as it arrives. It runs on Cloudflare. The free plan's daily write limit is the first ceiling a busy installation meets (§ 2), and this repository's own deployment has run on the paid Workers plan since 2026-10-01, after reaching it. Any Vinaya adopter can deploy their own copy; the sending side needs no change, because the server accepts exactly what the CLI already sends.

It is telemetry, never authority. Nothing in Vinaya reads this server to decide dispatch, approval, publication or recovery, and an outage here never fails or slows a run: the sender keeps events in its local retry queue until the server is back.

## 1. Shape: one Worker, one Durable Object per repository

- **The Worker** (`src/worker.ts`) is the only public entry point. It checks the bearer token for the route, validates the repository segments in the path, and forwards the request unread to that repository's Durable Object. It never parses a body: a free-plan Worker gets 10 ms of CPU per request, and forwarding a stream costs none of it.
- **`RepoLog`** (`src/repo-log.ts`), one SQLite-backed Durable Object per repository (named `<owner>/<repo>`, lower-cased), is the store, the reader and the live hub for that repository. Because one object owns one repository's log, every write to it is serialized: arrival order is well defined, and the position a reader continues from is simply the row number.

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

The cap was reached on 2026-10-01: a backlog of events queued on developers' machines flushed at once, writes were refused, and every route answered with an error until the plan changed. Senders keep their events in the local retry queue meanwhile, so the loss is bounded by the queue's size. Three ways were open to reduce or absorb the volume; the reference deployment took the third:
- Record fewer repeated events at the source.
- Retire (delete) old rows from the log, tracked against the daily allowance.
- Move to a paid plan on Cloudflare with higher daily limits.

## 3. Identity and duplicates

Every stored event has one identity: `meta.event_id` for a `schema: 2` or `schema: 3` line, `${meta.run_id}:${meta.seq}` for a `schema: 1` line — `recordIdentity` from `@attalabs/aeg-core`'s log module, the same function the sender's storage contract uses, so the server and the sender can never disagree about what counts as the same event. The identity column is `UNIQUE` and every insert is `INSERT OR IGNORE`: a batch resent after a lost acknowledgement stores nothing new and reports the repeats as duplicates.

Each line is classified with that module's `classifyStoredLine`, the same read-side validation and redaction the sender runs before it posts:

- **`ok`** — stored, as the redacted line `classifyStoredLine` returns.
- **`unknown_version`** — a `meta.schema` the server's copy of the schema does not know yet. Stored with its identity and `status: 'unknown_version'`, verbatim, never dropped: a newer sender talking to an older server loses nothing. The sender writes `schema: 3` (`apps/cli/specs/log.md`); until the server is redeployed with the current schema module, every event it sends is stored this way, verbatim, and it validates them once redeployed. A line this build cannot validate is also one it must not rewrite, so no redaction is re-applied to it — the sender already redacted before it posted.
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

**Rows are never deleted, and the counts in § 5 depend on it.** Nothing here removes a row, which is what lets `seq` be a plain rowid rather than an AUTOINCREMENT column — and, for the same reason, lets the stats route read `MAX(rowid)` as the exact count of each table. `COUNT(*)` would be a scan: at the measured volume before the storage cap is reached (roughly four months), that is millions of row reads for one stats call, against a daily read allowance of five million. Any future change that deletes rows has to replace those two `MAX(rowid)` reads with real counters to keep stats calls bounded.

## 5. The wire contract

Every route lives under `/v1/repos/<owner>/<repo>/`. `<owner>` and `<repo>` match `[A-Za-z0-9._-]+`; anything else is `400`. An unknown path is `404`, a wrong method `405`.

Two tokens, both Worker secrets, never in the repository:

- **`INGEST_TOKEN`** — write-only. Accepted on the ingest route only. This is the value CI holds as `VINAYA_LOG_TOKEN`.
- **`READ_TOKEN`** — read-only. Accepted on the read, stats, rejected and live routes only.

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

### Rejected

```
GET /v1/repos/<owner>/<repo>/rejected
authorization: Bearer <READ_TOKEN>
```

Why lines were refused, so lost events can be diagnosed. `{"repo":"<owner>/<repo>","window":1000,"reasons":[{"reason":"…","count":n}],"recent":[{"id":n,"received_at":n,"reason":"…","line":"…"}]}`.

`reasons` counts the newest `window` (`1000`) rejected rows by reason, most frequent first; a repository with fewer rows counts them all. `recent` is the newest twenty rejected rows, newest first, each with the reason and the line as stored — already truncated to the first 64 KiB (§ 4), and possibly `null`. Both come from a read of the table's tail, never a scan of all of it, for the read-budget reason § 4 gives. Nothing beyond what the `rejected` table holds is returned, and the stats route's `rejected` count is unchanged.

The reason values are `invalid:<why>` (the line failed the schema's validation; `<why>` is the validator's own reason), `too_large:<bytes>` (the line was over 1 MiB) and `no_identity` (the line carried no `event_id`). `reasons` groups every `too_large:<bytes>` as `too_large`, because the size would otherwise make each oversized line its own group; `recent` shows the full stored value.

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

This repository's own instance runs at `https://vinaya-log-server.estevez-dani.workers.dev`, one Worker deployed from this package to the account that also holds `atta-labs/vinaya`'s repository secrets. The default branch's `vinaya.config.json` points `logs.url` at that Worker's ingest route for `atta-labs/vinaya` (§ 5); the ingest credential is never in that file — it is read from the `VINAYA_LOG_TOKEN` environment variable, set as a repository secret for CI and exported in the shell for local runs.

An adopter points their own repository at their own copy the same way, from `apps/log-server`, logged in to Cloudflare with `wrangler login`:

```bash
bunx wrangler deploy
bunx wrangler secret put INGEST_TOKEN
bunx wrangler secret put READ_TOKEN
```

The Durable Object class is declared with `new_sqlite_classes` in its migration: SQLite-backed objects are the only kind the free plan offers, and a paid plan offers them too. Then point `logs.url` at the ingest route (§ 5) for their own `<owner>/<repo>` on the default branch, set `VINAYA_LOG_TOKEN` to the ingest token as a repository secret for CI and in the shell environment for local runs.

Setting `logs.url` moves local runs off the default local folder as well: a Vinaya installation delivers to exactly one destination.

## 7. Tests run the real runtime

The suite runs under Cloudflare's Vitest pool for Workers: every test drives the actual Worker in `workerd`, with the actual SQLite-backed Durable Object behind it, configured from this package's own `wrangler.jsonc`. There is no hand-written stand-in for the runtime, so a behaviour the tests prove is one a deployed copy has. The two secrets a deployment holds as Worker secrets are supplied to the pool as bindings, which is the one thing a test environment cannot read from a deployment.

The pool's own per-test storage isolation is off, because it cannot pop a SQLite-backed object's directory: it asserts that every file it finds there is a `.sqlite`, and SQLite's `-shm` sidecar trips that assertion, failing the run whatever the tests did. The tests isolate through § 1's own boundary instead — one repository is one object, so a test that needs an empty log asks for a repository name no other test uses.

## 8. What this server is not

- Not an authority: nothing reads it to decide what happens next.
- Not a query engine: readers page through the sequence and compute on their own copy (the Log's sync and readers).
- Not a place for secrets, prompts or transcripts: the sender redacts before sending and `classifyStoredLine` redacts again on arrival.
- Not shared between repositories: one object per repository, one sequence per object.
