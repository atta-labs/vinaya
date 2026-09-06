---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

A doctrine sentence or source comment that states what code does now binds to the source that proves it. `packages/aeg-core/src/doc-claim.ts` parses an `AEG:CLAIM` marker — an HTML comment in markdown, a `//` or `*` comment line in TypeScript — carrying the premise-pin grammar (`<path> contains:<literal>`, `absent:`, `sha256:`) already used by a brief's `Premise:` block, and re-asserts each pin through the same `checkPremises` predicate. `verify-docs` runs it as C8: blocking in `--pr` mode over the doctrine and product files the diff touched, repo-wide in full mode. Markers inside fenced code blocks are documentation, not claims, and are never evaluated; a marker cannot satisfy itself, because marker lines are stripped from the cited content before a `contains`/`absent` pin is evaluated.

Every statement of the verdict-extraction read window across the repository is bound accordingly, and `pr rule`'s source comment — which still described a three-line window after the window widened to five — is corrected.

`vinaya review post` now refuses a `doc-correctness` finding whose description carries no `Search:` pattern, or whose pattern carries a path filter. The findings-file grammar is unchanged — this is a content rule on the existing description field — and a pattern reaching for `|` alternation now gets an error naming the pipe-delimiter conflict instead of a bare field count.
