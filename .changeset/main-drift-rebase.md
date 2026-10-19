---
'@attalabs/vinaya': patch
---

When only the default branch's drift on a protected administrative path blocks a `publish_changes`, the review-loop driver now rebases the task branch onto the default branch's tip itself and pushes it with `--force-with-lease` through a new Broker operation, `branch-lease-push`, which only ever targets a `refs/heads/task/` branch and which no Developer tool can reach. A rebase that conflicts is aborted with the branch untouched and refused with the conflicting files named. A changed path whose content equals the default branch is no longer counted as touched by the task, by the Broker push and by the `surface-scope` check alike.
