---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

`vinaya task run`'s exit summary now names a working continuation command for the one pause that has no pull request. A pause the review loop records before any push — the pre-first-push escalation — carries its pull request as absent (`0` or `-1`), yet the exit-`1` summary still printed `Resume with: vinaya dev-review-loop --resume 0` / `--resume -1`, a command that cannot work because `dev-review-loop --resume` derives its task from a pull request. It now prints `vinaya task run --issue <n>` for that case — the same working command the pause comment on the task Issue already names — and prints the `dev-review-loop --resume <pr>` form only when a real pull request exists (`prNumber > 0`), carrying the run's own `--agent`/`--model` unchanged in both.

The `task run` catalog entry `vinaya --help` shows, which described the exit case as carrying "the exact `vinaya task run <tranche> <n>` command", now describes it with that same working `--issue <n>` command. `apps/cli/specs/loop.md`'s "The driver never ends on a pause" section, which recorded the old printed command as a still-unfixed defect, is updated to the working one.
