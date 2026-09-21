---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

The dev-review loop now rebuilds its round history — round numbers, which rounds happened, and whether the ready-for-merge summary was actually published — from the control store and the pull request's own principal-authored forge markers (developer round markers and the published summary comment), never from a log event, a flushed log comment, or the telemetry outbox. The Vinaya Log is telemetry and is never read to recover a run, so recovery no longer breaks when the log destination moves off the tracker.

A round that merely decided to publish is no longer mistaken for one that published: the honest signal is the summary comment's presence on the forge, so a crash between a green round and its publication still reconstructs as unpublished and resumes on the next round rather than restarting numbering. Per-round values a marker cannot carry (finding counts, confidence, wall time, files changed) are reported unavailable rather than fabricated.
