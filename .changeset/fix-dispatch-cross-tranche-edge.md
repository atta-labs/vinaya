---
"@attalabs/vinaya": patch
---

`vinaya check dispatch-readiness` now resolves a cross-tranche `#NNN` dependency instead of
hardcoding it unmerged.

The check parsed the Issue number out of the edge and then discarded it, returning `merged: false`
unconditionally — while a comment claimed parity with `bin/verify-dispatch.ts`, which resolves the
same edge by looking the Issue up. The two disagreed: `verify-dispatch` reported READY, the CI gate
blocked. The effect was not conservative but terminal, since no retry and no amount of elapsed time
could clear it: a task carrying a cross-tranche dependency could never go green, however long ago
that dependency merged.

A failed lookup still returns unresolved, so a forge outage stays conservative. An edge that is
neither a same-tranche task id nor a `#NNN` reference is unchanged — that remains genuinely
unresolvable with this check's toolset, and is the one case where the conservative default is the
honest answer.
