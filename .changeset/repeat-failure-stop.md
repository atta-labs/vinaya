---
'@attalabs/aeg-core': patch
'@attalabs/vinaya': patch
---

The developer review loop now pauses when the same mechanical failure ends two consecutive attempts, instead of dispatching the developer at it again. The pause is its own reason, `repeat_failure`, and its detail is the failure exactly as reported. Nothing bounded this before: a red gate advances no round number, so a loop stuck short of review could send the developer back indefinitely without approaching the round cap.

Three kinds of attempt report their failure to the assessment: a mechanical gate that came back red for a pushed head (its failing check-runs, and any premise re-assertion that failed against the live body at that head); a push that was made and never landed — refused by a pre-push hook's own test run, or by the remote — which the loop reports as the branch, the unmoved head and the commits still waiting on it, since the refusal text itself never leaves the developer's session; and a stalled turn whose cause the loop can name, such as a conflict it never resolved. A turn that committed nothing attempted no push and reports nothing, keeping its existing one-resume-then-`no_push` bound; so does a stall with nothing to name, keeping the stalled-head bound and its `infrastructure` pause.

Two attempts are matched on a normalised signature, never on raw string equality, which two runs of the same failure never satisfy: timestamps, temporary directories, process ids, durations and commit shas are replaced with placeholders, while the message's own words are kept, so `absent: maxRounds` and `absent: reviewers` stay two different failures. A green gate clears the chain, and a failure that could not be named never matches another unnamed one.

Both repeat detectors — the previous reviewed round's blocking findings and the previous attempt's failure — are now carried in the control-store `loop_state` record, so a driver that re-execs itself mid-loop (the base branch moving over its own code) or an attach that starts fresh continues counting instead of forgetting that a finding or a failure had already repeated.
