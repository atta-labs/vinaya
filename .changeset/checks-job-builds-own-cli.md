---
'@attalabs/vinaya': patch
---

The generated `vinaya-checks.yml` job builds its own copy of the CLI at pull-request trust instead of polling for another run's build and downloading it, so it makes no GitHub API call to find a build and no longer needs `actions: read`. The repository's `ci.yml` no longer uploads a CLI build artifact. Run `vinaya upgrade` to regenerate the workflow.
