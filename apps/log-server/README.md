# @attalabs/log-server

The reference destination for Vinaya log events: a Cloudflare Worker and one SQLite-backed Durable Object per repository. It receives the NDJSON a Vinaya installation delivers to its `logs.url` destination, stores every event exactly once, pages it back from any position, and pushes each new event to live viewers over a WebSocket the moment it is stored.

Private to this repository — never published to npm. Each adopter deploys their own copy.

`specs/server.md` is the contract: the shape, the plan budget it is sized against, how identity and duplicates work, the storage layout and the wire contract. Read it before changing anything here.

## Layout

| File | What it is |
|---|---|
| `src/worker.ts` | the only public entry point: token check, path validation, forwards the request unread |
| `src/repo-log.ts` | `RepoLog`, the Durable Object: ingest, deduplication, storage, paging, stats, and the live hub; and the OpenTelemetry records' own table, ingest and paging |
| `src/otlp.ts` | the OpenTelemetry routes' pure half: an OTLP JSON export request split into one-record documents, their identities, the catalogue check on `vinaya.*` names, and redaction |
| `src/route.ts` | the path and method grammar both halves parse with |
| `src/log-sdk-contract.ts` | the Log SDK contract modules the Worker bundles, in place of the package's full entry |
| `src/fixtures/sdk-export.json` | the export requests the Log SDK's sender posted for a recorded run, which the OpenTelemetry route tests post |
| `wrangler.jsonc` | the Worker and the `new_sqlite_classes` migration that declares `RepoLog` |

## Working on it

```bash
bunx vitest run --root apps/log-server src/repo-log.test.ts src/worker.test.ts src/otlp.test.ts src/otlp-routes.test.ts
bunx wrangler deploy --dry-run --config apps/log-server/wrangler.jsonc
```

The tests boot the real Workers runtime through Cloudflare's Vitest pool, so they exercise a real Durable Object rather than a stand-in.

## Deploying a copy

From this directory, logged in to Cloudflare with `wrangler login`:

```bash
bunx wrangler deploy
bunx wrangler secret put INGEST_TOKEN
bunx wrangler secret put READ_TOKEN
```

`INGEST_TOKEN` is write-only and accepted on the write routes alone — the events ingest, the replay of rejected lines, and the two OpenTelemetry ingest routes `otlp/v1/traces` and `otlp/v1/logs`; `READ_TOKEN` is read-only and accepted on the read routes alone — events, stats, rejected, live, and the OpenTelemetry records route `otlp/records`. Both are Worker secrets and never live in this repository. A live viewer carries the read token as a second subprotocol, because a browser cannot set a header on a WebSocket:

```
GET /v1/repos/<owner>/<repo>/live?after=<seq>
sec-websocket-protocol: vinaya-log.v1, bearer.<READ_TOKEN>
```

Then point `logs.url` at the ingest route on your default branch, and give CI the ingest token as `VINAYA_LOG_TOKEN`:

```json
{ "logs": { "url": "https://<worker>.<subdomain>.workers.dev/v1/repos/<owner>/<repo>/events",
            "headers": { "authorization": "Bearer ${VINAYA_LOG_TOKEN}" } } }
```

To send your harness's OpenTelemetry records there too, add `logs.otlp` beside it, at the same routes with `otlp` in place of `events`:

```json
{ "logs": { "otlp": { "url": "https://<worker>.<subdomain>.workers.dev/v1/repos/<owner>/<repo>/otlp",
                      "headers": { "authorization": "Bearer ${VINAYA_LOG_TOKEN}" } } } }
```

Full deployment notes are in `specs/server.md` § 6.
