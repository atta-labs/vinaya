---
"@attalabs/vinaya": patch
---

Dependency and conflict edges now resolve through one shared implementation, and a cross-tranche
`#NNN` dependency is resolved rather than assumed unmerged.

`vinaya check dispatch-readiness` and `vinaya check first-push-dispatch` each carried their own copy
of the resolver, and both hardcoded `merged: false` for any cross-tranche reference — while a comment
in each claimed parity with `verify-dispatch`, which resolves the same edge by looking the Issue up.
The effect was terminal rather than conservative: a task carrying a cross-tranche dependency could
never pass the blocking gate, however long ago that dependency merged, while `verify-dispatch`
reported it ready. The two CLI checks now share `checks/edge-resolve.ts`, and a parity test pins the
answers both sides must give.

Merged means the Issue was closed **by a merged pull request**, not merely closed. An Issue closed
`NOT_PLANNED` was abandoned and shipped nothing; it no longer satisfies a dependency gate.

A conflict edge still reports `openOrInFlight: false` for a cross-tranche reference. A conflict
matters only while a pull request is genuinely open, and Issue state is not evidence of one.

A failed lookup — missing auth, network, rate limit, malformed response, `gh` absent — still resolves
to unmerged, so a forge outage blocks. The lookup cache is keyed by repository and Issue number
rather than by number alone.
