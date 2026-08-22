---
"@attalabs/vinaya": patch
---

`body-bare-digits` is dormant again on the Changesets release PR (`changeset-release/main`) — safely this time. The exemption now runs only from a new `vinaya-body-checks.yml`, a `pull_request_target` workflow that checks out and executes only trusted default-branch code, the same boundary `vinaya-review.yml` already uses for the required review gate. `vinaya-checks.yml`'s ordinary `pull_request` job never runs `body-bare-digits` at all — that check is `ownWorkflow: true` — because that job runs the pull request's own copy of the workflow file, which cannot safely resolve the exemption's live-fetched PR author.

A new `vinaya.config.json` field, `releaseActor`, lets an adopter whose release PRs are opened by a custom token (rather than the stock `changesets/action` + ambient `GITHUB_TOKEN` identity) configure the expected author — resolved the same way `principals` already is, from the default branch via the GitHub API, never from local git or an env var.
