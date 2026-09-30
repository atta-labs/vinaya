/**
 * Named fixture executions — realistic, hand-checkable streams of typed log
 * events, each built to exercise one behaviour a reader of the log must get
 * right. They are generated, never committed as data: every valid line is made
 * by the real header builder (`../envelope`), and the test beside this file
 * parses each one with the real event schema, so a schema change that would
 * invalidate a fixture fails there first. A line that is deliberately not
 * valid (an unknown version, a failing line, a repeat) is raw text kept beside
 * the valid ones and marked with how a reader should classify it.
 *
 * The hand-written answer key for each execution is in `./fact-sheets`.
 */

import { createRecorder, FIXTURE_SEED, type EmitOptions, type FixtureLine, type Recorder } from './generator'
import type { Role } from '../schema'

export const EXECUTION_NAMES = ['green-one-round'] as const
export type ExecutionName = (typeof EXECUTION_NAMES)[number]

export type FixtureExecution = {
  name: ExecutionName
  description: string
  /** The execution's lines, in the order they were stored. */
  lines: readonly FixtureLine[]
}

type Finding = {
  id: string
  severity: string
  severity_scale: string
  policy_treatment: 'blocking' | 'non_blocking'
}

type LoopEmit = (event: string, fields: Record<string, unknown>, options?: EmitOptions) => Record<string, unknown>

function openLoop(rec: Recorder): LoopEmit {
  const loopId = `loop-${rec.hex(8)}`
  const emit: LoopEmit = (event, fields, options) =>
    rec.emit(
      { kind: 'dev_review_loop', event, loop_id: loopId, ...fields },
      { host: 'loop', ...(typeof fields.round === 'number' ? { round: fields.round } : {}), ...options }
    )
  emit('loop_started', {
    task: rec.issue,
    policy: {
      max_rounds: 5,
      reviewers: ['code-reviewer'],
      models: { developer: 'sonnet', 'code-reviewer': 'opus' }
    }
  })
  return emit
}

/** One dispatch of a role: the `dispatched` line now, the `outcome_received` line when the returned function is called. */
function dispatch(rec: Recorder, target: Role, model: string, round: number) {
  const effectId = `eff-${rec.hex(8)}`
  const shared = { kind: 'dispatch', target_role: target, model, round, effect_id: effectId }
  const options = { round, provenance: 'parent_attributed' as const }
  rec.emit({ ...shared, event: 'dispatched', prompt_hash: `fixture-prompt-${rec.hex(8)}` }, options)
  return (outcome: Record<string, unknown>) =>
    rec.emit(
      {
        ...shared,
        event: 'outcome_received',
        outcome,
        usage: { input: rec.int(2000, 9000), output: rec.int(300, 1500) }
      },
      options
    )
}

type RoundSpec = {
  n: number
  base: string
  head: string
  /** What this round's reviewer reports. */
  findings: Finding[]
  /** The loop's own comparison with the round before — absent in round 1. */
  compared?: { open: string[]; resolved: string[]; new: string[]; recurring: string[] }
  /** The developer's stated confidence, as `gate_result_read` records it. */
  confidence?: Record<string, unknown>
}

/** One full review round on a green gate: developer turn, typecheck, gate read, reviewer turn, verdicts, comparison, end. Returns the files it changed. */
function runRound(rec: Recorder, loop: LoopEmit, spec: RoundSpec): number {
  const { n, base, head, findings } = spec
  const blockers = findings.filter((f) => f.policy_treatment === 'blocking').length
  const approved = blockers === 0
  loop('round_started', { round: n, base_head: base })
  const developer = dispatch(rec, 'developer', 'sonnet', n)
  developer(
    n === 1
      ? { type: 'pr_opened', pr: rec.pr, head }
      : { type: 'round_pushed', pr: rec.pr, head, comment_id: rec.commentId() }
  )
  rec.emit(
    {
      kind: 'gate',
      event: 'checked',
      check: 'typecheck',
      check_version: '1',
      policy_version: null,
      input_fingerprint: `fp-${rec.hex(8)}`,
      outcome: 'pass'
    },
    { round: n, sha: head, host: 'ci' }
  )
  loop('gate_result_read', { round: n, head, green: true, ...spec.confidence })
  const reviewer = dispatch(rec, 'code-reviewer', 'opus', n)
  reviewer({
    type: 'verdict',
    verdict: approved ? 'APPROVE' : 'REQUEST CHANGES',
    head,
    comment_id: rec.commentId(),
    objectives: [{ id: 'O1', met: approved }],
    findings
  })
  loop('verdicts_read', { round: n, head, all_approve: approved, blockers, findings })
  if (spec.compared) loop('findings_compared', { round: n, ...spec.compared })
  const filesChanged = rec.int(2, 9)
  loop('round_ended', {
    round: n,
    base_head: base,
    head,
    files_changed: filesChanged,
    insertions: rec.int(20, 200),
    deletions: rec.int(0, 60),
    wall_ms: rec.int(60_000, 600_000),
    outcome: approved ? 'green' : 'changes_requested'
  })
  return filesChanged
}

/** The loop's green ending: the stop condition, then the journal. */
function finishGreen(rec: Recorder, loop: LoopEmit, rounds: number, finalHead: string, filesTotal: number): void {
  loop('stop_condition_met', { round: rounds, condition: 'green' })
  const elapsed = rec.elapsedMs()
  loop('journal_finalized', {
    rounds,
    total_wall_ms: elapsed,
    time_to_green_ms: elapsed,
    files_changed_total: filesTotal,
    final_head: finalHead,
    result: 'merged_ready'
  })
}

type Scenario = { description: string; issue: number; build: (rec: Recorder) => void }

const SCENARIOS: Record<ExecutionName, Scenario> = {
  'green-one-round': {
    description: 'A unit of work that finishes green in a single round, with no findings.',
    issue: 101,
    build(rec) {
      const loop = openLoop(rec)
      const head = rec.sha()
      const files = runRound(rec, loop, { n: 1, base: rec.sha(), head, findings: [] })
      finishGreen(rec, loop, 1, head, files)
    }
  }
}

/** One named execution, built from a seed. The same name and seed always give the same lines, byte for byte. */
export function buildExecution(name: ExecutionName, seed: string = FIXTURE_SEED): FixtureExecution {
  const scenario = SCENARIOS[name]
  const rec = createRecorder(seed, name, EXECUTION_NAMES.indexOf(name), scenario.issue)
  scenario.build(rec)
  return { name, description: scenario.description, lines: rec.lines }
}

/** Every named execution, in `EXECUTION_NAMES` order. */
export function buildExecutions(seed: string = FIXTURE_SEED): FixtureExecution[] {
  return EXECUTION_NAMES.map((name) => buildExecution(name, seed))
}
