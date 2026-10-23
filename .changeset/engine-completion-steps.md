---
'@attalabs/vinaya': minor
---

The Engine runner completes a task the way the standalone loop does. Before the reviewers are dispatched it runs the configured agent-configuration scan, and its output reaches the security reviewer's prompt only; once both reviewers approve it runs the task's `[live]` Test Plan lines, sending a failing line back to the Developer and pausing at the round cap; it writes `journal_finalized` `merged_ready` only after a successful publish; it opens or updates the one deferred-findings Issue when a round set findings aside; and each reviewer prompt carries its role doctrine. The scan's command resolver now lives in a module the standalone loop and the Engine share.
