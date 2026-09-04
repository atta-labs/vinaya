---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

Every fact the review loop needs is a command output on the forge rather than a sentence somebody wrote.

`aggregateTaskTokenRows` now takes a principal allowlist and reads a comment's `Tokens:` line only when an allowlisted author posted it — every agent in this model posts under the Principal's own forge identity, so an unfiltered read counted a stranger's pasted table as a real turn. `TokenSourcePr.comments` carries `{ body, author }` accordingly.

New: `deriveReviewStatus`/`parseDeveloperRoundMarker` (`@attalabs/aeg-core`) and `vinaya review status <pr>`, which prints `CONTINUE` or `PAUSE: <reason>[ <id>]` for the loop's state — `reappearance`, `zero-deaths`, `stale`, `max-rounds` — plus a `behind main by <n> — merge first` line when the branch is behind its base, and exits non-zero unless the loop is converging at a branch that is not behind. Rounds are derived from the PR's own verdict comments through the same extractors the merge gate blocks on.

`evaluateTestPlanGate` takes optional evidence: a ticked `[agent]` item on a PR with no Developer round comment from an allowlisted author now fails carrying the new `pending` field — "has not happened yet", not "is wrong" — and names the round comment as the remedy instead of telling anyone to paste evidence into a frozen body. `CheckError` gains `pending?: true` for the same distinction.

`checkReviewGate` takes an optional `patchIdOf` and binds a verdict to the PR's patch identity as well as its head sha, so a merge from the main branch or a rebase that leaves the patch untouched no longer voids a review that already read exactly those changes. Fails closed on every uncertainty.

New check `exec-bits` (ring `0`): a changed file under a `checks/bin/` directory, or beginning with a shebang, must be staged `100755` — read from git's index, never the working tree.

Also: the four report-only doctrine sweeps are line-scoped under a resolvable diff, so they report only findings this diff caused; `vinaya doctrine` run from source resolves the repo root's own `aeg-root/` and ignores the git-ignored package-relative bundle, and accepts `--role code-reviewer` as an alias for `reviewer`.
