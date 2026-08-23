---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

Close gaps where a verification tool could return a confident wrong answer.

- `pr report` derives a `Summary:` line (files, insertions, deletions, binary
  count) into the evidence block, so a PR body never needs a hand-written count
  that goes stale when a later commit lands. `evidence-fresh` recomputes and
  compares it, and `body-bare-digits` exempts it as machine-emitted. Both call
  one exported resolver — `resolveAnchoredRegionForScan` — which normalises,
  masks and locates the anchor pair in one place, so the line that is exempt is
  the line that is compared. `evidence-fresh` refuses a region enclosed by a
  `<details>` block, where nothing could verify what it claims, rather than
  skipping it as unadopted.
- `review post` rejects unknown flags instead of silently ignoring them, so a
  typo'd flag fails loudly rather than posting a verdict with a default.
- New `symbol-collisions` module in `@attalabs/aeg-core` reports names declared
  in more than one file — the condition that makes a grep-based check
  unresolvable. It is a library function plus a repo-internal gate over
  `aeg-core/src`; it registers no `vinaya check` and runs on no adopter's code.
- `parse-registry.ts` held a NUL byte, which made git treat it as binary: no
  reviewable diff on any PR touching it, and no line numbers from `git grep`.
  The sentinel is now an escape, and a repo-internal test keeps any tracked file
  from carrying one again. Repo-internal: no adopter-facing check is added.
- `body-bare-digits` now explains why an `AEG:*` region lost its exemption
  instead of giving generic advice. The generic advice — fence it — corrupts a
  machine-emitted block and trades one red check for another.
