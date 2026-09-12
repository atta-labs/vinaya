---
"@attalabs/vinaya": patch
"@attalabs/aeg-core": patch
"@attalabs/vinaya-sources": patch
---

`vinaya dispatch` wires a `PreToolUse` deny rule into every claude dispatch's generated settings, refusing a Bash call with `run_in_background: true` and naming the foreground alternative. `devReviewLoop` resumes a developer that stopped without pushing (a dirty worktree or local commits ahead of the remote) once, in the foreground, before folding a still-unpushed turn into `pause{reason:'no_push'}`; a reviewer report with findings but no cited `FINDING_IDS` is sent back once before `report_uncitable` proceeds on its severities, never `no_progress`. The round cap is `reviewPolicy.maxRounds` (default 3), replacing a hardcoded constant. `evaluateReviewFindings` caps a finding located in the PR body, a comment, or a role file at `MINOR` before counting it — prose alone never blocks a merge — and `verdict-extraction`'s finding-severity read now carries each finding's location too, so the merge gate applies the identical cap. `vinaya pr report --push --body-file <path>` composes the whole body from a local source (regenerating Evidence/Tokens fresh) and writes it to the forge outright; bare `--push <n>` is unchanged.
