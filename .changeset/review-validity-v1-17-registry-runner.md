---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
"@attalabs/vinaya-sources": patch
---

`CheckSpec` gains `validates: 'body' | 'issue'`. `vinaya pr create`/`pr edit`/`pr report --push` and `issue create`/`issue edit` now enforce every registered check whose `validates` is `'body'`/`'issue'` through the same runner CI uses — a new check registered later needs no further wiring. Six new core checks (`issue-title-grammar`, `issue-objectives-numbering`, `issue-parts-coverage`, `issue-surface-globs`, `issue-tranche-label`, `issue-milestone-attach`) validate a task Issue's own content at write time and in the coherence sweep. `checkClosesN` is split into `checkClosesNPresence` and `checkClosesNTopology` (two functions, two names, no more collision). The generated `vinaya-checks.yml`/`vinaya-body-checks.yml` re-read a pull request's body with a bounded backoff instead of trusting a single read that can race a `pr report --push`/`pr edit` still landing. The Surface-overlap refusal exempts a shared `tests`/`specs` directory and a glob every open task in a real multi-task Milestone cohort declares. A directory-only §4 (`boundaryNarrowsSurface`) now names its covered consumers' test directories explicitly, and `checkConsumerTests` accepts a bare `tests`/`specs` directory as coverage.
