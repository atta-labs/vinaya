#!/usr/bin/env bun

/**
 * Core check: test-plan. Thin adapter over `@attalabs/aeg-core`'s
 * `evaluateTestPlanGate` — mirrors `packages/aeg-core/bin/verify-test-plan.ts`'s
 * input assembly (PR_BODY/BRANCH env) exactly, emitting the check contract
 * instead of human text.
 *
 * It also supplies the one fact the body cannot carry: how many Developer
 * round comments this PR has from an allowlisted author. A ticked `[agent]`
 * box asserts that a command was run and its output posted; the output lives
 * in the round comment (`roles/developer.md`'s post-open sequence), so
 * without one the tick stands on nothing. The count is read at a FIXED
 * POSITION — the `<!-- aeg:developer:round-<n> -->` marker, via
 * `parseDeveloperRoundMarker` — never by scanning a comment's prose for a
 * phrase, and only from comments an allowlisted principal authored, since
 * every agent here posts under the Principal's own `gh` identity and an
 * unfiltered read would let any commenter satisfy the gate.
 *
 * `PR_NUMBER` unset takes the same "nothing to evaluate yet" bypass
 * `review-gate` documents: no comments are fetched, no evidence is supplied,
 * and the gate keeps its pre-existing body-only behaviour exactly. A `gh`
 * fetch that FAILS is a different fact from "no round comment" and is never
 * reported as `pending`: it exits `1` naming the fetch as the failure, so an
 * unreachable forge can never be mistaken for a missing comment.
 *
 * `PR_NUMBER` and `PR_BODY` arrive as two independent env vars, and nothing
 * upstream guarantees they describe the SAME pull request. An ambient or
 * stale `PR_NUMBER` would otherwise let one PR's round comments satisfy a
 * different PR's ticked boxes — the evidence would be real, just not
 * evidence for this body. So the fetch also reads that PR's own body and
 * compares it to `PR_BODY` through `authoredRegion`, the same normalisation
 * `pr-body-frozen` hashes: anchored regions stripped and ticks normalised,
 * so an `AEG:EVIDENCE` regeneration or a tick landing between the two reads
 * is not mistaken for a different PR. On a mismatch the count is treated as
 * `0` and the message says why — the conservative direction, since the
 * alternative is crediting a tick with a comment posted somewhere else.
 *
 * scope: diff — reads only the PR body and that PR's comments, never the
 * whole repo.
 */

import { execFileSync } from 'node:child_process'
import { authoredRegion, evaluateTestPlanGate, isPrincipal, parseDeveloperRoundMarker } from '@attalabs/aeg-core'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from '../../lib/config'
import { CHECK_SCHEMA_VERSION, emitCheckError } from '../contract'

const CHECK_NAME = 'test-plan'

type PrView = { body: string; comments: { body: string; author?: { login?: string } | null }[] }

/** `null` — never an empty result — when `gh` could not answer; the two facts are not interchangeable. */
function fetchPr(prNumber: string): PrView | null {
  try {
    const out = execFileSync('gh', ['pr', 'view', prNumber, '--json', 'body,comments'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return JSON.parse(out) as PrView
  } catch {
    return null
  }
}

function main(): void {
  const body = process.env.PR_BODY ?? ''
  const branch = process.env.BRANCH ?? ''
  const prNumber = process.env.PR_NUMBER ?? ''

  let evidence: { developerRoundComments: number } | undefined
  let identityMismatch = false
  if (prNumber) {
    const pr = fetchPr(prNumber)
    if (pr === null) {
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message: `could not read PR #${prNumber}'s comments through \`gh pr view\` — the Developer round-comment count is unknown, so this check cannot decide.`,
        agent_recovery_prompt:
          'This is a forge/tooling failure, not a Test Plan failure: `gh pr view <n> --json comments` did not answer. Check `gh auth status` and network reachability, then re-run `vinaya check test-plan`. Do not tick or untick anything in response to this error.'
      })
      process.exit(1)
    }
    identityMismatch = body !== '' && authoredRegion(pr.body) !== authoredRegion(body)
    const allowlist = resolvePrincipalAllowlist(loadTrustAnchorConfig())
    evidence = {
      developerRoundComments: identityMismatch
        ? 0
        : pr.comments.filter(
            (c) => isPrincipal(c.author?.login ?? null, allowlist) && parseDeveloperRoundMarker(c.body) !== null
          ).length
    }
  }

  const result = evaluateTestPlanGate(body, branch, evidence)

  if (result.verdict === 'fail') {
    const messages = identityMismatch
      ? [
          ...result.messages,
          `PR #${prNumber}'s own body does not match the PR_BODY this check was given, so its round comments were not counted for it — the two env vars describe different pull requests. Set PR_NUMBER to the PR this body belongs to.`
        ]
      : result.messages
    for (const message of messages) {
      if (!message) continue
      emitCheckError({
        schema: CHECK_SCHEMA_VERSION,
        check: CHECK_NAME,
        severity: 'error',
        message,
        ...(result.pending ? { pending: true as const } : {}),
        agent_recovery_prompt: result.pending
          ? 'Post the Developer round comment for this head — headed `Head: <sha>`, carrying the `<!-- aeg:developer:round-<n> -->` marker and the actual command output for every `[agent]` item you ran — then re-run `vinaya check test-plan`. The evidence belongs in that comment; never paste it into the PR body, which is frozen at open.'
          : 'Run each `[agent]` Test Plan item, post its actual output in the Developer round comment for this head, then tick that item in the PR body (checkbox character only). Leave `[principal]` boxes for the Principal. Re-run `vinaya check test-plan` afterwards.'
      })
    }
    process.exit(1)
  }

  process.exit(0)
}

main()
