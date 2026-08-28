---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

Registers `main-branch-refusal` as a real, adopter-runnable ring-0 core check (`coreCheckRegistry()`):
refuses a commit or push whose current branch IS the repo's default branch, mechanizing the
worktree-plus-PR rule for every adopter through `vinaya init`'s generated `check --all --local` hooks —
today that rule reached only this monorepo's own hand-written husky script, with a real direct push
detected post-merge (`vinaya audit --only=direct-push`).

The discriminator is the SYMBOLIC current branch, not any derived name: `git symbolic-ref --short HEAD`
equaling the local `origin/HEAD`-derived default branch refuses; a detached HEAD (every CI checkout)
always passes, never refused. The default branch is never hardcoded as `main` — when it cannot be
resolved locally, the check fails open with a `warning` finding instead of risking a false block. A
genuine refusal is a real failure (`error`, exit `1`): this is an action refusal, not a doctrine-parity
report, so report-only would defeat the check's one job.
