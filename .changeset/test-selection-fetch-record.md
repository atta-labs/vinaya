---
'@attalabs/test-selection': minor
---

The `test-selection` command takes `--fetch-record`: it finds the read record of the base commit, or of the nearest of the nine commits before it that has one, kept under the git directory or fetched with `gh`, and selects with it. The package exports the search as `findReadRecord`, with `RECORD_WORKFLOW_FILE` and `RECORD_ARTIFACT_PREFIX`.
