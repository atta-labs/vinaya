---
"@attalabs/vinaya": patch
---

`vinaya pr report --write`/`--push` no longer refuses the body it has just generated when a Test Plan command's result was reused from a cached green run. The reuse note that follows such a command's fence now carries its digits inside inline code spans — the run's record time, and the `covering N file(s)` phrase for a per-file hit — so `body-bare-digits`, which exempts a digit only inside a code span, a fence, or an anchored region's own bounded value, has nothing left to report. Before this, the note read `_Reused from a green run recorded 2026-…Z (pre-push), covering 14 file(s) …_` and the report refused itself on the ordinary path: the pre-push hook writes that cache on the one push every task makes, so the next `pr report` on that branch always hit it.

The note keeps every fact a reviewer judges reused evidence by — which run, when it ran, its source, and how many files it covered. A command that really ran renders exactly as before, note-free, and the fence stays byte-identical to a fresh run's either way. The `body-bare-digits` rule itself is unchanged: no exemption was added for this line.
