import { briefHash, policyDigest, type ReviewPolicy } from '@attalabs/aeg-core'
import type { StepNodeResult } from '@atta/executor-agent-spawn'
import {
  buildDeveloperDeltaPacket,
  buildDeveloperFullPacket,
  renderContextPacket,
  type EvidenceEntry
} from '../../../apps/cli/src/lib/context-packet'
import { publishingInstructionLine } from '../../../apps/cli/src/lib/dev-review-loop'
import { renderDeveloperDoctrineBlock } from '../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import { renderConflictPrompt } from '../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import { commitAndPushPrompt } from '../../../apps/cli/src/lib/task-tools/live-developer-context'
import {
  turnResultCorrectionPrompt,
  turnResultInstruction
} from '../../../apps/cli/src/lib/dev-review-loop/turn-result'
import { latestRecord, recordedForgeCi, type SendBack } from './actions'

// What today's review loop sends its Developer each round, built from the same exported functions
// (`renderDeveloperDoctrineBlock`, `publishingInstructionLine`, `turnResultInstruction`, the context-packet
// builders, `renderConflictPrompt`) and, where the loop builds a block in a closure no caller can reach (`issueRulingsBlock`,
// `keptWorkNote`, `resumeContextBlock`, the review-findings prompt of `dev-review-loop.ts`), the same text.
// The facts come from `DeveloperPromptFacts`, so a test supplies them without reaching the forge.

/** What the prompt is made of, read when the Developer's step starts. */
export interface DeveloperPromptFacts {
  brief: string
  objectives: {
    objectives: readonly { id: string; text: string }[]
    version: string | null
  }
  rulings: readonly string[]
  rulingOrdinal: number
  policy: ReviewPolicy
  baseSha: string
  headSha: string
  /** The round's prepared sources: the prompt block they lead with and their evidence entries. */
  sources: { block: string | null; evidence: readonly EvidenceEntry[] }
  round: number
  /** The developer role's doctrine, given to a fresh session only (a resumed one already holds it). */
  doctrine: string | null
  /** The Principal rulings on the task Issue after its newest frozen brief. */
  issueRulings: readonly string[]
  /** Unpublished work already in the task worktree, or null when there is none. */
  keptWork: { dirtyFiles: readonly string[]; aheadCount: number } | null
  /** The pre-push hook's refusal of the Developer's last publication, quoted back so the next turn fixes its cause; absent or null when none is pending. */
  lastPushRefusal?: string | null
  /** True for the first Developer turn after the run resumed from a Principal ruling. */
  rulingsOwed?: boolean
  /** What a resumed session is told about where it is. */
  resume: { task: number; branch: string; worktree: string; remoteHead: string | null }
  /** The previous round's held review verdicts, rendered (reviewer, then security). */
  heldReview: string | null
  /** The flow key the run chose; version 2 tells the Developer how its pushes and pull request work. */
  flow?: string
}

/**
 * Version 2's publishing note: every commit is pushed as a storage push (cheap checks, no tests, no CI) while no
 * pull request is open, and `open_pull_request` only saves the body; the driver opens the pull request once both
 * reviewers approve and the ready push's tests pass. The Developer runs no tests and no evidence refresh in this flow.
 */
export const FLOW_V2_NOTE =
  'This run uses review locally, push once: publish every commit with `publish_changes` — while no pull request is open each push is a storage push (cheap checks only, no tests, no CI), so publish often. Call `open_pull_request` once with the full PR-report body: in this flow it saves the body, and the driver opens the pull request itself after both reviewers approve and the ready push runs the selected tests. Do not wait for CI: the reviewers judge your local commit each round. Run no tests and do not call `refresh_evidence`: the ready push runs the selected tests, and the driver writes the Evidence block once the pull request opens.'

const TOOL_CATALOG = [
  'fetch_documentation',
  'run_checks',
  'publish_changes',
  'open_pull_request',
  'update_pull_request_body',
  'refresh_evidence',
  'read_pull_request'
]

/** The findings and failing gate output the step's earlier results hand a later round. */
export function revisionFacts(results: Readonly<Record<string, StepNodeResult>>): {
  unresolvedFindings: { id: string; description: string }[]
  gateOutput: { reference: string; summary: string }[]
} {
  let unresolvedFindings: { id: string; description: string }[] = []
  const handoff = results['build-revision-handoff']
  if (handoff?.kind === 'mechanical') {
    try {
      const parsed = JSON.parse(handoff.stdout) as Array<{
        id: string
        line: string
      }>
      unresolvedFindings = parsed.map((finding) => ({
        id: finding.id,
        description: finding.line
      }))
    } catch {
      unresolvedFindings = []
    }
  }
  const gates = results['run-mechanical-gates']
  const ci = recordedForgeCi(results)
  const gateOutput =
    gates?.kind === 'mechanical' && gates.exitCode !== 0
      ? [
          {
            reference: 'run-mechanical-gates',
            summary: gates.stdout.slice(-4000)
          }
        ]
      : ci?.conclusion === 'red'
        ? [{ reference: 'read-forge-ci', summary: forgeCiSummary(ci.failingChecks) }]
        : []
  return { unresolvedFindings, gateOutput }
}

/** The standalone loop's account of a red CI read: the failing check runs, by name and run. */
function forgeCiSummary(failingChecks: readonly string[]): string {
  return `CI is red on the last head. Failing check-run(s): ${
    failingChecks.length > 0 ? failingChecks.join(', ') : '(unknown)'
  }. Fix the failing check(s).`
}

/** The Principal rulings on the task's pull request, in their own words; null when there are none. */
export function pullRequestRulingsBlock(rulings: readonly string[]): string | null {
  return rulings.length === 0
    ? null
    : `Principal rulings on this pull request:\n\n${rulings.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`
}

/** The loop's `issueRulingsBlock`: the Issue's rulings after the brief, or null when there are none. */
export function issueRulingsBlock(rulings: readonly string[]): string | null {
  return rulings.length === 0
    ? null
    : `Principal ruling on this pause:\n\n${rulings.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`
}

/** The loop's `keptWorkNote`: the worktree's unpublished work is the Developer's own, to continue and publish. */
export function keptWorkNote(kept: DeveloperPromptFacts['keptWork']): string | null {
  if (kept === null || (kept.dirtyFiles.length === 0 && kept.aheadCount === 0)) return null
  return [
    `Kept work: this task's worktree holds work left unpublished by an earlier pause, kept as it is by the driver — dirty file(s): ${kept.dirtyFiles.length > 0 ? kept.dirtyFiles.join(', ') : 'none'}; ${kept.aheadCount} commit(s) ahead of the remote.`,
    "It is this task's own earlier work. Continue it and publish it through `publish_changes`; do not discard it, and do not refuse the task because of it.",
    'Pre-flight item 1 ("Clean status") accepts exactly this kept work: any other uncommitted change still fails it.'
  ].join(' ')
}

/** The loop's `resumeContextBlock`: the Issue, branch, worktree and remote head a continued session works on. */
export function resumeContextBlock(resume: DeveloperPromptFacts['resume']): string {
  return [
    `Resuming task Issue #${resume.task}.`,
    `Branch: \`${resume.branch}\``,
    `Worktree: \`${resume.worktree}\``,
    `Remote head: ${resume.remoteHead ?? '(no head on origin)'}`
  ].join('\n')
}

/** The standalone loop's commit-and-push prompt, naming the refusal the last publication met; null when there is none. */
function pushRefusalPrompt(facts: DeveloperPromptFacts): string | null {
  return facts.lastPushRefusal ? commitAndPushPrompt(facts.lastPushRefusal, publishingInstructionLine()) : null
}

/**
 * The account the live-check step gave of a failed `[live]` line on `headSha`, or null when its last result
 * was not a failure on that head — a result recorded for an earlier head is not this turn's reason.
 */
export function liveWithdrawalOf(results: Readonly<Record<string, StepNodeResult>>, headSha: string): string | null {
  const live = results['run-live-checks']
  if (live?.kind !== 'mechanical' || live.exitCode === 0) return null
  try {
    const parsed = JSON.parse(live.stdout) as { head?: unknown; withdrawal?: unknown }
    return parsed.head === headSha && typeof parsed.withdrawal === 'string' ? parsed.withdrawal : null
  } catch {
    return null
  }
}

/** Why the Developer is dispatched again, as the newest deciding step recorded it; null when none did. */
export function latestSendBack(results: Readonly<Record<string, StepNodeResult>>): SendBack | null {
  try {
    return latestRecord(results)?.sendBack ?? null
  } catch {
    return null
  }
}

/** What the Developer's turn answers: its first turn, or the reason the newest deciding step sent it back. */
export type DeveloperTurnKind =
  | 'first'
  | 'gate-red'
  | 'conflict'
  | 'live-red'
  | 'review'
  | 'correction'
  | 'open-pull-request'
  | 'unpushed'
  | 'ask-confidence'
  | 'ready-refused'
  | 'ci-red'

/** Why the Developer runs again: first turn, a red gate or a conflict on its last head, a failed live line, a rejected turn result, no push, or the round's review findings. */
export function developerTurnKind(
  results: Readonly<Record<string, StepNodeResult>>,
  headSha?: string
): DeveloperTurnKind {
  const sendBack = latestSendBack(results)
  // A run that attached to an open pull request may send its Developer back before any Developer step ran.
  if (results.develop === undefined && sendBack === null) return 'first'
  switch (sendBack?.kind) {
    case 'correction':
    case 'open-pull-request':
    case 'unpushed':
    case 'ask-confidence':
    case 'gate-red':
    case 'conflict':
    case 'ready-refused':
    case 'ci-red':
      return sendBack.kind
    case 'live-red':
      return headSha !== undefined && liveWithdrawalOf(results, headSha) !== null ? 'live-red' : 'review'
    case 'review':
    case 'low-confidence':
      return 'review'
    default: {
      const gate = results['run-mechanical-gates']
      if (gate !== undefined && gate.exitCode !== 0) return 'gate-red'
      return headSha !== undefined && liveWithdrawalOf(results, headSha) !== null ? 'live-red' : 'review'
    }
  }
}

/** The texts of a turn that only answers the driver, never a new turn of work; null for a revision. */
function answerPromptText(
  kind: DeveloperTurnKind,
  facts: DeveloperPromptFacts,
  results: Readonly<Record<string, StepNodeResult>>
): string | null {
  const sendBack = latestSendBack(results)
  const doctrineLine = `Per your role doctrine (\`bun apps/cli/src/index.ts doctrine --role developer --print\`): ${publishingInstructionLine()}`
  switch (kind) {
    case 'correction':
      return turnResultCorrectionPrompt(sendBack?.failures ?? [], {
        round: facts.round,
        attempt: 1,
        head: sendBack?.head ?? null,
        knownFindingIds: sendBack?.knownFindingIds ?? []
      })
    case 'open-pull-request':
      return join([
        facts.flow === 'v2'
          ? 'Your previous turn left no staged pull-request body: call `open_pull_request` with the full PR-report body.'
          : 'Your previous turn left no commit on this branch yet, and no open pull request.',
        issueRulingsBlock(facts.issueRulings),
        doctrineLine,
        facts.flow === 'v2' ? FLOW_V2_NOTE : null
      ])
    case 'unpushed':
      return commitAndPushPrompt(facts.lastPushRefusal ?? null, publishingInstructionLine())
    case 'ask-confidence':
      return 'The driver holds no accepted `completed` turn result for this round, so it has no confidence to read. Change and publish nothing; report your turn result for the work already on this branch.'
    default:
      return null
  }
}

const join = (parts: readonly (string | null)[]) =>
  parts.filter((part): part is string => part !== null && part.length > 0).join('\n\n')

/** The loop's later-round prompt text: what to fix, the finding ids to cite, and how to publish the fix. */
function revisionPromptText(
  kind: DeveloperTurnKind,
  facts: DeveloperPromptFacts,
  results: Readonly<Record<string, StepNodeResult>>
): string {
  const { unresolvedFindings, gateOutput } = revisionFacts(results)
  const handoff = kind === 'review' ? unresolvedFindings : []
  const forgeCiRed = gateOutput.find((gate) => gate.reference === 'read-forge-ci')
  return [
    kind === 'conflict'
      ? renderConflictPrompt(latestSendBack(results)?.files ?? [], publishingInstructionLine())
      : kind === 'gate-red' && forgeCiRed !== undefined
        ? forgeCiRed.summary
        : kind === 'gate-red'
          ? [
              'The checks (`vinaya check --all`) are red on the last head. Fix the failing check(s).',
              ...gateOutput.map((gate) => `\`${gate.reference}\` output (tail):\n\n${gate.summary}`)
            ].join('\n\n')
          : kind === 'live-red'
            ? (liveWithdrawalOf(results, facts.headSha) ?? '')
            : kind === 'ready-refused' || kind === 'ci-red'
              ? (latestSendBack(results)?.detail ?? '')
              : `Round ${facts.round} review findings:\n\n${facts.heldReview ?? '(no held review was found for the previous round)'}\n`,
    handoff.length > 0
      ? `Finding ids in this handoff — cite the ones you address in your turn result's \`addressedFindingIds\`:\n${handoff.map((f) => `- ${f.id}: ${f.description}`).join('\n')}`
      : '',
    `Address the findings above per your role doctrine (\`bun apps/cli/src/index.ts doctrine --role developer --print\`), then ${publishingInstructionLine()} Publish the fix as a new commit on this SAME branch — do not open a new pull request.`
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * The Developer's complete prompt, assembled as the loop's \`dispatchDeveloper\` assembles it:
 * - first turn: required sources, then the round-1 preamble (doctrine, the publishing line, the Issue
 *   rulings, the kept-work note, the turn-result instruction), the full context packet, the frozen brief;
 * - later turns: required sources, the delta context packet (naming the continued session), the resume
 *   context, the revision text, the turn-result instruction.
 * The Flow's own rendered line is not sent: the loop's Developer receives none.
 */
export function developerPrompt(
  _rendered: string,
  facts: DeveloperPromptFacts,
  results: Readonly<Record<string, StepNodeResult>>,
  context: { resumeSessionId?: string } = {}
): string {
  const retained = buildDeveloperFullPacket({
    brief: facts.brief,
    briefDigest: briefHash(facts.brief),
    objectives: facts.objectives.objectives.map((o) => `${o.id}: ${o.text}`).join('\n'),
    objectivesVersion: facts.objectives.version ?? 'none',
    rulings: facts.rulings,
    rulingOrdinal: facts.rulingOrdinal,
    policyDigest: policyDigest(facts.policy),
    baseSha: facts.baseSha,
    headSha: facts.headSha,
    preparedSources: facts.sources.evidence,
    capabilities: ['Execute only this frozen brief on the task branch.', publishingInstructionLine()],
    toolCatalog: TOOL_CATALOG,
    expectedResult: 'DeveloperTurnResult schema version 1',
    budgets: [`review rounds: ${facts.policy.maxRounds}`, `task minutes: ${facts.policy.maxTaskMinutes}`],
    stopConditions: ['Honor every stop condition in the frozen brief.']
  })
  const kind = developerTurnKind(results, facts.headSha)
  if (kind === 'first')
    return join([
      facts.sources.block,
      facts.doctrine ? renderDeveloperDoctrineBlock(facts.doctrine) : null,
      `When your work is ready, ${publishingInstructionLine()}`,
      facts.flow === 'v2' ? FLOW_V2_NOTE : null,
      issueRulingsBlock(facts.issueRulings),
      keptWorkNote(facts.keptWork),
      pushRefusalPrompt(facts),
      turnResultInstruction(facts.round),
      renderContextPacket(retained),
      facts.brief
    ])
  const packet = buildDeveloperDeltaPacket({
    retainedPacket: retained,
    previousSessionId: context.resumeSessionId ?? null,
    changedFacts: [{ ref: 'head', version: `sha:${facts.headSha}` }],
    ...revisionFacts(results),
    constraints: ['Continue the same frozen brief on the same task branch.', publishingInstructionLine()]
  })
  return join([
    facts.sources.block,
    renderContextPacket(packet),
    resumeContextBlock(facts.resume),
    // The turn after a resume from a ruling carries the rulings' own words, not only their ordinal in the
    // packet: a ruling the Developer cannot read answers nothing.
    // Only the first turn after a resume from a ruling, as the loop's own dispatch carries it once.
    facts.rulingsOwed === true && kind !== 'open-pull-request' ? issueRulingsBlock(facts.issueRulings) : null,
    facts.rulingsOwed === true ? pullRequestRulingsBlock(facts.rulings) : null,
    ...(answerPromptText(kind, facts, results) === null
      ? [pushRefusalPrompt(facts), revisionPromptText(kind, facts, results)]
      : [answerPromptText(kind, facts, results)]),
    turnResultInstruction(facts.round)
  ])
}
