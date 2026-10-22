import {
  buildVerifiedReviewerCandidate,
  reviewerCandidateInputPaths,
  writeReviewerCandidateInputs,
  type ReviewerCandidateInputPaths
} from '../../../apps/cli/src/lib/dev-review-loop/reviewer-isolation'
import {
  buildPriorRoundFindingsText,
  renderReviewerDispatchPrompt,
  type ReviewerPromptFacts
} from '../../../apps/cli/src/lib/dev-review-loop/reviewer-dispatch'

/**
 * The input one review step judges: an immutable, staged copy of the judged
 * head (`dir`) plus the named input files written beside it (`paths`), or
 * `paths: null` when writing them failed, so the prompt names no file that was
 * never written. Every review step of a round reads the same staging, never the
 * live worktree the Developer keeps changing.
 */
export interface VinayaStagedReviewInput {
  dir: string
  paths: ReviewerCandidateInputPaths | null
}

/** Stages the review input for a round, once; null when the judged head could not be staged. */
export interface VinayaReviewInputStager {
  stage: (round: number) => VinayaStagedReviewInput | null
}

/** What staging one round's reviewer candidate reads; each is called only when a round is first staged. */
export interface VinayaReviewInputDeps {
  /** The runtime directory the candidate is placed under (`buildReviewerCandidate`'s root). */
  root: string
  task: number
  /** The task worktree whose head is copied. */
  worktreePath: string
  judgedHead: () => string
  /** Reads the worktree's head; the candidate is kept only when it reads `judgedHead` before and after the copy. */
  readHead: (worktreePath: string) => string | null
  /** The merge base of `head` with main. */
  baseOf: (head: string) => string
  brief: () => string
  /** The open pull request's body, or the empty string when there is none. */
  prBody: () => string
  diff: (base: string, head: string) => string
  /**
   * The previous round's findings for `round`. Defaults to the standalone loop's
   * `buildPriorRoundFindingsText(root, task, round)`: the held verdicts of `round - 1`.
   */
  priorFindings?: (round: number) => string
  /** Replaces the candidate builder, for a test. */
  buildCandidate?: typeof buildVerifiedReviewerCandidate
  /** Replaces the input writer, for a test. */
  writeInputs?: typeof writeReviewerCandidateInputs
}

/**
 * The Vinaya review input: a read-only copy of the task head (the reviewer
 * candidate) with the brief, pull request body, diff and prior round's
 * findings written beside it, staged once per round, as the standalone
 * loop's round stages them before the reviewers dispatch.
 */
export function createVinayaReviewInputStager(deps: VinayaReviewInputDeps): VinayaReviewInputStager {
  const build = deps.buildCandidate ?? buildVerifiedReviewerCandidate
  const write = deps.writeInputs ?? writeReviewerCandidateInputs
  const priorFindings =
    deps.priorFindings ?? ((round: number) => buildPriorRoundFindingsText(deps.root, deps.task, round))
  // A fetch that fails becomes a placeholder naming the failure, as in the standalone loop's round.
  const orPlaceholder = (read: () => string, what: string): string => {
    try {
      return read()
    } catch (error) {
      return `(${what} could not be fetched this round: ${error instanceof Error ? error.message : String(error)})`
    }
  }
  let staged: { round: number; input: VinayaStagedReviewInput | null } | null = null
  return {
    stage(round) {
      if (staged !== null && staged.round === round) return staged.input
      const head = deps.judgedHead()
      // The head is read before and after the copy; a worktree that moved mid-copy yields no candidate.
      const dir = build(deps.root, deps.task, round, deps.worktreePath, head, deps.readHead)
      let input: VinayaStagedReviewInput | null = null
      if (dir !== null) {
        let diff: string
        try {
          diff = deps.diff(deps.baseOf(head), head)
        } catch {
          diff = '(the diff of the judged head against its base could not be computed this round)'
        }
        const written = write(dir, {
          brief: orPlaceholder(deps.brief, "the task's frozen brief"),
          prBody: orPlaceholder(deps.prBody, 'the pull request body'),
          diff,
          priorFindings: priorFindings(round)
        })
        input = { dir, paths: written ? reviewerCandidateInputPaths(dir) : null }
      }
      staged = { round, input }
      return input
    }
  }
}

/**
 * The rulings the reviewers read, as the standalone loop assembles them before a
 * review round: the task Issue's rulings after its newest frozen brief, then the
 * pull request's. A failed Issue read falls back to the pull request's alone.
 */
export function reviewerRulings(deps: {
  task: number
  prNumber: number | null
  fetchIssueRulingsAfterBrief: (task: number) => string[]
  fetchRulings: (prNumber: number) => string[]
  warn?: (line: string) => void
}): string[] {
  let issueRulings: string[] = []
  try {
    issueRulings = deps.fetchIssueRulingsAfterBrief(deps.task)
  } catch (error) {
    ;(deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      `reading the task Issue's rulings failed (${error instanceof Error ? error.message : String(error)}); reviewers get the pull request's rulings alone`
    )
  }
  const prRulings = deps.prNumber === null ? [] : deps.fetchRulings(deps.prNumber)
  return [...issueRulings, ...prRulings]
}

/** The reviewer prompt for `role` over a staged input; a missing staging renders the prompt without input paths. */
export function renderVinayaReviewerPrompt(
  role: 'reviewer' | 'security',
  facts: ReviewerPromptFacts,
  staged: VinayaStagedReviewInput | null
): string {
  return renderReviewerDispatchPrompt(role, facts, null, staged?.paths ?? null)
}
