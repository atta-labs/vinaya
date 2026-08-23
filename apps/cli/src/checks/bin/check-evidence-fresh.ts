#!/usr/bin/env bun

/**
 * Core check: evidence-fresh (fix/pr-report-emitter). Refuses a PR body whose
 * `AEG:EVIDENCE` block does not match the head it is attached to.
 *
 * Two asymmetric halves, on purpose — see `evidence-fresh-logic.ts`'s module
 * doc for the fabrication-vs-staleness boundary this closes:
 *   - Group A (the `git diff --numstat` recompute) is compared exactly.
 *   - Group B (the attested `vinaya check --all --diff-only` run) is checked
 *     for freshness only, via the block's `Head:` line — re-running that
 *     suite here would be the recursion `vinaya pr report`'s own docstring
 *     rejects.
 *
 * Head resolution deliberately does NOT use `HEAD`. `actions/checkout@v4` on
 * a `pull_request` event with no `ref:` checks out `refs/pull/N/merge`, so
 * `HEAD` in CI is the merge commit, never the PR head — using it would
 * red-line every PR that adopts this anchor. The emitter
 * (`apps/cli/src/commands/pr-report.ts`) runs locally, before the PR exists,
 * where `git rev-parse HEAD` IS the real head; this check runs in CI, so it
 * self-resolves the real head via `gh pr view --json headRefOid`, the same
 * pattern already live at `.github/workflows/vinaya-review-verdict.yml:47`
 * and `apps/cli/src/lib/artifacts.ts`. Every recomputation is anchored on
 * that resolved sha, not on `HEAD` — a `git diff origin/main...HEAD` in CI
 * would resolve the merge base to `origin/main`'s tip rather than the fork
 * point, spuriously red-lining any PR whose base has since advanced over
 * overlapping files.
 *
 * Base resolution (`resolveMergeBase`) tries `BASE_SHA` (else `origin/main`),
 * then `main`, matching `pr-report.ts`'s emitter-side resolution exactly. When
 * NEITHER resolves, this REFUSES (a CheckError, non-zero exit) rather than
 * recomputing against an empty base and reporting PASS having verified
 * nothing — an unresolvable base is an infrastructure failure, not evidence
 * of an empty diff.
 *
 * scope: diff — the whole point is "does this PR body's evidence match this
 * PR's own head." requiresOpenPr: true — meaningless before a PR exists,
 * same reasoning as `closes-n`/`test-plan`.
 */

import { execFileSync } from 'node:child_process'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { resolveAnchoredRegionForScan } from '../body-bare-digits-logic'
import { compareEvidenceBlock } from '../evidence-fresh-logic'

const CHECK_NAME = 'evidence-fresh'

// Array-form execFileSync — no shell, so no injection surface.
function git(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch {
    return ''
  }
}

/**
 * Thrown when neither the resolved primary ref (`BASE_SHA`, else
 * `origin/main`) nor the `main` fallback produces a merge-base — see
 * `pr-report.ts`'s `UnresolvableMergeBaseError` for the full rationale
 * (same class of bug, mirrored here: `base ? git([...]) : ''` collapsed a
 * real resolution failure into the exact same `''` a genuinely empty diff
 * produces, so `compareEvidenceBlock` reported PASS having recomputed
 * nothing at all — found in review, PR #126).
 */
class UnresolvableMergeBaseError extends Error {
  constructor(triedRefs: readonly string[]) {
    super(`could not resolve a merge-base against any of: ${triedRefs.join(', ')}.`)
  }
}

/**
 * Mirrors `pr-report.ts`'s `gitStrict`: a non-zero exit throws instead of
 * collapsing to `''`. `git diff --numstat` printing nothing is a real answer
 * ("no files changed"); `git diff` FAILING also printed nothing, and the
 * emitter's side collapsed the same way, so both agreed on `''` and this
 * check reported PASS having recomputed nothing. An earlier fix in PR #126
 * closed that for the merge-base only.

 */
class GitCommandError extends Error {
  constructor(args: readonly string[], cause: string) {
    super(`\`git ${args.join(' ')}\` failed: ${cause}`)
  }
}

function gitStrict(args: string[]): string {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string }).stderr
    throw new GitCommandError(args, String(stderr ?? (err as Error).message).trim() || 'non-zero exit')
  }
}

/** Same `BASE_SHA || 'origin/main'`, then `main`, convention as `pr-report.ts`'s `resolveMergeBase` — see that one's doc comment for the sibling checks it matches. */
function resolveMergeBase(head: string): string {
  const primary = process.env.BASE_SHA || 'origin/main'
  const tried = primary === 'main' ? [primary] : [primary, 'main']
  for (const ref of tried) {
    const base = git(['merge-base', ref, head])
    if (base) return base
  }
  throw new UnresolvableMergeBaseError(tried)
}

function fetchHeadSha(prNumber: number): string | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'headRefOid', '-q', '.headRefOid'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
    return out || null
  } catch {
    return null
  }
}

function main(): void {
  const body = process.env.PR_BODY ?? ''
  if (!body) {
    // No PR body — ring 0, or a check run with nothing to evaluate.
    process.exit(0)
  }

  // One resolver, shared with `body-bare-digits`. Four review rounds each made
  // these two sides agree at one more layer — same masker, same masker input,
  // same normalisation — and each time the disagreement reappeared one stage
  // earlier, because agreement by convention has no last layer. Calling the
  // same function is what ends that.
  const resolved = resolveAnchoredRegionForScan(body, 'EVIDENCE')
  if (resolved === null) {
    // No anchor at all. Opt-in, like every other AEG anchor — a body that
    // hasn't adopted it yet is not broken by not adopting it.
    process.exit(0)
  }
  if (resolved === 'hidden') {
    // The anchor is there but masking removed it: the region is inside a
    // `<details>` block, where `body-bare-digits` blanks every digit and
    // nothing can verify what it claims. Refuse rather than skip — an
    // unverifiable region is not an unadopted one.
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message:
        'evidence-fresh: the AEG:EVIDENCE region is enclosed by a `<details>` block, so nothing can verify what it claims. Three ways to land here: the region really is inside a block; an UNCLOSED `<details>` tag above it encloses it (an unterminated tag runs to the end of the body); or the only anchor pair in this body is a quoted copy inside a `<details>` reference brief. For the last one, put the quoted anchors in a code fence instead — a fenced copy is correctly ignored.',
      agent_recovery_prompt:
        'If the region is genuinely inside a `<details>` block, move it into the body. If you did not open one, find the unclosed `<details>` tag above it and wrap that tag in backticks. If the anchors are only a quoted copy inside a reference brief, put that copy in a code fence rather than a `<details>` block. Then re-run `vinaya check evidence-fresh`.'
    })
    process.exit(1)
  }
  const { region, maskedRegion } = resolved

  const prNumberStr = process.env.PR_NUMBER
  if (!prNumberStr) {
    // No PR yet to resolve a real head against (local dev, pre-push).
    process.exit(0)
  }

  const resolvedHead = fetchHeadSha(Number(prNumberStr))
  if (resolvedHead === null) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `evidence-fresh: could not resolve PR #${prNumberStr}'s head via \`gh pr view --json headRefOid\`.`,
      agent_recovery_prompt:
        'Confirm `gh auth status` passes and PR_NUMBER is correct, then re-run `vinaya check evidence-fresh`.'
    })
    process.exit(1)
  }

  let base: string
  let actualNumstat: string
  try {
    base = resolveMergeBase(resolvedHead)
    // `gitStrict`, not `git`: a FAILED `git diff` returned `''`, which is
    // byte-identical to a genuinely empty diff, so this check compared `''`
    // to the emitter's equally-collapsed `''` and reported PASS having
    // recomputed nothing. See `GitCommandError`.
    actualNumstat = gitStrict(['diff', `${base}...${resolvedHead}`, '--numstat'])
  } catch (err) {
    // An unresolvable base is an infrastructure failure, not an empty
    // diff — refuse rather than recomputing against '' and reporting PASS
    // having verified nothing. See UnresolvableMergeBaseError's doc comment.
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `evidence-fresh: ${err instanceof Error ? err.message : String(err)}`,
      agent_recovery_prompt:
        "This repo's default branch may not be reachable as `origin/main` or `main` from this checkout. Set BASE_SHA (e.g. `origin/<default-branch>`) on the check, or fetch the base branch, then re-run `vinaya check evidence-fresh`."
    })
    process.exit(1)
  }

  const result = compareEvidenceBlock(region, resolvedHead, actualNumstat, maskedRegion)
  if (result.status === 'fail') {
    for (const message of result.errors) {
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message,
        agent_recovery_prompt:
          'Re-run `vinaya pr report --write <body-file>` against the current head, commit, and push again.'
      })
    }
    process.exit(1)
  }

  process.exit(0)
}

main()
