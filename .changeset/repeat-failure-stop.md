---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

The developer review loop now pauses when two consecutive attempts end on the same mechanical failure — a refused push, a premise re-check mismatch, a forge or network error, a failing pre-push test — instead of dispatching the developer at it again. The pause is its own reason, `repeat_failure`, and its detail is the failure text exactly as reported. A red gate advances no round number, so until now nothing bounded this: a loop that never reached review could send the developer back indefinitely without approaching the round cap.

Two attempts are matched on a normalised signature, never on raw string equality, which two runs of the same failure never satisfy: timestamps, temporary directories, process ids, durations and commit shas are replaced with placeholders, while the message's own words are kept, so `absent: maxRounds` and `absent: reviewers` stay two different failures. A green gate clears the chain, and a red gate whose cause could not be named never matches another unnamed one.
