---
"@attalabs/vinaya": patch
---

The `dead-branch-push` and `first-push-dispatch` checks now write one `warning` finding, and still allow the push, when the forge cannot vouch for it: the branch's pull-request state could not be read, or dispatch readiness is unknown. A failed pull-request lookup in `first-push-dispatch` is no longer read as "no pull request".
