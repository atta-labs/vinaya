---
"@attalabs/vinaya": patch
---

A developer launch refused before any process started no longer blocks the task: a launch record with no spawn identity and a terminal refusal is dispatched fresh instead of pausing on a worker continuity that never existed, while a launch that did spawn and lost its session still pauses. A sign-in refusal pauses saying the developer could not sign in and spends none of the loop's infrastructure-retry budget, so repeated sign-in failures never force a ruling to resume.
