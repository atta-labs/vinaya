---
"@attalabs/aeg-core": patch
"@attalabs/vinaya": patch
---

Registers `reader-resolvable-prose` and `retired-vocabulary` as real, adopter-runnable core checks
(`coreCheckRegistry()`), so an installed `vinaya check --all` actually runs them instead of only this
monorepo's own internal dev loop.

`reader-resolvable-prose`'s three repo-specific inputs — doctrine root, reader-facing page globs, and
the legacy-slug archive location — now come from `vinaya.config.json`'s new `proseGates` key, read fresh
on every check run. Unset entirely, both checks keep this repo's own prior hardcoded shape
(`doctrineRoot: "aeg-root"`, a dormant reader-facing sweep), so an existing install sees no change until
it opts in. `retired-vocabulary` gives `retired-vocabulary.test.ts`'s genuinely-retired vocabulary scan
(never its forge-number/tranche-slug citation half, which stays `reader-resolvable-prose`'s job) a
CheckSpec adapter for the first time, scoped to `<doctrineRoot>/**`.

Both ship report-only (a `warning` finding, exit code always `0`), same rollout precedent as the G1/G2
gates — registering them cannot newly fail any existing install's CI.

Also fixes a latent bug the registration surfaced: `check-reader-resolvable-prose.ts`'s
`REPO_ROOT`/`process.chdir()` computed its OWN installed-package location rather than the caller's repo
root, and both new checks' human-readable summary line printed to stderr — the CheckError JSON channel —
which the runner reads any non-JSON line on as `status: 'error'` regardless of exit code. Neither bug was
reachable before this task, since neither check had ever run outside this monorepo's own dev loop or
through the check runner at all.
