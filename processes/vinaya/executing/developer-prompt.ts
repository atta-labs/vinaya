import { briefHash, policyDigest, type ReviewPolicy } from '@attalabs/aeg-core'
import type { StepNodeResult } from '@atta/executor-agent-spawn'
import {
  buildDeveloperDeltaPacket,
  buildDeveloperFullPacket,
  renderContextPacket,
  type EvidenceEntry
} from '../../../apps/cli/src/lib/context-packet'
import { publishingInstructionLine } from '../../../apps/cli/src/lib/dev-review-loop'
import { turnResultInstruction } from '../../../apps/cli/src/lib/dev-review-loop/turn-result'

// What today's review loop gives its Developer for a task, built from the same
// functions: the required-sources block, the context packet (a full one in
// round one, a delta one in later rounds), the frozen brief and the turn-result
// instruction. The facts come from `DeveloperPromptFacts`, so a test supplies
// them without reaching the forge.

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

/** The Developer's complete prompt: the step's rendered line, then what the loop's Developer is given. */
export function developerPrompt(
  rendered: string,
  facts: DeveloperPromptFacts,
  results: Readonly<Record<string, StepNodeResult>>
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
  const packet =
    facts.round === 1
      ? retained
      : buildDeveloperDeltaPacket({
          retainedPacket: retained,
          previousSessionId: null,
          changedFacts: [{ ref: 'head', version: `sha:${facts.headSha}` }],
          ...revisionFacts(results),
          constraints: ['Continue the same frozen brief on the same task branch.', publishingInstructionLine()]
        })
  return [facts.sources.block, rendered, renderContextPacket(packet), facts.brief, turnResultInstruction(facts.round)]
    .filter((part): part is string => part !== null && part.length > 0)
    .join('\n\n')
}
