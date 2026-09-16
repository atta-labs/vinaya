#!/usr/bin/env bun

/**
 * Core check: pr-premise-reassert. Re-asserts a pull request BODY's
 * `Premise:` pins against the real tree, so a pin the PR's own diff
 * falsifies fails CI instead of merging as decoration.
 *
 * A second caller of `../premise-reassert-logic.ts`'s `reassertPremiseFile` —
 * `check-dispatch-readiness.ts`'s `PREMISE_FILE` path already re-asserts a
 * FILE handed to a dispatch, at Step 0 only, off any non-task branch. This
 * check re-asserts the BODY that reaches the forge, on every branch, in CI —
 * `reassertPremiseFile` and the pin grammar it delegates to
 * (`parsePremiseBlock`/`checkPremises`, `@attalabs/aeg-core`) are consumed
 * unchanged; this file is wiring, not a second implementation.
 *
 * Trigger is the block's presence and nothing else: a body with no
 * `Premise:` header parses to zero assertions and this check is silent —
 * there is no branch-name condition anywhere below. `reassertPremiseFile`
 * itself treats zero assertions as a hard failure ("a premise file with no
 * pins is a mistake") because its existing caller is handed a file the
 * dispatch process itself named — a file that exists but names no pins IS a
 * mistake there. An ordinary PR body has no such expectation: most bodies
 * never carry a `Premise:` block at all, so `parsePremiseBlock(prBody).length
 * === 0` is gated BEFORE calling `reassertPremiseFile`, and the "zero pins"
 * branch inside it is therefore never reached from this caller — only the
 * "one or more failed pins" branch is.
 *
 * `PR_BODY ?? ''` empty is the same "no PR context yet" bypass every other
 * PR-body-driven check in this registry uses (`check-brief-shape.ts`,
 * `check-pr-report-density.ts`) — not the "body unreadable" shape the brief's
 * stop condition means (a PR that exists always has a body string, even
 * empty; env absence here means this run has no PR to evaluate).
 *
 * scope: diff — reads the PR body alone, no live forge state.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { sep } from 'node:path'
import { parsePremiseBlock } from '@attalabs/aeg-core'
import { emitCheckError } from '../contract'
import { containedAbs } from '../../lib/ops'
import { reassertPremiseFile, type PremiseReassertResult } from '../premise-reassert-logic'

const CHECK_NAME = 'pr-premise-reassert'

/**
 * `containedAbs(root, p)`, then re-verified through the REAL (symlink-
 * resolved) path — the identical escape-closing shape
 * `check-dispatch-readiness.ts`'s own `containedRealPath` uses for the same
 * reason: a pin's `path` field comes from the frozen `parsePremiseBlock`
 * grammar, which imposes no containment of its own, and a PR body is
 * PR-author-controlled content on that same PR's own branch checkout.
 */
function containedRealPath(root: string, p: string): string | null {
  const abs = containedAbs(root, p)
  if (abs === null) return null
  try {
    const real = realpathSync(abs)
    const realRoot = realpathSync(root)
    return real === realRoot || real.startsWith(realRoot + sep) ? real : null
  } catch {
    return null
  }
}

function defaultFileReader(p: string): string | null {
  const real = containedRealPath(process.cwd(), p)
  if (real === null) return null
  try {
    return readFileSync(real, 'utf8')
  } catch {
    return null
  }
}

/**
 * `null` means "no `Premise:` block in this body — nothing to reassert",
 * the O3 silent case. A non-null result is `reassertPremiseFile`'s own
 * verdict over the pins the body actually carries.
 *
 * `fileReader` defaults to the real, cwd-rooted, symlink-safe reader — real
 * callers (`main()` below) never pass a second argument. Tests inject a
 * fixture map instead of the real filesystem, the same way
 * `premise-reassert-logic.test.ts` tests `reassertPremiseFile` directly: the
 * real reader is `process.cwd()`-relative, which is the repo root when
 * `vinaya check` spawns this bin for real (no chdir — see
 * `check-dispatch-readiness.ts`'s identical reasoning) but is this PACKAGE's
 * own root when a monorepo test runner invokes `apps/cli`'s `bun test`
 * directly — a real-filesystem-dependent test would pass or fail by which of
 * those happened to be cwd, not by what this function does.
 */
export function reassertPrBodyPremise(
  prBody: string,
  fileReader: (path: string) => string | null = defaultFileReader
): PremiseReassertResult | null {
  const assertions = parsePremiseBlock(prBody)
  if (assertions.length === 0) return null

  // Delegates to the frozen pair for the actual re-assertion. Routed through
  // `reassertPremiseFile` (not `checkPremises` directly) so the emitted
  // `CheckError` shape/wording matches the existing `PREMISE_FILE` caller
  // exactly — one message format for "a pin failed", not two.
  return reassertPremiseFile(CHECK_NAME, 'PR body', prBody, fileReader)
}

function main(): void {
  const prBody = process.env.PR_BODY ?? ''
  if (!prBody) {
    // No PR body to check (local dev outside a CI/PR context) — nothing to do.
    process.exit(0)
  }

  const result = reassertPrBodyPremise(prBody)
  if (result === null) {
    // No `Premise:` block — silent, regardless of branch.
    process.exit(0)
  }

  for (const error of result.errors) emitCheckError(error)
  process.exit(result.pass ? 0 : 1)
}

// Guarded so this module can be imported by unit tests without executing the
// check. Spawned as a bin (the only way it runs for real) this is still true.
if (import.meta.main) {
  main()
}
