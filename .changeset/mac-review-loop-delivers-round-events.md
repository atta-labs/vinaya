---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

A review-loop run started on a developer's Mac now delivers its round events to the configured `logs.url` server, exactly as the same run on the Linux VPS already did. The once-per-process trust-anchor read that decides a run's whole log destination was bounded by the 3s per-event `LOG_CONTEXT_LOOKUP_DEADLINE_MS`; a Mac clears that `gh api` read in a few seconds (keychain-backed auth cold-start plus a home-network round-trip), so the bound expired on every Mac run and rerouted its telemetry to the local folder silently, while the VPS cleared it in well under a second. That read now has its own longer `LOG_DESTINATION_ANCHOR_DEADLINE_MS` (15s), and the `gh`/`git` anchor children are killed with `SIGKILL` so a genuinely hung child never holds the process open.

When an unattended run that configured a `logs.url` server cannot use it, it no longer falls back to the local folder silently: `log()` prints one line per process naming why (the default branch's config could not be read, or does not declare this url), and `vinaya doctor` reports the same reason.

New: `vinaya log send` delivers a repository's locally-held log events — the local default folder's events, and any retry-queue backlog or draining file a dead drain left behind — to the configured server, once, through the same webhook delivery a live event uses. It is idempotent (the server deduplicates by event id) and reads the destination the same way a normal event does, never a URL on the command line.
