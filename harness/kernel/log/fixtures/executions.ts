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

import {
  createRecorder,
  FIXTURE_REPO,
  FIXTURE_SEED,
  LOW_TRUST_VINAYA_VERSION,
  type EmitOptions,
  type FixtureLine,
  type Recorder
} from './generator'
import type { HeaderMetaV1, HeaderMetaV2, Role } from '../schema'

export const EXECUTION_NAMES = [
  'green-one-round',
  'three-rounds-recurring-finding',
  'paused-and-resumed',
  'escalated-handoff',
  'gate-two-commits',
  'gate-no-commit',
  'gate-same-commit-twice',
  'usage-and-models',
  'historical-and-hostile-lines'
] as const
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

function finding(
  id: string,
  severity: string,
  blocking: boolean,
  scale: 'code-review' | 'security' = 'code-review'
): Finding {
  return {
    id,
    severity,
    severity_scale: scale,
    policy_treatment: blocking ? 'blocking' : 'non_blocking'
  }
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
  /** One entry per reviewer role the round held a verdict from, as a newer `verdicts_read` records them; absent on a round recorded before they existed. */
  reviewers?: Array<{ role: Role; outcome: 'approve' | 'changes_requested' | 'not_reviewed'; blockers: number }>
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
  loop('verdicts_read', {
    round: n,
    head,
    all_approve: approved,
    blockers,
    findings,
    ...(spec.reviewers ? { reviewers: spec.reviewers } : {})
  })
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

/** One run of a check. `sha` absent records no commit at all. */
function gateRun(rec: Recorder, check: string, fingerprint: string, outcome: string, sha?: string): void {
  rec.emit(
    {
      kind: 'gate',
      event: 'checked',
      check,
      check_version: '1',
      policy_version: null,
      input_fingerprint: fingerprint,
      outcome
    },
    { host: 'ci', ...(sha ? { sha } : {}) }
  )
}

function usage(
  rec: Recorder,
  model: string | null,
  semantics: 'cumulative' | 'delta',
  units: { input: number | null; output: number | null; cache: number | null },
  unknownReason: string | null = null
): void {
  rec.emit(
    { kind: 'usage', event: 'observed', model, source: 'claude', semantics, units, unknown_reason: unknownReason },
    { host: 'cli' }
  )
}

function roleAttempt(rec: Recorder, role: Role, model: string, attempt: number, outcome: string): void {
  rec.emit(
    {
      kind: 'role_attempt',
      event: 'attempted',
      actor: 'claude',
      attempt,
      effect_id: `eff-${rec.hex(8)}`,
      model,
      outcome,
      usage: null
    },
    { role, host: 'loop' }
  )
}

/** A completed operation — the smallest event, so a line's header is all that differs between the historical lines below. */
const operationFields = {
  kind: 'operation',
  event: 'completed',
  payload: {},
  operation: 'authenticate-invocation',
  target: null,
  result: 'ok',
  error_class: null
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
  },
  'three-rounds-recurring-finding': {
    description:
      'Three rounds: one finding recurs in round 2 beside a new one, and both are resolved in round 3. The developer states confidence from round 2 on — once straight away, once after the one extra turn.',
    issue: 102,
    build(rec) {
      const loop = openLoop(rec)
      const [h0, h1, h2, h3] = [rec.sha(), rec.sha(), rec.sha(), rec.sha()] as [string, string, string, string]
      const auth = finding('fnd-auth-1', 'MAJOR', true)
      const docs = finding('fnd-docs-2', 'MINOR', false)
      let files = runRound(rec, loop, { n: 1, base: h0, head: h1, findings: [auth] })
      files += runRound(rec, loop, {
        n: 2,
        base: h1,
        head: h2,
        findings: [auth, docs],
        compared: { open: ['fnd-auth-1', 'fnd-docs-2'], resolved: [], new: ['fnd-docs-2'], recurring: ['fnd-auth-1'] },
        confidence: {
          confidence_value: 70,
          confidence_reason: 'the auth path is covered, the docs are not',
          extra_turn_spent: false
        }
      })
      files += runRound(rec, loop, {
        n: 3,
        base: h2,
        head: h3,
        findings: [],
        reviewers: [
          { role: 'code-reviewer', outcome: 'approve', blockers: 0 },
          { role: 'security', outcome: 'approve', blockers: 0 }
        ],
        compared: { open: [], resolved: ['fnd-auth-1', 'fnd-docs-2'], new: [], recurring: [] },
        confidence: {
          confidence_value: 92,
          confidence_reason: 'every finding is addressed and covered by a test',
          extra_turn_spent: true
        }
      })
      finishGreen(rec, loop, 3, h3, files)
    }
  },
  'paused-and-resumed': {
    description:
      'Round 1 asks for changes and the loop pauses for a principal item; the principal resumes it, and round 2 finishes green.',
    issue: 103,
    build(rec) {
      const loop = openLoop(rec)
      const [h0, h1, h2] = [rec.sha(), rec.sha(), rec.sha()] as [string, string, string]
      const queue = finding('fnd-q-1', 'MAJOR', true)
      const secret = finding('fnd-sec-3', 'LOW', false, 'security')
      let files = runRound(rec, loop, { n: 1, base: h0, head: h1, findings: [queue, secret] })
      loop('paused', { round: 1, reason: 'principal_item' })
      loop('resumed', { round: 1, by: 'principal' })
      files += runRound(rec, loop, {
        n: 2,
        base: h1,
        head: h2,
        findings: [],
        compared: { open: [], resolved: ['fnd-q-1'], new: [], recurring: [] }
      })
      finishGreen(rec, loop, 2, h2, files)
    }
  },
  'escalated-handoff': {
    description:
      'The developer escalates a strategy question in round 1; it becomes a handoff to a human, and the loop stops unresolved.',
    issue: 104,
    build(rec) {
      const loop = openLoop(rec)
      const base = rec.sha()
      loop('round_started', { round: 1, base_head: base })
      const developer = dispatch(rec, 'developer', 'sonnet', 1)
      developer({ type: 'escalation', class: 'strategy', comment_id: rec.commentId() })
      rec.emit(
        {
          kind: 'handoff',
          event: 'raised',
          class: 'strategy',
          reason: 'the brief assumes an approach the codebase no longer takes',
          requested_decision: 'keep the brief as written, or re-plan the task'
        },
        { round: 1, role: 'developer', host: 'loop' }
      )
      loop('stop_condition_met', { round: 1, condition: 'escalated' })
      loop('round_ended', {
        round: 1,
        base_head: base,
        head: base,
        files_changed: 0,
        insertions: 0,
        deletions: 0,
        wall_ms: rec.int(60_000, 600_000),
        outcome: 'escalated'
      })
      loop('journal_finalized', {
        rounds: 1,
        total_wall_ms: rec.elapsedMs(),
        time_to_green_ms: null,
        files_changed_total: 0,
        final_head: base,
        result: 'stopped'
      })
    }
  },
  'gate-two-commits': {
    description:
      'The same check on the same input fingerprint at two different commits, failing at the first and passing at the second.',
    issue: 105,
    build(rec) {
      const fingerprint = `fp-${rec.hex(8)}`
      gateRun(rec, 'test', fingerprint, 'fail', rec.sha())
      gateRun(rec, 'test', fingerprint, 'pass', rec.sha())
    }
  },
  'gate-no-commit': {
    description:
      'The same check on the same input fingerprint twice with no commit recorded, passing and then failing.',
    issue: 106,
    build(rec) {
      const fingerprint = `fp-${rec.hex(8)}`
      gateRun(rec, 'lint', fingerprint, 'pass')
      gateRun(rec, 'lint', fingerprint, 'fail')
    }
  },
  'gate-same-commit-twice': {
    description: 'A check that passes at one commit twice, on the same input fingerprint.',
    issue: 107,
    build(rec) {
      const fingerprint = `fp-${rec.hex(8)}`
      const sha = rec.sha()
      gateRun(rec, 'build', fingerprint, 'pass', sha)
      gateRun(rec, 'build', fingerprint, 'pass', sha)
    }
  },
  'usage-and-models': {
    description:
      'Two cumulative and three delta usage observations across two models, one of them with every unit unknown, and a role attempt retried with its usage unknown both times.',
    issue: 108,
    build(rec) {
      usage(rec, 'opus', 'cumulative', { input: 1000, output: 200, cache: 500 })
      usage(rec, 'opus', 'cumulative', { input: 2500, output: 600, cache: 1200 })
      usage(rec, 'sonnet', 'delta', { input: 300, output: 80, cache: 0 })
      usage(rec, 'sonnet', 'delta', { input: 150, output: 40, cache: null })
      usage(rec, 'sonnet', 'delta', { input: null, output: null, cache: null }, 'the vendor reported no usage')
      roleAttempt(rec, 'developer', 'sonnet', 1, 'infrastructure_failed')
      roleAttempt(rec, 'developer', 'sonnet', 2, 'completed')
    }
  },
  'historical-and-hostile-lines': {
    description:
      'Lines a reader meets in an old or damaged store: schema 1, schema 2, a low-trust line from a CLI older than 0.33.0 with no attribution, a current line, a line of a schema version no build knows, a line that fails validation, and one event delivered twice.',
    issue: 109,
    build(rec) {
      const common = { repo: FIXTURE_REPO, doctrine: 'fixture-doctrine-old', host: 'cli' as const }
      const v1: HeaderMetaV1 = {
        schema: 1,
        ts: rec.tick().toISOString(),
        run_id: `run-legacy-${rec.hex(6)}`,
        seq: 0,
        vinaya: '0.24.0',
        machine: rec.hex(64),
        ...common
      }
      rec.push({ meta: v1, subject: { issue: rec.issue, role: 'developer' }, ...operationFields })

      const v2Base: Omit<HeaderMetaV2, 'run_id' | 'ts' | 'machine' | 'event_id' | 'process_id'> = {
        schema: 2,
        seq: 3,
        vinaya: '0.31.0',
        actor_id: 'developer',
        lineage: { run: null, attempt: null, parent: null },
        input_versions: { objectives_version: null, brief_hash: null, ruling_ordinal: null, policy_digest: null },
        provenance: 'env_correlated',
        ...common
      }
      const v2: HeaderMetaV2 = {
        ...v2Base,
        ts: rec.tick().toISOString(),
        run_id: `run-legacy-${rec.hex(6)}`,
        machine: rec.hex(64),
        event_id: `evt-${rec.hex(12)}`,
        process_id: `proc-${rec.hex(8)}`
      }
      rec.push({ meta: v2, subject: { issue: rec.issue, role: 'developer' }, ...operationFields })

      const lowTrust: HeaderMetaV2 = {
        ...v2,
        ts: rec.tick().toISOString(),
        run_id: `run-legacy-${rec.hex(6)}`,
        seq: 0,
        vinaya: LOW_TRUST_VINAYA_VERSION,
        machine: rec.hex(64),
        event_id: `evt-${rec.hex(12)}`,
        process_id: `proc-${rec.hex(8)}`,
        actor_id: null,
        provenance: 'unavailable'
      }
      rec.push({ meta: lowTrust, subject: { issue: null, role: 'unattributed' }, ...operationFields })

      const current = rec.emit(
        {
          kind: 'operation',
          event: 'completed',
          operation: 'authenticate-invocation',
          target: null,
          result: 'ok',
          error_class: null
        },
        { host: 'cli' }
      )

      const future = rec.build(
        {
          kind: 'operation',
          event: 'completed',
          operation: 'authenticate-invocation',
          target: null,
          result: 'ok',
          error_class: null
        },
        { host: 'cli' }
      )
      rec.push({ ...future, meta: { ...(future.meta as object), schema: 9, telepathy: true } }, 'unknown_version')

      const failing = rec.build(
        {
          kind: 'gate',
          event: 'checked',
          check: 'lint',
          check_version: '1',
          policy_version: null,
          input_fingerprint: null,
          outcome: 'bogus'
        },
        { host: 'ci' }
      )
      rec.push(failing, 'invalid')

      rec.pushRaw(JSON.stringify(current), 'valid')
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
