---
"@attalabs/aeg-forge-state": patch
"@attalabs/aeg-core": patch
---

`tranchesAttachedToMilestone` now fetches Issue labels only, server-side filtered and paginated through the buffered `gh` client, instead of a single unpaginated fetch of full Issue bodies — a Milestone holding many Issues with large bodies no longer overruns the process output buffer. The `Depends-on` resolver now resolves a bare backlog Issue number through that Issue's own pull request — by its `task/issue-<n>` branch, or by a `Closes #<n>` reference in a PR body — before falling back to the Issue's own closed/open state, so a merged backlog dependency is recognized as merged and a closed-but-unmerged one is not mistaken for it.
