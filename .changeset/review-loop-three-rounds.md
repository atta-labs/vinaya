---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

The review loop now runs at most `reviewPolicy.maxRounds` rounds (three by default) and pauses for the Principal after the review of the round that reaches the cap when it is not green. Before, the default let a fourth round run in full — a developer fix and two reviews — before the Principal was asked, while `vinaya review status` already paused at round three. A green round at the cap still publishes, and the two now pause at the same round for the same history.

The doctrine, the loop spec and the `reviewPolicy.maxRounds` reference state the same cap and only the exits the loop really has: green publishes, and it pauses on a reappearing finding, a blocking finding open in two consecutive rounds, a repeated mechanical failure, a confidence collapse, an escalation, the time budget and the round cap.
