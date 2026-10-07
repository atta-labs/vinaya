---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

New `vinaya task-tools review-result-proof --agent <claude|codex>` runs real reviewer-shaped dispatches on this host and checks that each CLI hands back a reviewer's result as its own structured final output: Claude Code through `--json-schema` and Codex through `--output-schema`, for both the code-reviewer and the security-reviewer, running concurrently against one manifest in fresh sessions with read-only grants. The schema is the new versioned `ReviewResult`, with two variants keyed by `status`: `completed` and `blocked`. The controller binds each result to its own role, head and manifest digest, and refuses a role mismatch, a stale head or digest, an objective id outside the brief, a severity outside the role's scale and a finding with no file. A missing, malformed, blocked, cancelled, context-exhausted or provider-errored run is recorded as no review, never approval. The command prints, for each case, whether a schema-valid result reached the driver. Loop behaviour does not change.
