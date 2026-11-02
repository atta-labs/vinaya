/**
 * A loop-published verdict agrees with the merge gate: it binds to the review policy, the objectives version and
 * the newest ruling, and a policy the loop cannot read pauses the loop without casting a verdict.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseObjectivesEditComment,
  reviewPolicyForLoop
} from '../../../../loops/dev-review/standalone/dev-review-loop.js'
import {
  deriveCodeReviewVerdict,
  renderCodeReviewComment,
  renderSecurityComment
} from '../../../../../../../apps/cli/src/commands/review-post.js'
import { spliceObjectivesSection } from '../../../../../../../apps/cli/src/commands/issue-objectives.js'
import {
  checkReviewGate,
  DEFAULT_REVIEW_POLICY,
  objectivesOf,
  objectivesVersion,
  policyDigest,
  renderObjectives,
  type Objective
} from '@attalabs/aeg-core'
import { cleanupWorlds, controlDir as ipControlDir, makeWorld, runLoopInProcess } from '../dev-review-loop-harness.js'
import { DEFAULT_POLICY_DIGEST, tempDirs as sharedTempDirs } from './driver-test-support.js'

const tempDirs = sharedTempDirs
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
// Issue #709: the in-process harness owns its own temp dirs (its world's
// runtimeDir/repoRoot/logDir) — clean them after every test too.
afterEach(cleanupWorlds)

/**
 * O1's own acceptance test: the version the loop's `resolveIssueObjectives`
 * would compute from an objectives-edit comment must equal the version the
 * merge gate computes from the SAME post-edit Issue body — proven here by
 * exercising the identical shared primitives both sides call
 * (`objectivesOf`/`objectivesVersion`, `@attalabs/aeg-core`) over one body,
 * never by importing the gate's own private `resolveObjectivesVersion`
 * (`apps/cli/src/checks/bin/check-review-gate.ts`, out of this task's
 * declared Surface). `spliceObjectivesSection`/`renderObjectives` are the
 * exact functions `issueObjectivesEditCommand` itself uses to write the new
 * live body and the `Version:` line — so this reproduces its own derivation,
 * not a parallel one.
 */
describe('objectives version — loop and gate agree (O1)', () => {
  it('the edit comment Version: line equals objectivesVersion(objectivesOf(<the live body the edit just wrote>))', () => {
    const originalBody = '## Objectives\n\nO1. Do the thing.\n'
    const previous = (objectivesOf(originalBody) as { ok: true; objectives: Objective[] }).objectives

    const updated: Objective[] = [...previous, { id: 'O2', text: 'Also do this.' }]
    // The exact write `issueObjectivesEditCommand` performs to the Issue body.
    const newBody = spliceObjectivesSection(originalBody, renderObjectives(updated))
    // The exact value it writes into the edit-audit comment's `Version:` line.
    const commentVersion = objectivesVersion(updated)

    // What the merge gate computes on its own next live-body read.
    const gateVersion = objectivesVersion((objectivesOf(newBody) as { ok: true; objectives: Objective[] }).objectives)

    expect(commentVersion).toBe(gateVersion)

    // And what `parseObjectivesEditComment` (the loop's own reader) recovers
    // from the rendered comment is that same value.
    const commentBody = [
      '<!-- aeg:objectives:v1 -->',
      'Previous:',
      previous.map((o) => `${o.id}. ${o.text}`).join('\n'),
      '',
      'Now:',
      updated.map((o) => `${o.id}. ${o.text}`).join('\n'),
      '',
      'Reason: needed a second outcome',
      `Version: ${commentVersion}`
    ].join('\n')
    expect(parseObjectivesEditComment(commentBody)?.version).toBe(gateVersion)
  })
})
/**
 * O2's own acceptance test: a loop-published verdict — rendered by the SAME
 * `renderCodeReviewComment`/`renderSecurityComment` `buildVerdictFromReview`
 * calls, now carrying a real `objectivesVersion` instead of the old
 * hardcoded `null` — is accepted by the merge gate's own `checkReviewGate`
 * evaluator when the current objectives version matches. Calling the real
 * gate function directly (`@attalabs/aeg-core`), not a re-derivation of its
 * logic.
 */
describe('a loop-published verdict passes the merge gate (O2)', () => {
  const HEAD = 'c'.repeat(40)
  const VERSION = objectivesVersion([{ id: 'O1', text: 'Do the thing.' }])
  const TOKENS = { taskId: '476', model: 'claude', tokensIn: '8', tokensOut: '4', cost: '—', sessionId: 's1' }

  it('checkReviewGate passes when both rendered verdicts carry the current objectives version', () => {
    const reviewerComment = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'yes',
      specConformance: 'yes',
      findings: [],
      scope: 'small',
      scopeEvidence: null,
      tests: 'pass',
      docs: 'n/a',
      objectivesVersion: VERSION,
      rulingOrdinal: 0,

      briefHash: null,

      policyDigest: DEFAULT_POLICY_DIGEST,
      baseSha: null,
      objectiveResults: [{ id: 'O1', status: 'MET', evidence: 'done' }]
    })
    const securityComment = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: null,
      objectivesVersion: VERSION,
      rulingOrdinal: 0,

      briefHash: null,

      policyDigest: DEFAULT_POLICY_DIGEST,
      baseSha: null,
      objectiveResults: [{ id: 'O1', status: 'MET', evidence: 'done' }]
    })

    const result = checkReviewGate({
      comments: [
        { body: reviewerComment, author: 'daniboomerang' },
        { body: securityComment, author: 'daniboomerang' }
      ],
      labels: [],
      waiverLabelActor: null,
      headSha: HEAD,
      principalAllowlist: ['daniboomerang'],
      objectivesVersion: VERSION,
      rulingOrdinal: 0
    })

    expect(result.verdict).toBe('pass')
  })

  it('checkReviewGate fails, naming the version mismatch, when the Issue objectives moved since the verdict', () => {
    const reviewerComment = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'yes',
      specConformance: 'yes',
      findings: [],
      scope: 'small',
      scopeEvidence: null,
      tests: 'pass',
      docs: 'n/a',
      objectivesVersion: VERSION,
      rulingOrdinal: 0,

      briefHash: null,

      policyDigest: 'p'.repeat(64),
      baseSha: null,
      objectiveResults: [{ id: 'O1', status: 'MET', evidence: 'done' }]
    })
    const securityComment = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: null,
      objectivesVersion: VERSION,
      rulingOrdinal: 0,

      briefHash: null,

      policyDigest: 'p'.repeat(64),
      baseSha: null,
      objectiveResults: [{ id: 'O1', status: 'MET', evidence: 'done' }]
    })

    const result = checkReviewGate({
      comments: [
        { body: reviewerComment, author: 'daniboomerang' },
        { body: securityComment, author: 'daniboomerang' }
      ],
      labels: [],
      waiverLabelActor: null,
      headSha: HEAD,
      principalAllowlist: ['daniboomerang'],
      objectivesVersion: 'a-newer-version-entirely',
      rulingOrdinal: 0
    })

    expect(result.verdict).toBe('fail')
    expect(result.reason).toMatch(/objectives version/)
  })
})
/**
 * Which severities block is repository policy (`review-validity-v1` task 8,
 * `#506`, O2/O4): the loop's own derivation (`deriveCodeReviewVerdict`, the
 * same function `buildVerdictFromReview` calls) and the merge gate's own
 * evaluation (`checkReviewGate`) must agree on the SAME findings under the
 * SAME policy — this repository's own configured MAJOR/HIGH.
 */
describe('a loop-published verdict agrees with the merge gate under policy (review-validity-v1 task 8, #506, O2/O4)', () => {
  const HEAD = 'e'.repeat(40)
  const TOKENS = { taskId: '506', model: 'claude', tokensIn: '8', tokensOut: '4', cost: '—', sessionId: 's1' }
  const THIS_REPO_POLICY = {
    codeReviewThreshold: 'MAJOR' as const,
    securityThreshold: 'HIGH' as const,
    maxRounds: 3,
    maxTaskMinutes: 180
  }

  it("a MAJOR finding drives REQUEST_CHANGES at the loop (never reaches a clean round to publish) under this repo's MAJOR/HIGH policy", () => {
    const findings = [{ severity: 'MAJOR', location: 'a.ts:1', description: 'off-by-one' }]
    expect(deriveCodeReviewVerdict(findings, THIS_REPO_POLICY)).toBe('REQUEST_CHANGES')
  })

  it('the SAME finding, rendered as a (hand-typed-bypass) APPROVE comment, is read as not clean by checkReviewGate under the identical policy — the two never disagree', () => {
    const reviewerComment = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'yes',
      specConformance: 'yes',
      findings: [{ severity: 'MAJOR', location: 'a.ts:1', description: 'off-by-one' }],
      scope: 'small',
      scopeEvidence: null,
      tests: 'pass',
      docs: 'n/a',
      objectivesVersion: null,
      rulingOrdinal: 0,

      briefHash: null,

      policyDigest: 'p'.repeat(64),
      baseSha: null,
      objectiveResults: null
    })
    const securityComment = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: null,
      objectivesVersion: null,
      rulingOrdinal: 0,

      briefHash: null,

      policyDigest: 'p'.repeat(64),
      baseSha: null,
      objectiveResults: null
    })

    const result = checkReviewGate({
      comments: [
        { body: reviewerComment, author: 'daniboomerang' },
        { body: securityComment, author: 'daniboomerang' }
      ],
      labels: [],
      waiverLabelActor: null,
      headSha: HEAD,
      principalAllowlist: ['daniboomerang'],
      objectivesVersion: null,
      rulingOrdinal: 0,
      policy: THIS_REPO_POLICY
    })

    expect(result.verdict).toBe('fail')
    expect(result.reason).toContain('never overrides policy')
  })

  it('the identical MAJOR-carrying comment passes under the DEFAULT (BLOCKER) policy — the gate and the default-policy derivation agree too', () => {
    const findings = [{ severity: 'MAJOR', location: 'a.ts:1', description: 'off-by-one' }]
    expect(
      deriveCodeReviewVerdict(findings, {
        codeReviewThreshold: 'BLOCKER',
        securityThreshold: 'HIGH',
        maxRounds: 3,
        maxTaskMinutes: 180
      })
    ).toBe('APPROVE')

    const reviewerComment = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'yes',
      specConformance: 'yes',
      findings: [{ severity: 'MAJOR', location: 'a.ts:1', description: 'off-by-one' }],
      scope: 'small',
      scopeEvidence: null,
      tests: 'pass',
      docs: 'n/a',
      objectivesVersion: null,
      rulingOrdinal: 0,

      briefHash: null,

      policyDigest: DEFAULT_POLICY_DIGEST,
      baseSha: null,
      objectiveResults: null
    })
    const securityComment = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: null,
      objectivesVersion: null,
      rulingOrdinal: 0,

      briefHash: null,

      policyDigest: DEFAULT_POLICY_DIGEST,
      baseSha: null,
      objectiveResults: null
    })

    const result = checkReviewGate({
      comments: [
        { body: reviewerComment, author: 'daniboomerang' },
        { body: securityComment, author: 'daniboomerang' }
      ],
      labels: [],
      waiverLabelActor: null,
      headSha: HEAD,
      principalAllowlist: ['daniboomerang'],
      objectivesVersion: null,
      rulingOrdinal: 0
      // policy omitted — defaults to BLOCKER/HIGH.
    })

    expect(result.verdict).toBe('pass')
  })
})
/**
 * The ruling-ordinal mirror of the objectives-version acceptance test above
 * (review-validity-v1 task 3, `#477`, O1/O2): a loop-published verdict —
 * rendered by the same `renderCodeReviewComment`/`renderSecurityComment`
 * `buildVerdictFromReview` calls, now carrying a real `rulingOrdinal`
 * instead of the field not existing at all — is accepted by the merge
 * gate's own `checkReviewGate` evaluator when the current newest ruling
 * ordinal matches, and refused, naming the newer ruling, when it doesn't.
 */
describe('a loop-published verdict is bound to the newest ruling ordinal (review-validity-v1 task 3, #477, O2)', () => {
  const HEAD = 'd'.repeat(40)
  const TOKENS = { taskId: '477', model: 'claude', tokensIn: '8', tokensOut: '4', cost: '—', sessionId: 's1' }

  it('checkReviewGate passes when both rendered verdicts carry the current newest ruling ordinal', () => {
    const reviewerComment = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'yes',
      specConformance: 'yes',
      findings: [],
      scope: 'small',
      scopeEvidence: null,
      tests: 'pass',
      docs: 'n/a',
      objectivesVersion: null,
      rulingOrdinal: 1,

      briefHash: null,

      policyDigest: DEFAULT_POLICY_DIGEST,
      baseSha: null,
      objectiveResults: null
    })
    const securityComment = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: null,
      objectivesVersion: null,
      rulingOrdinal: 1,

      briefHash: null,

      policyDigest: DEFAULT_POLICY_DIGEST,
      baseSha: null,
      objectiveResults: null
    })

    const result = checkReviewGate({
      comments: [
        { body: reviewerComment, author: 'daniboomerang' },
        { body: securityComment, author: 'daniboomerang' }
      ],
      labels: [],
      waiverLabelActor: null,
      headSha: HEAD,
      principalAllowlist: ['daniboomerang'],
      objectivesVersion: null,
      rulingOrdinal: 1
    })

    expect(result.verdict).toBe('pass')
  })

  it('checkReviewGate fails, naming the newer ruling, when a ruling posted after the verdict was cast', () => {
    const reviewerComment = renderCodeReviewComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'APPROVE',
      briefConformance: 'yes',
      specConformance: 'yes',
      findings: [],
      scope: 'small',
      scopeEvidence: null,
      tests: 'pass',
      docs: 'n/a',
      objectivesVersion: null,
      rulingOrdinal: 1,

      briefHash: null,

      policyDigest: 'p'.repeat(64),
      baseSha: null,
      objectiveResults: null
    })
    const securityComment = renderSecurityComment({
      ...TOKENS,
      headSha: HEAD,
      verdict: 'PASS',
      findings: [],
      configScan: 'clean',
      secrets: 'none found',
      secretsEvidence: null,
      objectivesVersion: null,
      rulingOrdinal: 1,

      briefHash: null,

      policyDigest: 'p'.repeat(64),
      baseSha: null,
      objectiveResults: null
    })

    const result = checkReviewGate({
      comments: [
        { body: reviewerComment, author: 'daniboomerang' },
        { body: securityComment, author: 'daniboomerang' }
      ],
      labels: [],
      waiverLabelActor: null,
      headSha: HEAD,
      principalAllowlist: ['daniboomerang'],
      objectivesVersion: null,
      rulingOrdinal: 2
    })

    expect(result.verdict).toBe('fail')
    expect(result.reason).toMatch(/ruling ordinal/)
    expect(result.reason).toContain('ruling 2')
  })
})
// --- issue #945: a failed policy read never casts a verdict under the defaults ---

/**
 * The origin incident (2026-10-01): during a GitHub API limit the trust-anchor
 * read failed, `loadTrustAnchorConfig` swallowed it to `null`, and the loop ran
 * under the `BLOCKER` default while this repository's `reviewPolicy` sets
 * `MAJOR`; the merge gate read the real policy and refused both verdicts on a
 * policy-digest mismatch, so a clean review could not merge. `reviewPolicyForLoop`
 * is the loop-only variant that reads through `loadTrustAnchorConfigOrThrow` and
 * tells a FAILED read (retry, then throw → pause) apart from a missing/no-policy
 * config (defaults). The config-level read variant itself is covered in
 * `apps/cli/tests/config.test.ts`; the shared non-throwing `reviewPolicy` is
 * exercised by `apps/cli/tests/commands/review-status.test.ts`.
 */
describe('reviewPolicyForLoop (issue #945) — retries a failed read, then throws; a null/no-policy config is the defaults path', () => {
  it('retries the read, then throws naming the read error when every attempt fails (O1/O3)', () => {
    let reads = 0
    const load = () => {
      reads += 1
      throw new Error('gh: API rate limit exceeded (HTTP 403)')
    }
    expect(() => reviewPolicyForLoop(load)).toThrow(/could not read the repository's review policy/)
    // Two attempts — the read was genuinely retried before giving up.
    expect(reads).toBe(2)
  })

  it('a read that fails once then succeeds recovers on the retry (O1)', () => {
    let reads = 0
    const load = () => {
      reads += 1
      if (reads === 1) throw new Error('gh: transient failure')
      return null
    }
    expect(reviewPolicyForLoop(load)).toEqual(DEFAULT_REVIEW_POLICY)
    expect(reads).toBe(2)
  })

  it('a null read (missing file / no config) resolves to the built-in defaults, not a throw (O2)', () => {
    let reads = 0
    expect(
      reviewPolicyForLoop(() => {
        reads += 1
        return null
      })
    ).toEqual(DEFAULT_REVIEW_POLICY)
    expect(reads).toBe(1)
  })

  it('a config present without a reviewPolicy resolves to the built-in defaults (O2)', () => {
    expect(reviewPolicyForLoop(() => ({ principals: ['someone'] }))).toEqual(DEFAULT_REVIEW_POLICY)
  })

  it('a readable reviewPolicy is honoured verbatim', () => {
    const policy = reviewPolicyForLoop(() => ({ reviewPolicy: { codeReviewThreshold: 'MAJOR' } }))
    expect(policy.codeReviewThreshold).toBe('MAJOR')
  })

  it('a present-but-unknown severity is a config defect, thrown WITHOUT retry (not a read failure)', () => {
    let reads = 0
    const load = () => {
      reads += 1
      return { reviewPolicy: { codeReviewThreshold: 'NOT-A-SEVERITY' } }
    }
    // `resolveReviewPolicy`'s own refusal, surfaced on the first attempt — the
    // read itself succeeded, so it is never retried.
    expect(() => reviewPolicyForLoop(load)).toThrow(/not one of/)
    expect(reads).toBe(1)
  })
})
describe('devReviewLoop — a failed policy read pauses infrastructure and casts no verdict (issue #945, O1/O3)', () => {
  it('retries the read, then pauses infrastructure naming the error, dispatching no reviewer or developer', async () => {
    const world = makeWorld()
    let loadCalls = 0
    // The REAL loop policy reader (`reviewPolicyForLoop`) over a forge read that
    // always fails — so the loop runs the genuine retry-then-throw path.
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        reviewPolicy: () =>
          reviewPolicyForLoop(() => {
            loadCalls += 1
            throw new Error('gh: API rate limit exceeded (HTTP 403)')
          })
      }
    )

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'infrastructure' })
    // The read was retried before the loop gave up (O1).
    expect(loadCalls).toBe(2)
    // No verdict was cast: neither reviewer, nor even the developer, was ever
    // dispatched — the failed read stops the round during setup (O1).
    expect(world.dispatchCountByRole['code-reviewer'] ?? 0).toBe(0)
    expect(world.dispatchCountByRole.security ?? 0).toBe(0)
    expect(world.dispatchCountByRole.developer ?? 0).toBe(0)

    // The pause record and its comment name the failed read, so the Principal
    // can tell a forge outage from a policy problem (O3).
    const pauseState = JSON.parse(readFileSync(join(ipControlDir(world), 'pause-state.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(pauseState.reason).toBe('infrastructure')
    expect(String(pauseState.detail)).toMatch(/review policy/)
    const pauseComment = world.postedComments.find((c) => /aeg:loop:paused:infrastructure/.test(c.body))
    expect(pauseComment).toBeDefined()
    expect(pauseComment!.body).toMatch(/review policy/)
    // Nothing resembling a verdict was ever posted.
    expect(world.postedComments.some((c) => /^VERDICT:/m.test(c.body))).toBe(false)
  })

  it('a null read (missing / policy-less config) does not stop the round — the loop runs under the defaults (O2)', async () => {
    const world = makeWorld()
    const result = await runLoopInProcess(
      world,
      { task: world.task, agent: 'claude' },
      {
        // The real loop policy reader over a config that resolves to null (a
        // missing file, or one present without a reviewPolicy): the defaults path,
        // which publishes exactly as a clean round always has — the failed-read
        // pause is reached ONLY by a genuine read failure, never by an absent config.
        reviewPolicy: () => reviewPolicyForLoop(() => null)
      }
    )
    expect(result.finalDecision.type).toBe('publish')
    expect(world.dispatchCountByRole['code-reviewer'] ?? 0).toBeGreaterThanOrEqual(1)
    expect(world.dispatchCountByRole.security ?? 0).toBeGreaterThanOrEqual(1)
  })
})
