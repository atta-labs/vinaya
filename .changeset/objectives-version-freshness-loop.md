---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

`devReviewLoop` (`@attalabs/vinaya`) now sources a task's objectives from the newest principal-authored `vinaya issue objectives edit` comment when one exists, and from the principal-authored frozen brief otherwise — never the live Issue body — with a version computed the same way the merge gate computes its own, so a loop-published verdict now carries a real `Objectives version:` line and `OBJECTIVES:` block instead of a hardcoded `null`, and passes the gate on a post-cutover task. If the objectives version changes between dispatching a round's reviewers and their verdicts coming back, the round's verdicts are discarded — never held, never published — and the loop pauses with a new `'objectives_changed'` pause reason (`@attalabs/aeg-core`) naming the old version, the new version, and the edit command that caused it.
