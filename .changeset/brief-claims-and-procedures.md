---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

`brief-shape` gains four new refusals (task 9's "no unpinned code claim, no scripted doctrine" rule, made mechanical — Issue #385): a bare `<path>.<ext>:<digits>` code-fact reference outside a `Premise:` pin and outside a fenced code block; a `§5`/`§6` fenced command block (`export`/`bun`/`gh`/`git`/`grep`/`sed`/`cat`/`diff`/`vinaya`) with no fenced output block after it (the Step `0` `git worktree add` block is exempt); a `§4` naming a path under `packages/<pkg>/` with no named consumer test path or `consumer-tests: none — <reason>` sentinel for a workspace package depending on `@attalabs/<pkg>`; and a `§4` naming a check or a forge-writing command with no `Defeat cases:` line in `§6`. A new check, `doctrine-no-procedures`, refuses a fenced block in `aeg-root/**/*.md` (or an adopter's configured `doctrineRoot`) carrying two or more shell-command lines — a runbook, not an illustration — exempting the `AEG:VENDOR-EXAMPLE` anchor pair and any `templates/` file; unlike its report-only sibling `doctrine-portability`, this check blocks (`severity: error`, exit `1`) since it ships with an expected-zero corpus.
