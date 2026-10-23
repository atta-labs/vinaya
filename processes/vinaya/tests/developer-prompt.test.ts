import { describe, expect, test } from 'bun:test'
import { briefHash, initialLoopState, policyDigest } from '@attalabs/aeg-core'
import type { StepNodeResult } from '@atta/executor-agent-spawn'
import {
  buildDeveloperDeltaPacket,
  buildDeveloperFullPacket,
  renderContextPacket
} from '../../../apps/cli/src/lib/context-packet'
import { developerContinuationFacts, publishingInstructionLine } from '../../../apps/cli/src/lib/dev-review-loop'
import { renderDeveloperDoctrineBlock } from '../../../apps/cli/src/lib/dev-review-loop/developer-dispatch'
import { renderConflictPrompt } from '../../../apps/cli/src/lib/dev-review-loop/gate-reading'
import { turnResultInstruction } from '../../../apps/cli/src/lib/dev-review-loop/turn-result'
import { encodeLoopState } from '../executing/actions'
import { type DeveloperPromptFacts, developerPrompt } from '../executing/developer-prompt'

const FACTS: DeveloperPromptFacts = {
  brief: '# Frozen brief\nDo the one thing.\n\n**Revision:** abc',
  objectives: { objectives: [{ id: 'O1', text: 'It works' }], version: 'v1' },
  rulings: ['PR ruling: keep going.'],
  rulingOrdinal: 2,
  policy: { maxRounds: 4, maxTaskMinutes: 90 } as DeveloperPromptFacts['policy'],
  baseSha: 'b'.repeat(40),
  headSha: 'a'.repeat(40),
  sources: { block: 'Required sources:\n- docs/x.md', evidence: [{ ref: 'source:docs/x.md', version: 'sha256:1' }] },
  round: 1,
  doctrine: 'Developer doctrine: stop when blocked.',
  issueRulings: ['Issue ruling: publish first, then open the pull request.'],
  keptWork: { dirtyFiles: ['src/a.ts'], aheadCount: 0 },
  resume: { task: 7, branch: 'task/issue-7', worktree: '/repo/.worktrees/task/issue-7', remoteHead: 'c'.repeat(40) },
  heldReview: null
}
const mech = (exitCode: number, stdout = '') => ({ kind: 'mechanical', exitCode, stdout }) as unknown as StepNodeResult
const handoff = [{ id: 'R1-CR-1', line: '[MAJOR] src/a.ts:3' }]
const ROUND2: DeveloperPromptFacts = {
  ...FACTS,
  round: 2,
  heldReview: 'REQUEST CHANGES — F1 src/a.ts:3\n\n---\n\nPASS'
}
const reviewResults = {
  develop: mech(0),
  'run-mechanical-gates': mech(0),
  'build-revision-handoff': mech(0, JSON.stringify(handoff))
}
const SESSION = 'session-1'

// Today's loop prompts for the same inputs, assembled as `dev-review-loop.ts` assembles them: the round-1
// prompt of its fresh dispatch (`round1Prompt`, sent with `skipResumeContext`), and `dispatchDeveloper`'s
// later-round prompt over the review-findings text. Its `issueRulingsBlock`, `keptWorkNote`,
// `resumeContextBlock` and findings prompt are closures no caller can import, so their text is spelled here.
function retained(f: DeveloperPromptFacts) {
  return buildDeveloperFullPacket({
    brief: f.brief,
    briefDigest: briefHash(f.brief),
    objectives: f.objectives.objectives.map((o) => `${o.id}: ${o.text}`).join('\n'),
    objectivesVersion: f.objectives.version ?? 'none',
    rulings: f.rulings,
    rulingOrdinal: f.rulingOrdinal,
    policyDigest: policyDigest(f.policy),
    baseSha: f.baseSha,
    headSha: f.headSha,
    preparedSources: f.sources.evidence,
    capabilities: ['Execute only this frozen brief on the task branch.', publishingInstructionLine()],
    toolCatalog: [
      'fetch_documentation',
      'run_checks',
      'publish_changes',
      'open_pull_request',
      'update_pull_request_body',
      'refresh_evidence',
      'read_pull_request'
    ],
    expectedResult: 'DeveloperTurnResult schema version 1',
    budgets: [`review rounds: ${f.policy.maxRounds}`, `task minutes: ${f.policy.maxTaskMinutes}`],
    stopConditions: ['Honor every stop condition in the frozen brief.']
  })
}
const join = (parts: (string | null)[]) => parts.filter((p): p is string => p !== null && p.length > 0).join('\n\n')
function loopRound1(f: DeveloperPromptFacts): string {
  const round1Prompt = [
    renderDeveloperDoctrineBlock(f.doctrine as string),
    `When your work is ready, ${publishingInstructionLine()}`,
    `Principal ruling on this pause:\n\n${f.issueRulings.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n`,
    `Kept work: this task's worktree holds work left unpublished by an earlier pause, kept as it is by the driver — dirty file(s): ${f.keptWork?.dirtyFiles.join(', ')}; ${f.keptWork?.aheadCount} commit(s) ahead of the remote. It is this task's own earlier work. Continue it and publish it through \`publish_changes\`; do not discard it, and do not refuse the task because of it. Pre-flight item 1 ("Clean status") accepts exactly this kept work: any other uncommitted change still fails it.`,
    turnResultInstruction(f.round),
    f.brief
  ].join('\n\n')
  const preamble = round1Prompt.slice(0, -f.brief.length).trimEnd()
  return join([f.sources.block, preamble, renderContextPacket(retained(f)), f.brief])
}
function loopReviewRound(f: DeveloperPromptFacts): string {
  const promptText = [
    `Round ${f.round} review findings:\n\n${f.heldReview}\n`,
    `Finding ids in this handoff — cite the ones you address in your turn result's \`addressedFindingIds\`:\n${handoff.map((h) => `- ${h.id}: ${h.line}`).join('\n')}`,
    `Address the findings above per your role doctrine (\`bun apps/cli/src/index.ts doctrine --role developer --print\`), then ${publishingInstructionLine()} Publish the fix as a new commit on this SAME branch — do not open a new pull request.`
  ].join('\n\n')
  const packet = buildDeveloperDeltaPacket({
    retainedPacket: retained(f),
    previousSessionId: SESSION,
    changedFacts: [{ ref: 'head', version: `sha:${f.headSha}` }],
    ...developerContinuationFacts({
      status: 'ok',
      value: {
        developerHandoff: { findings: handoff.map((h) => ({ id: h.id, description: h.line })), failingChecks: [] }
      }
    } as never),
    constraints: ['Continue the same frozen brief on the same task branch.', publishingInstructionLine()]
  })
  const resume = [
    `Resuming task Issue #${f.resume.task}.`,
    `Branch: \`${f.resume.branch}\``,
    `Worktree: \`${f.resume.worktree}\``,
    `Remote head: ${f.resume.remoteHead}`
  ].join('\n')
  return join([f.sources.block, renderContextPacket(packet), resume, promptText, turnResultInstruction(f.round)])
}

describe("the Engine Developer's prompt is today's loop prompt", () => {
  test('round 1 equals the loop round-1 prompt for the same inputs', () => {
    expect(developerPrompt('Develop the task Task 7.', FACTS, {})).toBe(loopRound1(FACTS))
  })

  test('a review round equals the loop review-findings prompt for the same inputs', () => {
    expect(developerPrompt('Develop the task Task 7.', ROUND2, reviewResults, { resumeSessionId: SESSION })).toBe(
      loopReviewRound(ROUND2)
    )
  })

  test('round 1 carries each block, in the loop order', () => {
    const prompt = developerPrompt('x', FACTS, {})
    const order = [
      'Required sources:',
      'YOUR ROLE DOCTRINE',
      'When your work is ready, publish only through the driver-run tools',
      'Principal ruling on this pause:',
      'Kept work:',
      turnResultInstruction(1).slice(0, 40),
      '# Context packet v1',
      '# Frozen brief'
    ]
    const at = order.map((block) => prompt.indexOf(block))
    for (const index of at) expect(index).toBeGreaterThanOrEqual(0)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    // No doctrine without one, no kept-work note for a clean worktree, no rulings block without rulings.
    const bare = developerPrompt('x', { ...FACTS, doctrine: null, keptWork: null, issueRulings: [] }, {})
    for (const absent of ['YOUR ROLE DOCTRINE', 'Kept work:', 'Principal ruling on this pause:'])
      expect(bare).not.toContain(absent)
  })

  test('round 2 carries the resume context, the held findings, their ids and the continued session', () => {
    const prompt = developerPrompt('x', ROUND2, reviewResults, { resumeSessionId: SESSION })
    for (const block of [
      'Resuming task Issue #7.',
      'Branch: `task/issue-7`',
      'Round 2 review findings:',
      'REQUEST CHANGES — F1 src/a.ts:3',
      '- R1-CR-1: [MAJOR] src/a.ts:3',
      'Publish the fix as a new commit on this SAME branch',
      SESSION,
      turnResultInstruction(2).slice(0, 40)
    ])
      expect(prompt).toContain(block)
    // A resumed session is not re-given its doctrine or the brief's round-1 preamble.
    expect(prompt).not.toContain('YOUR ROLE DOCTRINE')
    expect(prompt).not.toContain('When your work is ready')
  })

  test('after a red gate, the prompt names the failing check output (the one intended difference)', () => {
    const results = { develop: mech(0), 'run-mechanical-gates': mech(1, '✗ closes-n: fail') }
    const prompt = developerPrompt('x', FACTS, results, { resumeSessionId: SESSION })
    // The loop names the failing CI check-runs and their logs; the Engine's gate is the local
    // `vinaya check --all`, so it names that output instead.
    expect(prompt).toContain('The checks (`vinaya check --all`) are red on the last head. Fix the failing check(s).')
    expect(prompt).toContain('✗ closes-n: fail')
    expect(prompt).toContain('Resuming task Issue #7.')
  })
})

/** A deciding step's record of sending the Developer back, as the actions write it. */
function sentBack(sendBack: Record<string, unknown>, seq = 3): StepNodeResult {
  const state = initialLoopState({
    loopId: 'l',
    task: 7,
    reviewers: ['reviewer', 'security'],
    models: {},
    maxRounds: 4,
    maxTaskMinutes: 90
  })
  return mech(
    1,
    JSON.stringify({
      seq,
      state: JSON.parse(encodeLoopState(state)),
      counters: {},
      sendBack,
      answered: null,
      events: [],
      decision: { type: 'dispatch_developer' }
    })
  )
}

/** The loop's later-round prompt over `promptText` with no handoff findings or failing checks carried. */
function loopLaterRound(f: DeveloperPromptFacts, promptText: string): string {
  const packet = buildDeveloperDeltaPacket({
    retainedPacket: retained(f),
    previousSessionId: SESSION,
    changedFacts: [{ ref: 'head', version: `sha:${f.headSha}` }],
    ...developerContinuationFacts({
      status: 'ok',
      value: { developerHandoff: { findings: [], failingChecks: [] } }
    } as never),
    constraints: ['Continue the same frozen brief on the same task branch.', publishingInstructionLine()]
  })
  const resume = [
    `Resuming task Issue #${f.resume.task}.`,
    `Branch: \`${f.resume.branch}\``,
    `Worktree: \`${f.resume.worktree}\``,
    `Remote head: ${f.resume.remoteHead}`
  ].join('\n')
  return join([f.sources.block, renderContextPacket(packet), resume, promptText, turnResultInstruction(f.round)])
}

const ADDRESS_LINE = `Address the findings above per your role doctrine (\`bun apps/cli/src/index.ts doctrine --role developer --print\`), then ${publishingInstructionLine()} Publish the fix as a new commit on this SAME branch — do not open a new pull request.`

describe("the Engine Developer's prompt after a forge gate sent it back", () => {
  test('after a conflict it carries only the delta: the loop conflict text naming the files, then the turn-result instruction', () => {
    const results = {
      develop: mech(0),
      'run-mechanical-gates': mech(0),
      'check-mergeability': sentBack({ kind: 'conflict', headBefore: 'h1', files: ['src/a.ts', 'src/b.ts'] })
    }
    const prompt = developerPrompt('x', FACTS, results, { resumeSessionId: SESSION })
    const conflict = renderConflictPrompt(['src/a.ts', 'src/b.ts'], publishingInstructionLine())
    expect(prompt).toBe(loopLaterRound(FACTS, [conflict, ADDRESS_LINE].join('\n\n')))
    expect(prompt).toContain('- src/a.ts\n- src/b.ts')
    expect(prompt.indexOf(conflict)).toBeLessThan(prompt.indexOf(turnResultInstruction(FACTS.round)))
    // Never the brief, nor its Documentation section.
    expect(prompt).not.toContain('# Frozen brief')
    expect(prompt).not.toContain('Do the one thing.')
    expect(prompt).not.toContain('## Documentation')
  })

  test('after a red CI read it names the failing check runs as the loop does', () => {
    const results = {
      develop: mech(0),
      'run-mechanical-gates': mech(0),
      'read-forge-ci': mech(
        0,
        JSON.stringify({
          head: 'h1',
          conclusion: 'red',
          failingChecks: ['unit (run 9)', 'lint (run 10)'],
          rerunHeads: [],
          rerunRunIds: []
        })
      ),
      'assess-gate': sentBack({ kind: 'gate-red', headBefore: 'h1' })
    }
    const prompt = developerPrompt('x', FACTS, results, { resumeSessionId: SESSION })
    expect(prompt).toContain(
      'CI is red on the last head. Failing check-run(s): unit (run 9), lint (run 10). Fix the failing check(s).'
    )
    expect(prompt).not.toContain('The checks (`vinaya check --all`) are red')
    expect(prompt).not.toContain('# Frozen brief')
  })
})
