---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

The review-loop driver now commits and publishes each Developer turn, so a dispatched Developer never pushes or opens the pull request itself.

Right after every Developer dispatch returns — and before any poll — the driver runs a publication step (`publishDeveloperTurn`): it checks the worktree is on the task branch, at the expected base and the recorded head with every changed path inside the task's Surface; commits the uncommitted changes once under the one-line header the Developer wrote to its round's `.vinaya-commit-header` file (recording the SHA before the push); then pushes the branch and opens the pull request (from the Developer's `.vinaya-pr-body` file, titled from the task Issue) through the Broker's governed `branch-push`/`pr-open` operations, authenticated from the Developer's own launch record. A missing or invalid header, or a failed check, sends the turn back to the same session; a push the pre-push hook refuses is carried by the existing mechanical-failure path; a turn with nothing new is a no-op; and a driver restarted mid-publication finishes it exactly once from a durable record. The Developer's tool grant no longer includes `git push`, `gh pr create` or the repository's `pr create` command, and its doctrine and the loop's resume prompts now tell it to leave its changes uncommitted and write its header and body files.
