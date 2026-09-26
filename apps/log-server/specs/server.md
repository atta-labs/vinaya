# Log server — the reference destination for Vinaya log events

Status: draft

A small server that receives the events a Vinaya installation delivers to a `logs.url` destination (`apps/cli/specs/log.md` § The destination), keeps every one of them, lets a reader page through them from any position, and pushes each new one to live viewers as it arrives. It runs on Cloudflare's free plan and costs nothing at the volume measured below. Any Vinaya adopter can deploy their own copy; the sending side needs no change, because the server accepts exactly what the CLI already sends.

It is telemetry, never authority. Nothing in Vinaya reads this server to decide dispatch, approval, publication or recovery, and an outage here never fails or slows a run: the sender keeps events in its local retry queue until the server is back.

## 1. Shape: one Worker, one Durable Object per repository

- **The Worker** is the only public entry point. It checks the bearer token for the route, validates the repository segments in the path, and forwards the request unread to that repository's Durable Object. It never parses a body: a free-plan Worker gets 10 ms of CPU per request, and forwarding a stream costs none of it.
- **`RepoLog`**, one SQLite-backed Durable Object per repository (named `<owner>/<repo>`, lower-cased), is the store, the reader and the live hub for that repository. Because one object owns one repository's log, every write to it is serialized: arrival order is well defined, and the position a reader continues from is simply the row number.

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
- **`unknown_version`** — a `meta.schema` the server's copy of the schema does not know yet. Stored with its identity and `status: 'unknown_version'`, verbatim, never dropped: a newer sender talking to an older server loses nothing.
- **`invalid`**, or a line with no identity at all, or a line over 1 MiB — kept in a separate rejected record with the reason, never in the event sequence.

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
  reason      TEXT NOT NULL,
  line        TEXT                   -- first 64 KiB of the line, for diagnosis
)
```

One ingest is one SQLite transaction: a request answered `200` has every one of its lines durably stored, and a request that fails stored none of them.

## 5. The wire contract

Every route lives under `/v1/repos/<owner>/<repo>/`. `<owner>` and `<repo>` match `[A-Za-z0-9._-]+`; anything else is `400`. An unknown path is `404`, a wrong method `405`.

Two tokens, both Worker secrets, never in the repository:

- **`INGEST_TOKEN`** — write-only. Accepted on the ingest route only. This is the value CI holds as `VINAYA_LOG_TOKEN`.
- **`READ_TOKEN`** — read-only. Accepted on the read, stats and live routes only.

Each token is compared in constant time, and presenting one token on the other's route is `401`, the same as no token.

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

The response header `vinaya-log-next-after` carries the `seq` to pass as `after` for the next page; an empty body means the reader is caught up. The same line shape is what the live feed sends.

### Stats

```
GET /v1/repos/<owner>/<repo>/stats
authorization: Bearer <READ_TOKEN>
```

`{"repo":"<owner>/<repo>","events":n,"rejected":n,"bytes":n,"oldest_ts":"…","newest_ts":"…","last_seq":n}` — `bytes` is the Durable Object's own database size.

### Live

```
GET /v1/repos/<owner>/<repo>/live?after=<seq>
upgrade: websocket
sec-websocket-protocol: vinaya-log.v1, bearer.<READ_TOKEN>
```

A browser cannot set an `authorization` header on a WebSocket, so the read token travels as a second subprotocol; the server answers with `vinaya-log.v1` alone and never echoes the token. On connect the server first sends every stored event after `after` (at most 1,000; when more are waiting it sends `{"type":"resync","after":<seq>}` and closes, and the viewer pages with the read route before reconnecting), then each new event the moment its ingest commits, in `seq` order, with no gap and no repeat between the catch-up and the live part. Connections use the Durable Object hibernation API, so an idle viewer costs nothing, and viewers never need to send anything: protocol pings are answered by the runtime.

## 6. Deploying a copy

From `apps/log-server`, logged in to Cloudflare with `wrangler login`:

```bash
bunx wrangler deploy
bunx wrangler secret put INGEST_TOKEN
bunx wrangler secret put READ_TOKEN
```

The Durable Object class is declared with `new_sqlite_classes` in its migration: SQLite-backed objects are the only kind the free plan offers. Then point `logs.url` at the ingest route (§ 5) on the default branch, set `VINAYA_LOG_TOKEN` to the ingest token as a repository secret for CI and in the shell environment for local runs.

Setting `logs.url` moves local runs off the default local folder as well: a Vinaya installation delivers to exactly one destination.

## 7. What this server is not

- Not an authority: nothing reads it to decide what happens next.
- Not a query engine: readers page through the sequence and compute on their own copy (the Log's sync and readers).
- Not a place for secrets, prompts or transcripts: the sender redacts before sending and `classifyStoredLine` redacts again on arrival.
- Not shared between repositories: one object per repository, one sequence per object.
