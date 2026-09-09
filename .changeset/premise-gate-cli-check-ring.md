---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Registers `pr-premise-reassert` in `CLI_CHECK_RING` (`@attalabs/aeg-core`), the mirror table every `apps/cli` check bin needs an entry in. The check itself, shipped in `@attalabs/vinaya`, re-asserts a pull request body's `Premise:` pins against the real tree whenever the block is present — no branch-name condition — so a pin the pull request's own diff falsifies fails instead of merging as decoration.
