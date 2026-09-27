// The version every generated command pins to — ONE source, shared by the four
// workflows (`vinayaRun`), the two git hooks (`hookRun`), the task-tools MCP
// registration, and a rendered task brief (`briefCliInvocation` below). There
// is deliberately no second source for a generated artifact's pin: the two
// surfaces drifting apart is a real defect that was fixed (the hooks pinned,
// the workflows did not). `doctor.ts` and `quickstart.ts` read the same
// `package.json` for display, but neither feeds a generated artifact, so
// neither can cause that drift — nor can `index.ts`'s own `readVersion()`, the
// third such display reader. The root `VINAYA.md` doctrine pointer
// (`doctrinePointer`) is deliberately left unpinned — it is a reading-order
// hint a human runs by hand, not a CI invocation.
//
// Its own module, rather than `lib/artifacts.ts` where this used to sit, for
// one mechanical reason: `lib/brief-assembly.ts` needs the brief invocation
// below, and importing `artifacts.ts` from there closes an import cycle through
// the task-tools server (`artifacts.ts` -> `task-tools/adapters.ts` ->
// `task-tools/server.ts` -> the handlers -> `dev-review-loop.ts` ->
// `brief-assembly.ts`), which fails at module-evaluation time — a real
// `ReferenceError: Cannot access 'AGENT_VENDOR_NAMES' before initialization`,
// caught by the pre-push suite — rather than at typecheck. This module imports
// nothing but `package-root.ts`, so no importer of it can be in a cycle.
//
// Why exact, and never bare or `@latest`:
//
//   - **Bare is not "latest" — and which way it resolves depends on the
//     adopter.** Where the generated `vinaya-checks.yml` carries an install
//     step — which it does only when the adopter declares `ci.setup` — a
//     devDependency copy of `@attalabs/vinaya` puts `node_modules/.bin/vinaya`
//     on disk and npx prefers it over the registry. Measured 2026-08-17 in
//     atta-labs/attalabs, which declares `ci.setup`: the same bare command
//     resolved 0.8.2 inside that repo and 0.9.0 in /tmp. There, CI's version
//     was an accident of a devDependency no workflow referenced — change or
//     drop it and CI jumps to registry latest with no commit and no diff.
//     An adopter that declares no `ci.setup` gets no install step at all
//     (`adopterSetupStep` returns `''`), so for them a bare spec resolved
//     registry latest in all four workflows, not only the archivist.
//   - **The archivist workflow resolves the other way, and is the sharp end.**
//     It emits no install step (its jobs spawn no adopter code), so an
//     unpinned spec there really did mean registry latest — in three jobs
//     that all hold `issues: write` (two of them `pull-requests: write`, one
//     `pull-requests: read`), covering between them every push to main
//     and nightly. A compromised publish of this package would have run with
//     that token in every adopter, unreviewed. (Origin: a security
//     review of a real published workflow.)
//   - **`@latest` is a different product decision** (deliberately floating CI)
//     and is not what the hooks do.
//   - For the hooks the pin is additionally load-bearing on npx's cache key —
//     see `hookRun`'s own git-hook section in `lib/artifacts.ts`.
//
// The cost is the same one the hooks already pay and `upgrade` already exists
// to settle: the pinned bytes go stale when the CLI is bumped, `doctor` reports
// that as drift, and `vinaya upgrade` re-pins.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { packageRoot } from './package-root.js'
import type { VendoredVinaya } from './self-host.js'

/** This installed package's own version — the hooks, the workflows and a rendered brief all pin to it. */
export function ownVersion(): string {
  const pkg = JSON.parse(readFileSync(join(packageRoot(import.meta.url), 'package.json'), 'utf-8')) as {
    version: string
  }
  return pkg.version
}

/**
 * How a task brief tells its Developer to invoke the CLI — the brief analogue
 * of `vinayaRun`, reusing the same `selfHost` decision so a brief and a
 * generated hook never disagree about how the CLI is reached in a given
 * repository. A brief that named a path only the authoring repository has was
 * unrunnable for every adopter, and read as spoofed instructions to at least
 * one Developer that received one.
 *
 * The published shape is `vinayaRun`'s, for `ownVersion()`'s reasons.
 *
 * The vendored shape deliberately differs from `vinayaRun`'s `node <bin>`:
 * the brief's first act is `git worktree add`, `dist/` is gitignored, and the
 * fresh worktree is where every command the brief names then runs — so the
 * built file does not exist yet. The source entry — the same
 * `<dir>/src/index.ts` `resolveAuthorRepoSourceEntry` resolves — needs no
 * build and is what the vendoring repository's own briefs have always named.
 */
export function briefCliInvocation(selfHost: VendoredVinaya | null): string {
  return selfHost ? `bun ${selfHost.dir}/src/index.ts` : `npx --yes @attalabs/vinaya@${ownVersion()}`
}
