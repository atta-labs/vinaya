import { existsSync } from 'node:fs'
import {
  buildReviewerScratch,
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

/**
 * A proven conflict repair whose own patch changed: what its reviewers judge instead of the whole pull request —
 * the interdiff between the own patch the approvals judged and the repaired one, and those approvals as posted.
 */
export interface RepairReview {
  /** The head the approvals judged. */
  judgedHead: string
  /** The repaired head the reviewers judge. */
  head: string
  /** The change between the two own patches; no line only the default branch brought in appears in it. */
  interdiff: string
  /** The newest posted code-review and security-review verdicts, approvals and findings as they stand. */
  approvals: { reviewer: string; security: string }
}

/** Stages the review input for a round, once; null when the judged head could not be staged. */
export interface VinayaReviewInputStager {
  /** `repair` stages a changed repair's interdiff and approvals in place of the diff and prior findings. */
  stage: (round: number, repair?: RepairReview | null) => VinayaStagedReviewInput | null
  /** A fresh copy for one role attempt, including that attempt's own input paths. */
  stageAttempt: (
    round: number,
    role: 'reviewer' | 'security',
    attempt: number,
    repair?: RepairReview | null
  ) => VinayaStagedReviewInput | null
}

/** The staged diff of a changed repair: the interdiff, introduced. */
export function repairReviewDiff(repair: RepairReview): string {
  return [
    `# The change a conflict repair made to this pull request's own patch`,
    '',
    `Both reviewers approved ${repair.judgedHead}. Merging the default branch into it produced ${repair.head}, and that merge changed the pull request's own lines. Below is the change between the pull request's own patch at ${repair.judgedHead} and at ${repair.head}: each own patch is the zero-context diff from its own merge base with the default branch, with line positions left out, so no line the default branch alone brought in appears here.`,
    '',
    repair.interdiff,
    ''
  ].join('\n')
}

/** The staged prior findings of a changed repair: the approvals it is judged against, and how to judge it. */
export function repairReviewBaseline(repair: RepairReview): string {
  return [
    '# The approvals this repair is judged against',
    '',
    `Judge the interdiff in the staged diff file, not the whole pull request. Keep every objective result below that the interdiff does not touch, as recorded; judge again each objective the interdiff affects, reading the repaired candidate; and return your verdict for ${repair.head}.`,
    '',
    '## The code review, as posted',
    '',
    repair.approvals.reviewer,
    '',
    '## The security review, as posted',
    '',
    repair.approvals.security,
    ''
  ].join('\n')
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
  /** Where a failed diff read is reported; defaults to the driver log (stderr). */
  warn?: (line: string) => void
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
  let staged: { round: number; head: string; repair: string; input: VinayaStagedReviewInput | null } | null = null
  const attempts = new Map<string, VinayaStagedReviewInput | null>()
  // A cached copy is reused only while it is still on disk: a fresh run in the same process (a conflict re-entry)
  // clears stale reviewer copies at its start, and the head it judges may have moved since.
  const present = (input: VinayaStagedReviewInput | null): boolean => input === null || existsSync(input.dir)
  return {
    stage(round, repairFor) {
      const head = deps.judgedHead()
      // A repair review stands only for the repaired head it was decided about.
      const repair = repairFor && repairFor.head === head ? repairFor : null
      const repairKey = repair === null ? '' : `${repair.judgedHead}:${repair.interdiff}`
      if (
        staged !== null &&
        staged.round === round &&
        staged.head === head &&
        staged.repair === repairKey &&
        present(staged.input)
      )
        return staged.input
      // The head is read before and after the copy; a worktree that moved mid-copy yields no candidate.
      const dir = build(deps.root, deps.task, round, deps.worktreePath, head, deps.readHead)
      let input: VinayaStagedReviewInput | null = null
      if (dir !== null) {
        let diff: string
        try {
          // A changed repair is judged by its interdiff, never by a diff that carries the default branch's own work.
          diff = repair !== null ? repairReviewDiff(repair) : deps.diff(deps.baseOf(head), head)
        } catch (error) {
          // The reason reaches both the reviewers and the driver log, so a failed read is diagnosable from either.
          const reason = error instanceof Error ? error.message : String(error)
          diff = `(the diff of the judged head against its base could not be computed this round: ${reason})`
          ;(deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`)))(
            `round ${round}: the reviewer diff of ${head} against its base could not be computed (${reason}); the reviewers get a placeholder naming it`
          )
        }
        const written = write(dir, {
          brief: orPlaceholder(deps.brief, "the task's frozen brief"),
          prBody: orPlaceholder(deps.prBody, 'the pull request body'),
          diff,
          priorFindings: repair !== null ? repairReviewBaseline(repair) : priorFindings(round)
        })
        input = { dir, paths: written ? reviewerCandidateInputPaths(dir) : null }
      }
      staged = { round, head, repair: repairKey, input }
      return input
    },
    stageAttempt(round, role, attempt, repair) {
      const candidate = this.stage(round, repair)
      const key = `${round}:${role}:${attempt}:${candidate?.dir ?? ''}:${staged?.repair ?? ''}`
      const cached = attempts.get(key)
      if (cached !== undefined && present(cached)) return cached
      const dir = candidate ? buildReviewerScratch(deps.root, deps.task, round, role, attempt, candidate.dir) : null
      const input = dir === null ? null : { dir, paths: candidate?.paths ? reviewerCandidateInputPaths(dir) : null }
      attempts.set(key, input)
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

/**
 * The reviewer prompt for `role` over a staged input; a missing staging renders the prompt without input paths,
 * and a missing doctrine renders it without the role's doctrine block. `facts.configScan` reaches the security
 * prompt only.
 */
export function renderVinayaReviewerPrompt(
  role: 'reviewer' | 'security',
  facts: ReviewerPromptFacts,
  staged: VinayaStagedReviewInput | null,
  roleDoctrine: string | null = null,
  repair: RepairReview | null = null
): string {
  const prompt = renderReviewerDispatchPrompt(role, facts, roleDoctrine, staged?.paths ?? null)
  if (repair === null || staged?.paths == null) return prompt
  return `${prompt}\n\n## This round reviews a conflict repair\n\nBoth reviewers approved ${repair.judgedHead}; a merge of the default branch into it, ${repair.head}, changed the pull request's own patch. The staged diff file (${staged.paths.diff}) holds only that change — the interdiff between the two own patches, with nothing the default branch alone brought in — and the staged prior-findings file (${staged.paths.priorFindings}) holds both approvals and their findings as posted. Judge the interdiff against them, not the whole pull request: keep each objective result the interdiff does not touch, judge again each one it affects, and return a verdict for ${repair.head}.\n`
}
