import { startReviewerSourceTools } from './developer-context.js'
import { snapshotTurnConfinement } from './turn-confinement.js'
import { reviewerScanTexts } from './turn-confinement.js'
import { describeTurnConfinementViolation } from './turn-confinement.js'
import { checkTurnConfinement } from './turn-confinement.js'
/**
 * `dev-review-loop`'s reviewer dispatch: one Reviewer or security turn, with its confinement check, and the
 * rule that keeps a sibling's verdict when the other pauses. Moved out of
 * `harness/processes/vinaya-strict/loops/dev-review/standalone/dev-review-loop.ts` verbatim, over the run's
 * `LoopRunContext`; the bodies are unchanged.
 */

import { writeFileSync } from 'node:fs'
import type { DispatchHandle } from '../../dispatch/dispatch.js'
import {
  classifyReviewOutcome,
  manifestDigest as reviewManifestDigest,
  type ReviewBinding,
  type ReviewResult,
  reviewBlockerNeedsRuling
} from '../../../../executing/code-reviewer/review-result.js'
import { ensureRunDir, runPath } from '../../../../../../kernel/run-paths.js'
import { appendRoleLine } from '../../../../../../kernel/log/client/loop-log.js'
import { withPromptFile } from './developer-dispatch.js'
import {
  buildVerdictFromReview,
  renderReviewerDispatchPrompt,
  type ReviewerPromptFacts,
  ReviewerInfrastructureFailure,
  ReviewerResultRejected,
  type RoundVerdictParse
} from './reviewer-dispatch.js'
import { buildReviewerScratch, reviewerCandidateInputPaths } from './reviewer-isolation.js'
import { assertDispatchOrEscalate } from './round-assess.js'
import type { LoopRunContext } from './run-context.js'

/**
 * O1/O2: each attempt is a fresh, non-resumed dispatch whose one native
 * structured ReviewResult the controller binds to this run, round,
 * attempt, role, judged head and review-input-manifest digest
 * (`classifyReviewOutcome`). Anything but an accepted review is no review,
 * never a clean verdict: retried once with a fresh dispatch (`attempt` 2,
 * its own scratch copy); a second no-review throws
 * `ReviewerInfrastructureFailure` (or the last `ReviewerResultRejected`),
 * which the caller turns into a pause rather than a held or published
 * verdict for this round. The one exception is a `blocked` result whose
 * blocker only the Principal can settle (`reviewBlockerNeedsRuling`): the
 * controller records it as this role's escalation at once, never retried.
 *
 * Deliberately does NOT call `writeHeldVerdict` itself (a round-1 review
 * BLOCKER finding): both roles run inside one `Promise.all` in
 * the caller, so a role that finishes clean can resolve before its
 * sibling's own retry exhausts and throws — writing the held verdict file
 * here would leave one on disk for a round that pauses as infrastructure,
 * violating O2's "nothing is held … for that round" the moment the two
 * roles finish in that order. The caller writes both held verdicts only
 * after `Promise.all` itself resolves — i.e. only once it knows neither
 * role failed.
 */
export async function dispatchReviewer(
  c: LoopRunContext,
  role: 'reviewer' | 'security',
  roundNum: number,
  facts: ReviewerPromptFacts,
  candidateDir: string | null,
  /**
   * O1: whether `writeReviewerCandidateInputs` actually staged the PR
   * body/diff/prior-findings into `candidateDir` this round — decided
   * once by the caller, before either role dispatches (never re-derived
   * per attempt): a staging write that failed leaves this `false`, so
   * every attempt's prompt omits the candidate-input block rather than
   * naming three files that do not exist in the scratch copy.
   */
  candidateInputsReady: boolean
): Promise<{ verdict: RoundVerdictParse }> {
  const {
    d,

    dispatchAgent,
    loopLogPath,

    root,
    runId,

    task
  } = c

  const dispatchRoleName = role === 'reviewer' ? ('code-reviewer' as const) : ('security' as const)
  // O1/O2: resolved once per role, before the attempt loop — the doctrine
  // does not change between a failed first attempt and its fresh retry.
  // A dep that throws (or is absent) leaves the doctrine block off rather
  // than failing the round, the pre-task behaviour.
  let roleDoctrine: string | null = null
  try {
    roleDoctrine = d.resolveReviewerDoctrine ? await d.resolveReviewerDoctrine(role) : null
  } catch {
    roleDoctrine = null
  }
  const lastMissing: string[] = []
  let lastRejection: ReviewerResultRejected | null = null
  // Round 2 review, MAJOR: captured so a `ReviewerInfrastructureFailure`
  // thrown after the loop can carry the LAST attempt's own real
  // effect_id/durationMs, rather than the caller inventing a fresh id
  // and timing it against the whole round.
  let lastHandle: DispatchHandle | null = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    // O1/O2: a fresh, writable copy of this round's shared,
    // read-only candidate (built once, below, before both roles
    // dispatch) — never the candidate itself, never the sibling role's
    // own copy, and never a prior attempt's own (fresh per attempt).
    // `null` when no candidate was built this round — `cwd` is then
    // omitted, exactly as every dispatch before this task. Built BEFORE
    // the prompt (O1): the prompt names the staged inputs' paths INSIDE
    // this attempt's own scratch copy, which only exists once this call
    // returns.
    const scratchDir = candidateDir ? buildReviewerScratch(root, task, roundNum, role, attempt, candidateDir) : null
    const candidateInputPaths = scratchDir && candidateInputsReady ? reviewerCandidateInputPaths(scratchDir) : null
    const prompt = renderReviewerDispatchPrompt(role, facts, roleDoctrine, candidateInputPaths)
    // O1/O2: the protected-path snapshot this attempt's own after-dispatch
    // check compares against — taken right before this dispatch, never
    // from a cached copy (Traps to avoid).
    snapshotTurnConfinement(c, dispatchRoleName, roundNum)
    const sourceTools = await startReviewerSourceTools(c, dispatchRoleName, facts.requiredSources)
    let handle: DispatchHandle
    try {
      handle = await withPromptFile(prompt, (promptFile) =>
        d.dispatchRole(dispatchRoleName, dispatchAgent, prompt, {
          task: task,
          round: roundNum,
          promptFile,
          roleLogPath: loopLogPath,
          inputVersions: {
            manifestVersion: facts.manifest.manifestVersion ?? 2,
            objectivesVersion: facts.manifest.objectivesVersion,
            briefHash: facts.manifest.briefHash,
            rulingOrdinal: facts.manifest.rulingOrdinal,
            policyDigest: facts.manifest.policyDigest,
            pauseBoundRuling: facts.manifest.pauseBoundRuling ?? null
          },
          ...(scratchDir ? { cwd: scratchDir } : {}),
          // O1/O3: a Reviewer
          // dispatched by this driver is unattended the same way the
          // Developer is. No `resumeId`, ever: a reviewer runs on a fresh
          // session, and `dispatchRole` refuses one that asks to resume.
          unattended: true,
          // The reviewer's one tool, `read_source`, when the round has required sources.
          ...(sourceTools ? { devToolsBridge: sourceTools.bridge } : {})
        })
      )
    } finally {
      await sourceTools?.close()
    }
    await assertDispatchOrEscalate(
      handle,
      dispatchAgent,
      false,
      false,
      role === 'reviewer' ? 'the reviewer' : 'the security reviewer'
    )
    lastHandle = handle
    // O1/O2: never trust this attempt's structured result once a
    // protected path changed or a recognized credential pattern
    // appeared — thrown before the result is ever classified.
    const confinement = checkTurnConfinement(c, dispatchRoleName, reviewerScanTexts(c, handle))
    if (confinement.changedPaths.length > 0 || confinement.credentialFindings.length > 0) {
      throw new ReviewerConfinementViolation(
        role,
        describeTurnConfinementViolation(c, confinement),
        handle.effectId ?? null,
        handle.durationMs
      )
    }
    // The controller's own binding: nothing in it is read from the agent.
    const binding: ReviewBinding = {
      role: dispatchRoleName === 'security' ? 'security-reviewer' : 'code-reviewer',
      headSha: facts.manifest.headSha,
      manifestDigest: reviewManifestDigest(facts.manifest),
      objectiveIds: facts.resolvedObjectives.map((objective) => objective.id),
      runId,
      round: roundNum,
      attempt
    }
    const output = handle.reviewOutput
    const outcome = classifyReviewOutcome(
      {
        cancelled: handle.failureReason === 'signal',
        // The dispatcher refuses a reviewer resume before spawning, so a
        // run that reached here started fresh; stated, not assumed.
        resumed: false,
        terminal: output?.terminal ?? null,
        // The provider's own error text first — the only place an
        // exhausted context shows — then the dispatcher's failure code.
        errors: [...(output?.errors ?? []), ...(handle.failureReason ? [handle.failureReason] : [])],
        hasResult: output !== undefined && output.raw !== null,
        raw: output?.raw
      },
      binding
    )
    let accepted: ReviewResult
    if (outcome.kind === 'review') {
      accepted = outcome.result
    } else {
      // Only a blocked result already bound to this role, head and
      // manifest is ever read; a crossed or stale one is no review above.
      const blocked = outcome.blocked
      if (blocked === undefined || !reviewBlockerNeedsRuling(blocked.blocker.kind)) {
        appendRoleLine(
          loopLogPath,
          'dev-review-loop',
          `review_not_accepted: round=${roundNum} attempt=${attempt} role=${role} reason=${outcome.reason}`
        )
        lastMissing.push(
          `attempt ${attempt} (session ${handle.resumeId ?? '(unknown)'}): no review (${outcome.reason}) — ${outcome.detail}`
        )
        lastRejection = null
        continue
      }
      // A blocked result is still no review; the controller decides its
      // blocker needs the Principal, so the role's round outcome is an
      // escalation — accepted only after the same binding check a review
      // passes.
      accepted = blocked
    }
    appendRoleLine(
      loopLogPath,
      'dev-review-loop',
      `review_bound: round=${roundNum} attempt=${attempt} role=${role} status=${accepted.status} head=${binding.headSha} manifest=${binding.manifestDigest}`
    )
    // O6: the SAME one-fresh-retry treatment a missing result gets — a
    // result that breaks a rule every review is held to is retried once,
    // as a fresh dispatch, before it becomes a pause.
    try {
      const verdict = buildVerdictFromReview(
        role,
        accepted,
        dispatchAgent,
        task,
        handle,
        facts.manifest,
        c.policy,
        facts.resolvedObjectives,
        facts.deferralContext ?? {}
      )
      return { verdict }
    } catch (err) {
      if (!(err instanceof ReviewerResultRejected)) throw err
      lastRejection = err
      lastMissing.push(`attempt ${attempt}: no review (rejected) — ${err.message}`)
    }
  }
  if (lastRejection) throw lastRejection
  throw new ReviewerInfrastructureFailure(
    role,
    lastMissing,
    lastHandle?.effectId ?? null,
    lastHandle?.durationMs ?? null
  )
}

/**
 * Keeps the verdict of a reviewer role that finished while its sibling
 * failed the same round: written to `rounds/<n>/<role>-kept-on-pause.md`
 * — never the held-verdict file (`writeHeldVerdict`), which only a round
 * both roles finished may hold — and logged, so a pause never loses the
 * sibling's findings. Returns the one-line note the pause detail carries.
 */
export function keepSiblingVerdictOnPause(
  c: LoopRunContext,
  roundNum: number,
  role: 'reviewer' | 'security',
  verdict: RoundVerdictParse
): string {
  const { loopLogPath, root, task } = c

  const file = `${role}-kept-on-pause.md`
  ensureRunDir(runPath(root, task, { area: 'round', round: roundNum }), root)
  writeFileSync(runPath(root, task, { area: 'round', round: roundNum, file }), verdict.rendered, 'utf8')
  const findings = verdict.observation.findings.length
  appendRoleLine(
    loopLogPath,
    'dev-review-loop',
    `sibling_verdict_kept: round=${roundNum} role=${role} verdict=${verdict.observation.verdict.replace(/ /g, '_')} findings=${findings} file=${file}`
  )
  return `the ${role === 'reviewer' ? 'code reviewer' : 'security reviewer'} finished this round (${verdict.observation.verdict}, ${findings} finding(s)), kept at rounds/${roundNum}/${file}`
}

/**
 * O1/O2: thrown when a Reviewer/security turn's own after-dispatch
 * confinement check (`checkTurnConfinement`) finds a changed protected
 * path or a recognized credential pattern — caught by the SAME generic
 * handler `ReviewerInfrastructureFailure`/`ReviewerResultRejected`
 * already are (`role`/`attemptEffectId`/`attemptDurationMs` match their
 * shape on purpose), which already knows how to record a failed attempt
 * and pause the round. This round's verdict is never trusted when this
 * is thrown — it is thrown before the dispatch's structured result is
 * ever classified or `buildVerdictFromReview` ever runs.
 */
export class ReviewerConfinementViolation extends Error {
  constructor(
    public readonly role: 'reviewer' | 'security',
    violation: string,
    public readonly attemptEffectId: string | null = null,
    public readonly attemptDurationMs: number | null = null
  ) {
    super(`${role}'s turn failed the after-turn confinement check: ${violation}`)
  }
}
