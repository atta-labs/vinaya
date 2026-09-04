---
"@attalabs/vinaya": minor
"@attalabs/aeg-core": patch
---

`vinaya release` runs this repo's own publish sequence in one command — five ordered preconditions (default branch, clean tree, HEAD at `origin/<default>`, a Version Packages commit unless `--allow-any-commit`, `npm whoami`), then streams `bun install --frozen-lockfile`, `bun run build`, `bun run changeset:publish`, and `git push origin --tags`, printing each published package's registry version afterward. `--dry-run` stops after the preconditions and prints the plan.

`checkMainBranchRefusal` (`@attalabs/aeg-core`) now takes an optional `pushRefs` fact — git's own pre-push stdin, forwarded by the generated pre-push hook as `VINAYA_PUSH_REFS` — so a tag-only push (`git push origin --tags`) passes `main-branch-refusal` from the default branch instead of being refused alongside an ordinary commit or branch push.
