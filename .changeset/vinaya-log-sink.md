---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

`log(e)` exists: a typed event validated by one zod schema (`@attalabs/aeg-core`'s new `log/` — `LogEventSchema`, `buildHeader`, `redact`), written by one hardened sink (`apps/cli/src/lib/log-sink.ts`) to a per-task ndjson outbox under `~/.vinaya/outbox/<owner>-<repo>/<issue-or-none>.ndjson`. The header (`meta`/`subject`) is filled from the environment, the origin remote, the package version and the doctrine tree in force — never self-declared by a caller. Two families ship: `dispatch` (`dispatched`, `outcome_received`, `dispatch_failed`) and `dev_review_loop`'s ten events; the other four families named in the Vinaya Log spec are out of scope here.

`log()` never throws and has zero real callers yet — `dispatchRole` and `devReviewLoop` land in a later task, proved by a test that fails on the first caller outside that pair. See `apps/cli/specs/log.md`.
