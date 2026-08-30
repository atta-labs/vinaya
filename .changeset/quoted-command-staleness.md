---
"@attalabs/vinaya": minor
"@attalabs/aeg-core": minor
---

New core check: `quoted-command` (report-only). A doc that quotes a command or config line verbatim, in backticks, as a statement of present fact can now opt that span in with an `AEG:QUOTES-FILE` citation marker naming the file it quotes; the check re-verifies the quoted text still appears there. Marker-based only — no inference, no heuristic fallback for an unmarked command-looking span, since that is the exact false-positive shape that gets a gate disabled. Findings print at `warning` severity and the check's own exit code always stays `0`, so installing it cannot newly redden an existing repo's CI.

The pure evaluator (`findCitedQuotes`/`evaluateCitedQuotes`) ships from `@attalabs/aeg-core`; the check bin and registration ship from `@attalabs/vinaya`.
