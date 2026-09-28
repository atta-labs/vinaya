---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

A review finding now blocks only where the Developer can act on it this round. One exported function in `@attalabs/aeg-core` (`classifyFinding`) decides whether a finding blocks — the prose cap (a PR-body/comment/role-file location capped to MINOR), the out-of-Surface rule, and the unchanged-line rule — and both the merge gate (`checkReviewGate`) and the dev-review-loop's own classifier (`buildVerdictFromReport`) call it, neither keeping its own copy.

From round 2 on, a code-review finding on a line that did not change between the previous round's head and the current head is deferred rather than blocking (a security finding at or above HIGH still blocks wherever it sits). In any round, a finding in a file the task's `## Surface` `in:` does not cover is deferred. A deferred finding keeps its reported severity and is listed — with its severity, `file:line`, and the reason — in the round's published summary and, when the gate is given the same context, the gate's own output. Round 1, an unrecoverable previous round head, and a gate with no deferral context all fall back to the prior behaviour: every in-Surface finding blocks.
