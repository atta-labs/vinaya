---
"@attalabs/aeg-core": minor
"@attalabs/vinaya": minor
---

`reader-resolvable-prose`'s `checkUnresolvableReferences` gains a fourth `ProseFileClass`, `product` — a tranche-slug citation under the new exported `PRODUCT_SLUG_SCOPE` (CLI source, the CLI and sources READMEs, the workflows, `.vinaya`) is a `blocking: true` finding, where every other class stays `blocking: false`. `check-reader-resolvable-prose.ts` sweeps that scope alongside the doctrine tree, prints a blocking finding as `severity: 'error'`, and exits `1` if any reportable finding is blocking — the check still exits `0` for every other class. It runs at the pre-push hook (already `scope: 'full'`, so already in `--local`'s sweep) and, blocking, in CI.

`retired-vocabulary.test.ts` no longer greps `apps/cli/src`/`.github/workflows`/`.vinaya`/the two product READMEs for a tranche-slug citation — that scope, and the pattern itself, moved entirely to `reader-resolvable-prose.ts`'s `PRODUCT_SLUG_SCOPE`, closing the gap where a change to one package's files could pass the push hook through another package's cached test result (a CLI-only diff never marked `aeg-core` affected).
