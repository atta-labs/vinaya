---
"@attalabs/vinaya": minor
---

`vinaya pr report` gains `--push <pr>`: the post-open sibling of `--write`. It fetches the PR's LIVE body from the forge, splices the freshly-built `AEG:EVIDENCE` and `AEG:TOKENS` content into it through the same anchor resolver `--write` uses, pushes the result via `gh pr edit`, then re-reads the live body and refuses — restoring the pre-edit body — unless the pre-push and post-push bodies agree byte-for-byte outside those two anchored regions. This is the one sanctioned post-open write `aeg-root/roles/developer.md` now names as a single command, replacing a five-line manual sequence (fetch the body, export two env vars, regenerate, diff, edit) that three review rounds on `#383` spent finding failure modes in — most seriously, a whole-body overwrite that could erase a Principal's `[principal]` tick.

`--push` refuses before writing anything when the live body carries no real `AEG:EVIDENCE` anchor pair (unlike `--write`, it never appends one — a live PR body without the pair is malformed) or when the anchor's raw and normalised resolutions disagree. `--write` and `--push` are mutually exclusive. `--push` also exports `PR_BODY`, `PR_NUMBER`, and `BRANCH` before running the gate suite, so `evidence-fresh` actually compares against this PR's real state instead of silently skipping for want of `PR_NUMBER` — the gap the manual sequence left open.
