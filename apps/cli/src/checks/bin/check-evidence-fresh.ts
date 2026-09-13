#!/usr/bin/env bun

/**
 * Core check: evidence-fresh (fix/pr-report-emitter). Refuses a PR body whose
 * `AEG:EVIDENCE` block does not match the head it is attached to.
 *
 * Three groups, two of them compared exactly — see `evidence-fresh-logic.ts`'s
 * module doc for the fabrication-vs-staleness boundary this closes:
 *   - Group A (the `git diff --numstat` recompute) is compared exactly.
 *   - Group B (the attested `vinaya check --all --diff-only` run) is checked
 *     for freshness only, via the block's `Head:` line — re-running that
 *     suite here would be the recursion `vinaya pr report`'s own docstring
 *     rejects.
 *   - Group C (task 12, Principal rulings PR `open-1`/`open-2`: the Test
 *     Plan's `[agent]` command list) is attested, like Group B — the
 *     stored block's `#### C<n>: \`<command>\`` HEADING lines must equal
 *     the body's own §9 list, in order, never re-run here. Group C is
 *     arbitrary commands, not a `git` recompute; an earlier version of this
 *     check re-ran the whole §9 list (including a full `bun run test`)
 *     inside its own timeout, deleting `dist` out from under the
 *     twenty-six sibling checks the same CI job had just built it for
 *     (`open-1`). A later version read command boundaries out of a shared
 *     fence's `$ `-prefixed lines instead of re-running them, but a
 *     command's own output can print a line shaped like that same
 *     delimiter — `open-2` moved the boundary to a heading line no
 *     command's OUTPUT can forge. Skipped for a region carrying no
 *     `### Group C` heading at all, which predates this group.
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
import { agentCommandText, extractAgentCommandLines } from '../../commands/pr-report'
import { patchIdAt } from '../../lib/patch-id'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'
import { compareEvidenceBlock, EVIDENCE_PLACEHOLDER_TEXT } from '../evidence-fresh-logic'
import { ScanContext, resolveAnchoredRegion } from '../scan-context'

/** The exact marker `developerRoundMarker` (`dev-review-loop/round-assess.ts`) renders into every round's own comment — posted the first time this PR's gate ever goes green, the SAME moment the driver's automatic evidence report first runs. */
const DEVELOPER_ROUND_MARKER = /<!--\s*aeg:developer:round-\d+\s*-->/i

/**
 * Security review, HIGH: an untouched-placeholder body only ever exempts
 * `compareEvidenceBlock` from the fabrication check while genuinely no
 * report has landed yet — without this read, a PR author could hand-edit a
 * REAL, already-posted block back to the literal placeholder text and
 * defeat the byte-comparison forever. Read ONLY when the region actually is
 * the placeholder (never on an ordinary filled-block run, which needs no
 * extra `gh` call). A read failure fails CLOSED (`true` — "assume a round
 * may have happened") rather than silently re-opening the exact hole this
 * closes.
 */
function fetchHasPriorDeveloperRound(prNumber: number): boolean {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'comments'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const parsed = JSON.parse(out) as { comments?: Array<{ body?: string }> }
    return (parsed.comments ?? []).some((c) => DEVELOPER_ROUND_MARKER.test(c.body ?? ''))
  } catch {
    return true
  }
}

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

type PrRefs = { head: string; base: string }

/**
 * The PR's real head sha and base branch name in one `gh` call. The base
 * branch is what `patchIdAt` needs (`origin/<base>...<sha>`) to compute a
 * patch identity comparable to `check-review-gate.ts`'s own binding — the
 * same `pr.baseRefName` field that check reads off the identical `gh pr
 * view` shape.
 */
function fetchPrRefs(prNumber: number): PrRefs | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', String(prNumber), '--json', 'headRefOid,baseRefName'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const parsed = JSON.parse(out) as { headRefOid?: string; baseRefName?: string }
    if (!parsed.headRefOid || !parsed.baseRefName) return null
    return { head: parsed.headRefOid, base: parsed.baseRefName }
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

  // The SAME context `body-bare-digits` scans from, and the same resolver.
  // Reading `PR_BODY` directly here — which is what this check did until
  // Issue #189 — meant one zero-width character inside the START marker made
  // this side see no anchor at all while the other side saw a real evidence
  // block and exempted every digit in it. Both green, nothing verified. The
  // resolver takes a `ScanContext`, so this cannot drift back.
  const resolved = resolveAnchoredRegion(ScanContext.from(body), 'EVIDENCE')

  if (resolved === null) {
    // The anchor is opt-in, like every other AEG anchor — a body that
    // hasn't adopted it yet is not broken by not adopting it.
    process.exit(0)
  }

  if (resolved === 'hidden') {
    // The body DOES carry the pair, but only inside a collapsed `<details>`
    // block, where `body-bare-digits` blanks every digit unconditionally.
    // Exiting 0 here would grant that block the silent exemption Issue #189
    // is about, so this refuses instead: "unverifiable" is not "not adopted".
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message:
        'evidence-fresh: the AEG:EVIDENCE block sits inside a `<details>` block, where its digits are exempt from `body-bare-digits` and nothing can verify what it claims. Move the block out of the collapsed section.',
      agent_recovery_prompt:
        'Move the AEG:EVIDENCE anchor pair out of the `<details>` block (the canonical home is its own `## Evidence` section), then re-run `vinaya pr report --write <body-file>`.'
    })
    process.exit(1)
  }

  const prNumberStr = process.env.PR_NUMBER
  if (!prNumberStr) {
    // No PR yet to resolve a real head against (local dev, pre-push).
    process.exit(0)
  }

  const prRefs = fetchPrRefs(Number(prNumberStr))
  if (prRefs === null) {
    emitCheckError({
      schema: CHECK_SCHEMA_VERSION,
      check: CHECK_NAME,
      severity: 'error',
      message: `evidence-fresh: could not resolve PR #${prNumberStr}'s head and base via \`gh pr view --json headRefOid,baseRefName\`.`,
      agent_recovery_prompt:
        'Confirm `gh auth status` passes and PR_NUMBER is correct, then re-run `vinaya check evidence-fresh`.'
    })
    process.exit(1)
  }
  const resolvedHead = prRefs.head

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

  // Attestation, not a re-run: the body's own §9 command list, arrow text
  // stripped — never spawned. See `evidence-fresh-logic.ts`'s module doc for
  // why re-running Group C here was the defect this ruling closes.
  const expectedGroupCCommandLines = extractAgentCommandLines(body).map(agentCommandText)

  // A verdict binds to a PATCH, not a sha (`check-review-gate.ts`'s own
  // `patchIdOf` binding, `#497`) — this check's `Head:` binding uses the
  // identical rule, computed against the PR's real base branch.
  const patchIdOf = (sha: string) => patchIdAt(prRefs.base, sha)

  const isPlaceholder = resolved.region.trim() === EVIDENCE_PLACEHOLDER_TEXT
  const hasPriorDeveloperRound = isPlaceholder ? fetchHasPriorDeveloperRound(Number(prNumberStr)) : undefined

  const result = compareEvidenceBlock(
    resolved,
    resolvedHead,
    actualNumstat,
    expectedGroupCCommandLines,
    patchIdOf,
    hasPriorDeveloperRound
  )
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
