---
"@attalabs/vinaya": minor
"@attalabs/aeg-core": minor
---

`vinaya task brief` refuses to render when the checkout is behind the fetched remote default branch or dirty on a file the brief pins, naming the drift; the frozen brief's own §2 now states the source revision its pins were computed from, and the dev-review-loop's reviewer prompt names that revision as a fact. `vinaya task brief <tranche> <n> --supersede --reason <text>` appends a new, higher-versioned frozen brief comment naming its predecessor and the reason — the original is never edited or deleted, and every reader of "the frozen brief" (the loop, `check-brief-shape`) resolves the newest version via `@attalabs/aeg-core`'s new `resolveNewestFrozenBrief`.
