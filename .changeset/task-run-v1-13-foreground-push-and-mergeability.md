---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
---

The developer contract states the push and the pull-request open are foreground steps; `dev-review-loop` checks this rather than trusting it. A round-1 turn that ends without a push, or without an open PR, is resumed ONCE with the exact commands before the loop ever polls — a turn that ends with no push and a posted refusal/escalation ends the loop at once instead, on the task Issue, never entering the poll. A poll that still gives up names branch, local head (if the worktree is known), remote head, and pull-request existence.

Mergeability is now read from the forge before dispatching a round's reviewers and again before publishing: a conflicting head is sent back to the developer with the conflicting file(s) named (never a reviewer dispatch, never a CI wait) and, if a clean head falls into conflict while reviewers were working, that round's held verdicts are discarded and the developer is resumed to resolve. A base that moves past the driver's own code mid-run pauses the loop (`stale_driver`) rather than let it keep judging rounds against, and eventually publish against, a gate that has since changed underneath it.

`vinaya task run` (and `dev-review-loop`/`dispatch`) resolve `--agent` from `dispatch.agent` in `vinaya.config.json` when the flag is omitted entirely.
