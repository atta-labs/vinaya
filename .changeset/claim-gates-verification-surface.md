---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

Close four gaps where a verification tool could return a confident wrong answer.

- `pr report` now derives a `Summary:` line (files, insertions, deletions,
  binary count) into the evidence block, so a PR body never needs a
  hand-written count that goes stale when a later commit lands.
- `review post` rejects unknown flags instead of silently ignoring them, so a
  typo'd flag fails loudly rather than posting a verdict with a default.
- New `symbol-collisions` detector reports names declared in more than one file
  in a package — the condition that makes a grep-based check unresolvable.
- No tracked file may contain a NUL byte. One did (`parse-registry.ts`), which
  made git treat it as binary: no reviewable diff on any PR touching it, and no
  line numbers from `git grep`.
