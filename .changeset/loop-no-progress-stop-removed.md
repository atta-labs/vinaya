---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

The developer-review loop no longer pauses on "no finding was marked resolved." The round assessment's two-consecutive-rounds-resolve-nothing stop read a resolved-id signal that no reviewer observation ever fills, so it paused loops that had actually addressed every finding after any two consecutive changes-requested rounds. That stop condition and the streak state it needed are removed; consecutive changes-requested rounds now keep dispatching the developer, bounded by the round cap. The `no_progress` reason is retained for the driver's own attach-redelivery pause and for already-written journals; the reappearance check, the round cap, the confidence rule, escalation, and the uncitable-ids resend are unchanged.
