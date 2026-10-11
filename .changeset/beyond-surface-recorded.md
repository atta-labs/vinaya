---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

A change beyond a task's Surface is recorded in the pull request and reviewed, never refused at publication. `publish_changes` publishes a changed path the Surface does not cover and names it back; the review-loop driver writes every such path, with the `out:` glob it crosses or the `in:` list it misses, into the body's driver-owned `AEG:BEYOND-SURFACE` block on every body write. The review policy defers an outside-Surface finding only when the branch did not change its file. The `surface-scope` check now reads that block from the pull request body and fails naming the first unrecorded beyond-Surface path; it needs the open pull request, so the local hooks skip it. The `outside_surface` blocker kind is removed from the Developer's turn result, with the loop's retry for it.
