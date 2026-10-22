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
import { turnResultInstruction } from '../../../apps/cli/src/lib/dev-review-loop/turn-result'

// What today's review loop sends its Developer each round, built from the same exported functions
// (`renderDeveloperDoctrineBlock`, `publishingInstructionLine`, `turnResultInstruction`, the context-packet
// builders) and, where the loop builds a block in a closure no caller can reach (`issueRulingsBlock`,
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
  /** What a resumed session is told about where it is. */
  resume: { task: number; branch: string; worktree: string; remoteHead: string | null }
  /** The previous round's held review verdicts, rendered (reviewer, then security). */
  heldReview: string | null
}

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
  const gateOutput =
    gates?.kind === 'mechanical' && gates.exitCode !== 0
      ? [
          {
            reference: 'run-mechanical-gates',
            summary: gates.stdout.slice(-4000)
          }
        ]
      : []
  return { unresolvedFindings, gateOutput }
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

/** Why the Developer runs again: first turn, a red gate on its last head, or the round's review findings. */
export function developerTurnKind(results: Readonly<Record<string, StepNodeResult>>): 'first' | 'gate-red' | 'review' {
  if (results.develop === undefined) return 'first'
  const gate = results['run-mechanical-gates']
  return gate !== undefined && gate.exitCode !== 0 ? 'gate-red' : 'review'
}

/** The loop's later-round prompt text: what to fix, the finding ids to cite, and how to publish the fix. */
function revisionPromptText(
  kind: 'gate-red' | 'review',
  facts: DeveloperPromptFacts,
  results: Readonly<Record<string, StepNodeResult>>
): string {
  const { unresolvedFindings, gateOutput } = revisionFacts(results)
  const handoff = kind === 'review' ? unresolvedFindings : []
  return [
    kind === 'gate-red'
      ? [
          'The checks (`vinaya check --all`) are red on the last head. Fix the failing check(s).',
          ...gateOutput.map((gate) => `\`${gate.reference}\` output (tail):\n\n${gate.summary}`)
        ].join('\n\n')
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
  const kind = developerTurnKind(results)
  const join = (parts: readonly (string | null)[]) =>
    parts.filter((part): part is string => part !== null && part.length > 0).join('\n\n')
  if (kind === 'first')
    return join([
      facts.sources.block,
      facts.doctrine ? renderDeveloperDoctrineBlock(facts.doctrine) : null,
      `When your work is ready, ${publishingInstructionLine()}`,
      issueRulingsBlock(facts.issueRulings),
      keptWorkNote(facts.keptWork),
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
    revisionPromptText(kind, facts, results),
    turnResultInstruction(facts.round)
  ])
}
