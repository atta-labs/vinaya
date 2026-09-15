---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
"@attalabs/vinaya-sources": patch
---

Task-path CI evidence now survives its own job log. `vinaya init`/`upgrade` install a new generated workflow, `vinaya-task-log-collector.yml`, that runs on the default branch with its own credential: it downloads the artifact a task-path job's new "Export task-log artifact" step uploads (bounded, exported even on failure or cancellation), validates it — schema, size, redaction, and a repo-provenance cross-check — and publishes only the accepted records through the existing flush path, reporting every rejected record as a named gap. New `@attalabs/aeg-core` exports: `validateTaskLogArtifact`, `TASK_LOG_ARTIFACT_MAX_BYTES` (plus the `ArtifactExpectedProvenance`/`ArtifactGap`/`ArtifactValidationResult` types). New CLI commands: `vinaya log export-artifact` and `vinaya log collect-artifact`.
