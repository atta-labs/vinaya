---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

The developer review loop now pauses when two consecutive mechanical-gate reads report the same failure, instead of dispatching the developer at it again. The pause is its own reason, `repeat_failure`, and its detail is the failure text exactly as reported. A red gate advances no round number, so until now nothing bounded this: a loop stuck short of review — a premise re-assertion that keeps failing, a check that fails the same way on every head — could send the developer back indefinitely without approaching the round cap.

Two attempts are matched on a normalised signature, never on raw string equality, which two runs of the same failure never satisfy: timestamps, temporary directories, process ids, durations and commit shas are replaced with placeholders, while the message's own words are kept, so `absent: maxRounds` and `absent: reviewers` stay two different failures. A green gate clears the chain, and a gate whose cause could not be named never matches another unnamed one.

The observation this reads is the gate for a head the developer pushed, so a failure that stops the developer before any head appears is out of its reach: a refused push, or a test failing inside the pre-push hook, leaves the loop nothing but an unmoved head and a dirty-file list. Those keep their existing, earlier bounds — one resume then `no_push`, or the stalled-head bound then `infrastructure`.
