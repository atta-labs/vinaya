---
"@attalabs/aeg-core": patch
---

Adds `@attalabs/aeg-core`'s control-store: versioned run/input/ownership/transition records with a strict parser that refuses an unknown version or torn content as corrupt (never as absent), one local storage implementation with atomic durable writes and epoch-fenced ownership (a stale-epoch write is refused inside the store, not left to the caller to check), and a one-time migration from the dev-review-loop's legacy `driver.pid.json`/`pause-state.json`/`effect-*.json` side files. Not yet wired into the live driver — this is the new store and its migration path; adoption is a later task.
