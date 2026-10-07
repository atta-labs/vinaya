---
'@attalabs/vinaya': patch
'@attalabs/vinaya-sources': patch
---

New `vinaya task-tools result-proof --agent <claude|codex>` runs real Developer-shaped dispatches on this host and checks that each CLI hands back the Developer's turn result as its own structured final output: Claude Code through `--json-schema` and Codex through `--output-schema`, on both a first and a resumed session. The schema is the new versioned `DeveloperTurnResult`, with three variants keyed by `status`: `completed`, `blocked` and `needs_ruling`. For each case the command prints whether a schema-valid result reached the driver, what the result was, and which event it came from. It also checks rejections. The driver refuses a result naming an unknown finding id, or a ruling request naming no permissible decision. Malformed output never reaches the driver. A cancelled run, a provider error and context exhaustion each end with no accepted result. Loop behaviour does not change.
