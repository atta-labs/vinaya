---
'@attalabs/vinaya': patch
---

The version 2 flow's function bag gains `runRoundTests`: a review round's selected tests run as supervised asynchronous children of the repository's native adapter, on the exact head the reviewers judge, one at a time on a host behind a heartbeat lock in the runtime root. Only a verified red run is `failed`; a timeout, a cancel, a drift, a missing adapter and any infrastructure error come back as `none`, `timed_out` or `unavailable` with one line in the driver log. No flow step calls it yet.
