---
"@attalabs/vinaya-sources": minor
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

Logs never reach a tracker or a code host, in any form. `vinaya log flush`, `vinaya log export-artifact`, `vinaya log collect-artifact`, and the `logPublish` config key that backed them are removed — a config still carrying `logPublish` is refused, naming `logs` (the live destination `vinaya.config.json` already supports) as its replacement. `@attalabs/aeg-core` drops `validateTaskLogArtifact`/`TASK_LOG_ARTIFACT_MAX_BYTES` and the `ArtifactExpectedProvenance`/`ArtifactGap`/`ArtifactValidationResult` types along with the deleted collect path.

`vinaya init`/`vinaya upgrade` no longer generate a task-log-collector workflow or an artifact-export step in `vinaya-checks.yml`; `vinaya upgrade` removes both from a repository that already has them. A CI job's own gate events now deliver live to a configured `logs.url` server destination — a same-repository or default-branch run delivers when a `logs.headers` credential is present; a fork pull request (which never receives a repository secret) records nothing and says so in the job's own output, never falling back to the ephemeral runner's own disk.
