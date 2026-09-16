#!/usr/bin/env bun

/**
 * Core check: token-report. CI-only (`requiresOpenPr: true`,
 * ring 1 — see `CoreCheckRing`'s doc comment in `registry.ts`): enforces
 * that a PR's "Token report" section — the block `roles/developer.md`
 * requires every self-metering role to paste at turn-end — actually carries
 * real numeric Tokens in/out figures, whenever THIS host is metering-
 * capable. An incapable host (task 1's `resolveMeteringCapability` reports
 * `capable: false`, for ANY reason) passes silently: the operator-metered
 * case is sanctioned, never a defect — the same discipline
 * `token-collection-wired` (task 5, ring 0) already applies.
 *
 * What this check does NOT do: verify the reported figures are TRUE. CI
 * holds no session transcript and structurally cannot recompute them —
 * the same bounded honesty `evidence-fresh` states for its own Group B.
 * This proves presence and shape only, never correctness — see
 * `token-report-enforcement-logic.ts`'s own module doc.
 *
 * Probe-failure vs incapable — the load-bearing distinction this task's
 * brief names as its central hazard — is resolved structurally, not by a
 * special case in this bin: `resolveMeteringCapability` is called with NO
 * surrounding try/catch. A clean return (`capable: true` or
 * `capable: false`, any reason) is a real verdict and flows into
 * `evaluateTokenReportEnforcement` below. An unexpected throw — `exists`/
 * `readFile` failing in a way the probe itself does not catch (it only
 * wraps its OWN `readFile` call; `exists` is not wrapped) — instead
 * propagates uncaught. Node's resulting non-JSON stack trace on stderr
 * fails `runner.ts`'s `isCheckError` parse for every line, which sets
 * `status: 'error'` regardless of exit code ("a check that emits garbage
 * must be loud, never a silent pass" — `runner.ts`). That is a
 * structurally distinct, louder outcome than the `status: 'pass'` a clean
 * incapable verdict produces: a broken probe can never read as an
 * incapable host.
 *
 * scope: diff — the artifact under test is the PR body, not repo files,
 * same convention as `closes-n`/`test-plan`/`body-bare-digits`.
 *
 * The no-row refusal is task-PR-only: a release PR
 * the changesets bot opens can never carry a "develop" turn's row, so it
 * is scoped out via `isTaskBranch(branch)` — the same shared predicate
 * `check-brief-shape.ts`/`check-branch-topology.ts`/`check-surface-scope.ts`
 * already use, not a second spelling of it.
 */

import { lstatSync, readFileSync } from 'node:fs'
import { isTaskBranch, resolveMeteringCapability, type MeteringCapabilityDeps } from '@attalabs/aeg-core'
import { emitCheckError } from '../contract'
import { evaluateTokenReportEnforcement } from '../token-report-enforcement-logic'

const CHECK_NAME = 'token-report'

/**
 * Same symlink-/owner-hardened stat/read as `check-token-collection-wired.ts`
 * — duplicated rather than imported: that file is another task's
 * shipped surface (consume only, per this task's brief), and the threat
 * model it hardens against (a co-resident local user racing a shared
 * `TMPDIR` pointer path) applies whenever this check runs from a
 * developer's own machine, not only in CI — `vinaya check --all
 * --diff-only`, unlike `--local`, does not skip `requiresOpenPr` checks
 * (`CheckSpec.requiresOpenPr`'s own doc comment).
 */
function safeLstat(path: string): { ok: true } | { ok: false } {
  try {
    const st = lstatSync(path)
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false }
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { ok: false }
    return { ok: true }
  } catch {
    return { ok: false }
  }
}

function main(): void {
  const deps: MeteringCapabilityDeps = {
    env: process.env,
    cwd: process.cwd(),
    exists: (path: string) => safeLstat(path).ok,
    readFile: (path: string) => {
      // Re-checked immediately before the read — narrows, does not close,
      // the TOCTOU window (same defence-in-depth reasoning as
      // `check-token-collection-wired.ts`'s identical comment).
      if (!safeLstat(path).ok) throw new Error(`refusing to read ${path}: not a regular file owned by this user`)
      return readFileSync(path, 'utf8')
    }
  }

  const capability = resolveMeteringCapability(deps)
  const prBody = process.env.PR_BODY ?? ''
  // Same `process.env.BRANCH ?? ''` shape as `check-brief-shape.ts`'s
  // identical requiresOpenPr/scope:diff check — declared in `registry.ts`
  // so the runner forwards it rather than stripping it before spawn.
  const branch = process.env.BRANCH ?? ''
  const isTaskPr = isTaskBranch(branch)
  const result = evaluateTokenReportEnforcement(CHECK_NAME, capability, prBody, isTaskPr)

  if (!result.pass) {
    emitCheckError(result.error)
    process.exit(1)
  }

  process.exit(0)
}

main()
