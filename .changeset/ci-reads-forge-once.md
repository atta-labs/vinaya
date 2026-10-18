---
'@attalabs/vinaya': patch
---

CI reads the pull request, its comments, the task Issue its body closes and that Issue's comments once per run over REST into a forge snapshot, instead of through `gh pr view` and `gh issue view` in every check and step. The checks read the snapshot only when `GITHUB_ACTIONS` is `true` and the step running them sets `VINAYA_FORGE_SNAPSHOT_DIR`; a local run reads the forge as before. `vinaya-body-checks.yml` gains one read job both check jobs depend on, and every generated job writes the GraphQL budget's used count at its start and end to its job summary. Run `vinaya upgrade` to regenerate the workflows.
