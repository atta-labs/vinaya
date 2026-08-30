---
"@attalabs/vinaya": minor
---

`vinaya archive` now collects its own turn's real usage figures through the same metering adapter `vinaya tokens` uses, and appends a one-line `Tokens: …` report to the `### AEG provenance` comment it already posts on a merged PR — the Archivist's own row, in the same bare-line grammar the Reviewer/Security roles already use, now durable and `parseTokensLines`-readable from the forge. An incapable host still posts the sanctioned all-`—` line; a capable host that summarized to zero tokens omits the line and flags it `DANGLING (tokens): …` instead of recording a misleading zero — the provenance comment still posts and the Issue still closes regardless. The existing idempotency guard is untouched — a PR that already carries the provenance block is skipped, posting nothing new.
