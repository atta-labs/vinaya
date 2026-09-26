# @attalabs/log-server

The reference destination for Vinaya log events: a Cloudflare Worker and one SQLite-backed Durable Object per repository. It receives the NDJSON a Vinaya installation delivers to its `logs.url` destination, stores every event exactly once, pages it back from any position, and pushes each new event to live viewers over a WebSocket the moment it is stored.

Private to this repository — never published to npm. Each adopter deploys their own copy.

`specs/server.md` is the contract: the shape, the free-plan budget it is sized against, how identity and duplicates work, the storage layout and the wire contract. Read it before changing anything here.

## Layout

| File | What it is |
|---|---|
| `src/worker.ts` | the only public entry point: token check, path validation, forwards the request unread |
| `src/repo-log.ts` | `RepoLog`, the Durable Object: ingest, deduplication, storage, paging, stats, and the live hub |
| `src/route.ts` | the path and method grammar both halves parse with |
| `wrangler.jsonc` | the Worker and the `new_sqlite_classes` migration that declares `RepoLog` |

## Working on it

```bash
bunx vitest run --root apps/log-server src/repo-log.test.ts src/worker.test.ts
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

`INGEST_TOKEN` is write-only and accepted on the ingest route alone; `READ_TOKEN` is read-only and accepted on the read, stats and live routes alone. A live viewer carries the read token as a second subprotocol, because a browser cannot set a header on a WebSocket:

```
GET /v1/repos/<owner>/<repo>/live?after=<seq>
sec-websocket-protocol: vinaya-log.v1, bearer.<READ_TOKEN>
``` Both are Worker secrets and never live in this repository.

Then point `logs.url` at the ingest route on your default branch, and give CI the ingest token as `VINAYA_LOG_TOKEN`:

```json
{ "logs": { "url": "https://<worker>.<subdomain>.workers.dev/v1/repos/<owner>/<repo>/events",
            "headers": { "authorization": "Bearer ${VINAYA_LOG_TOKEN}" } } }
```

Full deployment notes are in `specs/server.md` § 6.
