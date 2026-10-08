---
'@attalabs/vinaya': patch
'@attalabs/aeg-core': patch
---

A review finding on the pull request body now reaches the Developer instead of being set aside as outside the Surface. Reviewers read the body from a file the loop stages for them, and a finding they located on that file used to be deferred in every round, so the Developer never saw it. The loop now records such a finding at `PR body`, where it is capped at MINOR like any other body finding and kept in the verdict the Developer receives. Both reviewer prompts and the reviewer doctrine now say that an unmet objective is reported `NOT MET` in the objectives file with code or test evidence, never only as a finding on the body.
