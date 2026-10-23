import { describe, expect, test } from 'bun:test'
import { MemorySaver } from '@langchain/langgraph'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import {
  assessRound,
  buildHeader,
  DevReviewLoopEventSchema,
  HandoffEventSchema,
  initialLoopState,
  RoleAttemptEventSchema,
  type LoopState,
  type Observations
} from '@attalabs/aeg-core'
import { createRunControl, type RunOutcome, type SpawnedProcessLike } from '@atta/executor-agent-spawn'
import { loadProcess } from '../../../harness/dev-process/loader/load-process'
import {
  resumeProcessRun,
  startProcessRun,
  type ActionRegistry,
  type ProcessRunOptions
} from '../../../harness/dev-process/engine-runtime/run-process'
import {
  createLogTranslator,
  recordingActions,
  type LogEventInput,
  type LogTranslator
} from '../../../harness/dev-process/logging/translate'
import { loadRoleGrants, ROLE_NAMES } from '../../../harness/adapters/agents/manifest'
import { ACTION_BINDINGS, createActions, createRoleLaunchers, decisions, type TaskInput } from '../executing/actions'
import { AGENT_STEP_ROLES, createVinayaLogProducers, handoffHaltReason } from '../executing/log-events'
import { LOG_INVENTORY } from '../executing/log-inventory'
import { createHandoff } from '../executing/handoff'
import { recordedHandoff } from './handoff-fakes'

const processFolder = resolve(import.meta.dir, '..')
const loaded = loadProcess(processFolder)
const steps = (parse(readFileSync(loaded.flowPath, 'utf8')) as { steps: { id: string; type: string; role?: string }[] })
  .steps

// ---------------------------------------------------------------------------
// The inventory and its coverage

const loopEventNames = DevReviewLoopEventSchema.options.map((option) => option.shape.event.value as string)
const attemptEventNames = RoleAttemptEventSchema.options.map((option) => option.shape.event.value as string)

function rowsFor(family: string, event: string) {
  return LOG_INVENTORY.filter((row) => row.family === family && row.events.includes(event))
}

describe('the log inventory', () => {
  test('every event the old driver could write has a row', () => {
    const uncovered = [
      ...loopEventNames
        .filter((event) => rowsFor('dev_review_loop', event).length !== 1)
        .map((e) => `dev_review_loop/${e}`),
      ...attemptEventNames
        .filter((event) => rowsFor('role_attempt', event).length !== 1)
        .map((e) => `role_attempt/${e}`),
      ...['raised', 'resolved'].filter((event) => rowsFor('handoff', event).length !== 1).map((e) => `handoff/${e}`)
    ]
    expect(uncovered).toEqual([])
    expect(loopEventNames).toHaveLength(15)
    expect(LOG_INVENTORY).toHaveLength(18)
  })

  test('no row names an event the schemas do not have', () => {
    const known = new Set([
      ...loopEventNames.map((event) => `dev_review_loop/${event}`),
      ...attemptEventNames.map((event) => `role_attempt/${event}`),
      'handoff/raised',
      'handoff/resolved'
    ])
    const named = LOG_INVENTORY.flatMap((row) => row.events.map((event) => `${row.family}/${event}`))
    expect(named.filter((name) => !known.has(name))).toEqual([])
  })

  test('the dropped rows are exactly attempted and unpushed_work_resume, each with a reason', () => {
    const dropped = LOG_INVENTORY.flatMap((row) => (row.status === 'dropped' ? [row] : []))
    expect(dropped.flatMap((row) => row.events).sort()).toEqual(['attempted', 'unpushed_work_resume'])
    for (const row of dropped) expect(row.reason.length).toBeGreaterThan(20)
  })

  test('the deferred row is exactly handoff resolved, with the exact deferral reason', () => {
    const deferred = LOG_INVENTORY.flatMap((row) => (row.status === 'deferred' ? [row] : []))
    expect(deferred).toEqual([
      {
        family: 'handoff',
        events: ['resolved'],
        status: 'deferred',
        reason:
          'deferred: produced once a ruling on a handed-off pause is consumed and the run continues from it; the handoff only raises the pause'
      }
    ])
  })

  test('the handoff rows and the infrastructure-retry row are produced by the handoff function', () => {
    const produced = (family: string, event: string) =>
      rowsFor(family, event).map((row) => (row.status === 'produced' ? row.from : row.status))
    expect(produced('handoff', 'raised')).toEqual([expect.stringMatching(/^the handoff function/)])
    expect(produced('dev_review_loop', 'infrastructure_retry')).toEqual([
      expect.stringMatching(/^the handoff function/)
    ])
  })
})

// ---------------------------------------------------------------------------
// Running the Flow with stubs

const config = {
  loopId: 'loop-test',
  task: 1570,
  reviewers: ['code-reviewer', 'security'],
  models: {},
  maxRounds: 3,
  maxTaskMinutes: 0
}

const stats = (round: number) => ({
  baseHead: `base-${round}`,
  head: `head-${round}`,
  filesChanged: 2,
  insertions: 10,
  deletions: 1,
  wallMs: 1000
})

const finding = { id: 'F1', severity: 'major', state: 'open' as const, description: 'a blocking problem' }
const verdicts = (approve: boolean): Observations => ({
  kind: 'verdicts',
  round: 0,
  verdicts: [
    {
      role: 'reviewer',
      verdict: approve ? 'APPROVE' : 'REQUEST CHANGES',
      objectives: [{ id: 'O1', met: approve }],
      findings: approve ? [] : [finding]
    },
    { role: 'security', verdict: 'PASS', objectives: [], findings: [] }
  ]
})

/** What the assess-round step reports for one pass, produced by the real assessment over a loop state that carries from pass to pass. */
function assessments(passes: boolean[]): Array<{ exitCode: number; stdout: string }> {
  let state: LoopState = initialLoopState(config)
  return passes.map((approve, index) => {
    const round = index + 1
    const observed: Observations[] = [
      {
        kind: 'gate',
        round,
        green: true,
        stats: stats(round),
        ...(round > 1 ? { confidence: { value: 90 } } : {})
      },
      { ...verdicts(approve), round } as Observations
    ]
    const events: unknown[] = []
    let decision = { type: 'publish' } as { type: string }
    for (const observation of observed) {
      const assessment = assessRound(state, observation)
      state = assessment.state
      events.push(...assessment.events)
      decision = assessment.decision
    }
    return { exitCode: decision.type === 'publish' ? 0 : 1, stdout: JSON.stringify({ decision, events }) }
  })
}

interface Scenario {
  gates?: number[]
  /** What each pass of the assess-round step reports. */
  assess?: Array<{ exitCode: number; stdout: string }>
  onAction?: (step: string) => void
}

function fakeAgent(): SpawnedProcessLike {
  const closeListeners: Array<(code: number | null) => void> = []
  let stdout: ((chunk: string) => void) | undefined
  return {
    stdin: {
      write: () => {},
      end: () => {
        setTimeout(() => {
          stdout?.('{"type":"result"}\n')
          for (const listener of closeListeners) listener(0)
        }, 0)
      }
    },
    stdout: {
      on: (_event, listener) => {
        stdout = listener as (chunk: string) => void
      }
    },
    stderr: { on: () => {} },
    on: ((event: string, listener: (code: number | null) => void) => {
      if (event === 'close') closeListeners.push(listener)
    }) as SpawnedProcessLike['on'],
    kill: () => {
      for (const listener of closeListeners) listener(null)
    }
  }
}

/** The envelope every test event is completed with before it is checked against its schema. */
function envelope(seq: number) {
  return buildHeader({
    now: new Date('2026-01-01T00:00:00.000Z'),
    runId: 'run-test',
    seq,
    repo: 'attalabs/vinaya',
    vinaya: '0.0.0',
    doctrine: 'test',
    host: 'loop',
    hostname: 'test-host',
    env: {},
    eventId: `event-${seq}`,
    processId: 'process-test',
    branchIssue: 1570
  })
}

/** The live-check step's result for an approved head: the assessment's events, the journal's close held for the publish step. */
function approvedLive(results: Readonly<Record<string, unknown>>) {
  const assessed = JSON.parse((results['assess-round'] as { stdout?: string } | undefined)?.stdout ?? '{}') as {
    events: { event: string }[]
  }
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      outcome: 'publish',
      events: assessed.events.filter((e) => e.event !== 'journal_finalized'),
      deferred: assessed.events.filter((e) => e.event === 'journal_finalized'),
      from: 0
    })
  }
}

function setup(scenario: Scenario = {}) {
  const gates = [...(scenario.gates ?? [0])]
  const assess = [...(scenario.assess ?? assessments([true]))]
  const next = <T>(queue: T[]): T => (queue.length > 1 ? (queue.shift() as T) : (queue[0] as T))

  const real = createActions({} as TaskInput)
  const stubs: ActionRegistry = Object.fromEntries(
    Object.keys(ACTION_BINDINGS).map((name) => [
      name,
      async (context) => {
        scenario.onAction?.(context.nodeId)
        if (name === 'harness.run-gates') return { exitCode: next(gates) }
        if (name === 'vinaya.assess-round') return next(assess)
        if (name === 'vinaya.run-live-checks') return approvedLive(context.results)
        if (name === 'harness.publish') {
          const live = JSON.parse(
            (context.results['run-live-checks'] as { stdout?: string } | undefined)?.stdout ?? '{}'
          )
          return { exitCode: 0, stdout: JSON.stringify({ events: live.deferred ?? [] }) }
        }
        if (name === 'vinaya.classify-gate-result' || name === 'vinaya.dispatch-reviewers') {
          return (real[name] as NonNullable<ActionRegistry[string]>)(context)
        }
        return { exitCode: 0 }
      }
    ])
  )

  const startSlices: LogEventInput[][] = []
  const emitted: Array<{ event: LogEventInput; enveloped: Record<string, unknown> }> = []
  const translator: LogTranslator = createLogTranslator(createVinayaLogProducers(config), (event) =>
    emitted.push({ event, enveloped: { ...event, ...envelope(emitted.length) } })
  )

  const roles = createRoleLaunchers({ vendor: 'claude-code', generatedRoot: mkdtempSync(`${tmpdir()}/log-roles-`) })
  // The role launcher stubs are plain spawn stubs: nothing here hands them the emit function.
  const spawnFn: ProcessRunOptions['spawnFn'] = () => fakeAgent()
  const options: ProcessRunOptions = {
    process: loaded,
    question: 'the task',
    bindings: { actions: recordingActions(stubs, translator), decisions, roles },
    checkpointer: new MemorySaver(),
    workingDirectoryRoot: mkdtempSync(`${tmpdir()}/log-root-`),
    spawnFn,
    onEvent: (event) => {
      const before = translator.produced.length
      translator.onEvent(event)
      if (event.type === 'node:start') startSlices.push(translator.produced.slice(before) as LogEventInput[])
    }
  }
  return { options, translator, emitted, startSlices }
}

async function runLeg(
  translator: LogTranslator,
  leg: () => Promise<RunOutcome>,
  start: { resumed: boolean },
  cancelled = false
): Promise<RunOutcome> {
  translator.beginLeg(start)
  const outcome = await leg()
  translator.endLeg(
    {
      reason: outcome.reason,
      ...(outcome.reason === 'failed' ? { error: outcome.error } : {}),
      ...('checkpoint' in outcome && outcome.checkpoint ? { checkpoint: outcome.checkpoint } : {})
    },
    { cancelled }
  )
  return outcome
}

/** Every `family/event` a producer wrote in this file's tests. */
const seen = new Set<string>()
const note = (events: LogEventInput[] | undefined) => {
  for (const event of events ?? []) seen.add(`${event.kind}/${event.event}`)
}

function schemaFor(kind: unknown) {
  if (kind === 'dev_review_loop') return DevReviewLoopEventSchema
  if (kind === 'role_attempt') return RoleAttemptEventSchema
  if (kind === 'handoff') return HandoffEventSchema
  throw new Error(`The Engine path emitted an event of the unexpected family ${String(kind)}`)
}

/** Asserts the emitted list is the translator's output and that every event parses against its family's schema. */
function expectValid(run: ReturnType<typeof setup>): string[] {
  expect(run.emitted.map((entry) => entry.event)).toEqual([...run.translator.produced])
  for (const { enveloped } of run.emitted) {
    const parsed = schemaFor(enveloped.kind).safeParse(enveloped)
    if (!parsed.success) throw new Error(`${String(enveloped.event)} does not parse: ${parsed.error.message}`)
  }
  note(run.translator.produced as LogEventInput[])
  return run.emitted.map((entry) => String(entry.event.event))
}

const heartbeat = 'driver_heartbeat'
const attempted = 'attempted'
const exited = 'driver_exited'
// A round's assessment, as the assess-round step records it.
const assessedRound = [
  'round_started',
  'gate_result_read',
  'verdicts_read',
  'findings_compared',
  'stop_condition_met',
  'round_ended',
  'journal_finalized'
]

describe('the Engine path writes the review loop events from the run', () => {
  test('green run', async () => {
    const run = setup()
    const outcome = await runLeg(run.translator, () => startProcessRun(run.options), { resumed: false })
    expect(outcome.reason).toBe('completed')
    // No node writes a heartbeat or an attempt, and the exit record is the runner's, written once after the leg.
    expect(expectValid(run)).toEqual(['loop_started', ...assessedRound])
  })

  test('one revision loop-back', async () => {
    const run = setup({ assess: assessments([false, true]) })
    const outcome = await runLeg(run.translator, () => startProcessRun(run.options), { resumed: false })
    expect(outcome.reason).toBe('completed')
    const names = expectValid(run)
    expect(names).toEqual([
      'loop_started',
      'round_started',
      'gate_result_read',
      'verdicts_read',
      'findings_compared',
      'round_ended',
      // round two
      ...assessedRound
    ])
    const secondRound = run.emitted.filter((entry) => entry.event.event === 'round_started').at(-1)
    expect(secondRound?.event.round).toBe(2)
  })

  test('a halt, then a resume', async () => {
    const control = createRunControl()
    const run = setup({
      onAction: (step) => {
        if (step === 'validate-developer-output') control.halt('stop here')
      }
    })
    run.options.control = control
    const paused = await runLeg(run.translator, () => startProcessRun(run.options), { resumed: false })
    expect(paused.reason).toBe('paused')
    const resumed = await runLeg(
      run.translator,
      () => resumeProcessRun({ ...run.options, control: undefined }, paused.identity),
      { resumed: true }
    )
    expect(resumed.reason).toBe('completed')
    const pausedEvent = run.emitted.find((entry) => entry.event.event === 'paused')?.event
    expect(pausedEvent).toMatchObject({ reason: 'principal_item', reason_code: 'halt', round: 1 })
    const resumedEvent = run.emitted.find((entry) => entry.event.event === 'resumed')?.event
    expect(resumedEvent).toMatchObject({ by: 'principal', round: 1 })
    expect(expectValid(run)).toEqual(['paused', 'resumed', 'loop_started', ...assessedRound])
  })

  test('gates that exhaust the revision ceiling', async () => {
    const run = setup({ gates: [1] })
    const outcome = await runLeg(run.translator, () => startProcessRun(run.options), { resumed: false })
    expect(outcome.reason).toBe('exhausted')
    expect(expectValid(run)).toEqual(['stop_condition_met', 'paused'])
  })

  test('no node start writes a heartbeat and no agent step writes an attempt', async () => {
    const run = setup({ assess: assessments([false, true]) })
    await runLeg(run.translator, () => startProcessRun(run.options), { resumed: false })
    expect(run.startSlices.length).toBeGreaterThan(0)
    for (const slice of run.startSlices) expect(slice).toEqual([])
    const names = run.emitted.map((entry) => String(entry.event.event))
    expect(names).not.toContain(heartbeat)
    expect(names).not.toContain(attempted)
    expect(names).not.toContain(exited)
  })

  test('the role launchers are handed no emit function, and no role may write to the Log', () => {
    const roles = createRoleLaunchers({ vendor: 'claude-code', generatedRoot: mkdtempSync(`${tmpdir()}/log-roles-`) })
    for (const launcher of Object.values(roles)) {
      expect(Object.keys(launcher).sort()).toEqual(['allowedPermissions', 'buildArgs', 'command', 'env'])
    }
    for (const role of ROLE_NAMES) {
      const grants = loadRoleGrants(resolve(import.meta.dir, '..', 'executing', role, 'grants.yaml'))
      const allowed = [
        ...Object.entries(grants.tools.claude).flatMap(([tool, decision]) => (decision === 'allow' ? [tool] : [])),
        ...Object.entries(grants.tools.codex).flatMap(([tool, decision]) => (decision === 'allow' ? [tool] : [])),
        ...Object.entries(grants.tools.mcp).flatMap(([server, tools]) => [server, ...tools]),
        ...grants.shell.allow
      ]
      // `git log` reads history; a Log writer is any other grant that names the Log.
      expect(allowed.filter((name) => /\blog\b/i.test(name.replace(/\bgit log\b/g, '')))).toEqual([])
    }
  })
})

describe('the producers cover every end a run can come to', () => {
  const producers = () => createVinayaLogProducers(config)
  const names = (events: LogEventInput[] | undefined) => {
    note(events)
    return (events ?? []).map((event) => String(event.event))
  }

  test('a cancelled leg writes cancelled, and its exit is by signal', () => {
    const context = { outcome: { reason: 'failed', error: 'x' }, cancelled: true, steps: {} } as const
    const run = producers()
    expect(names(run.runEnded?.(context))).toEqual(['cancelled'])
    expect(run.exit(context)).toEqual({ reason: 'signal', lastDecision: 'cancel' })
  })

  test('a crash writes paused, never a round_ended, and its exit is by error', () => {
    const context = { outcome: { reason: 'failed', error: 'x' }, cancelled: false, steps: {} } as const
    const run = producers()
    const ends = run.runEnded?.(context)
    expect(names(ends)).toEqual(['paused'])
    expect(ends?.[0]?.reason_code).toBe('infrastructure')
    expect(run.exit(context)).toEqual({ reason: 'error', lastDecision: 'error', exitCode: 1, failedStep: true })
  })

  test('a crash after a real round end closes the journal from that round and writes no second round_ended', () => {
    const [pass] = assessments([false])
    const run = producers()
    const recorded = { 'assess-round': { exitCode: 1, stdout: pass?.stdout ?? '', stderr: '' } }
    const fromAssessment = names(
      run.nodeCompleted?.({ nodeId: 'assess-round', runId: 'r', attempt: 1, steps: recorded })
    )
    expect(fromAssessment.filter((name) => name === 'round_ended')).toHaveLength(1)
    const ends = names(run.runEnded?.({ outcome: { reason: 'failed', error: 'x' }, cancelled: false, steps: recorded }))
    expect(ends).toEqual(['paused', 'journal_finalized'])
  })

  test('a decided pause is not written a second time when its run fails', () => {
    const run = producers()
    const pause = JSON.stringify({
      decision: { type: 'pause', reason: 'confidence' },
      events: [{ kind: 'dev_review_loop', loop_id: 'loop-test', event: 'paused', payload: {} }]
    })
    const recorded = { 'assess-round': { exitCode: 1, stdout: pause, stderr: '' } }
    expect(
      names(run.nodeFailed?.({ nodeId: 'assess-round', runId: 'r', attempt: 1, steps: recorded, error: 'x' }))
    ).toEqual(['paused'])
    const context = { outcome: { reason: 'failed', error: 'x' }, cancelled: false, steps: recorded } as const
    expect(names(run.runEnded?.(context))).toEqual([])
    expect(run.exit(context)).toEqual({ reason: 'paused', lastDecision: 'pause(confidence)' })
  })

  test('a leg a handoff halted for an error ends on that pause reason', () => {
    const run = producers()
    const crashed = {
      outcome: { reason: 'paused', haltReason: handoffHaltReason('infrastructure') },
      cancelled: false,
      steps: {}
    } as const
    expect(names(run.runEnded?.(crashed))).toEqual(['paused'])
    expect(run.exit(crashed)).toEqual({ reason: 'paused', lastDecision: 'pause(infrastructure)' })
    const halted = { outcome: { reason: 'paused', haltReason: 'stop here' }, cancelled: false, steps: {} } as const
    expect(run.exit(halted)).toEqual({ reason: 'paused', lastDecision: 'pause(halt)' })
  })

  test('a decided pause the handoff halted is not written a second time', () => {
    const run = producers()
    const pause = JSON.stringify({
      decision: { type: 'pause', reason: 'escalation' },
      events: [{ kind: 'dev_review_loop', loop_id: 'loop-test', event: 'paused', payload: {} }]
    })
    const recorded = { 'assess-round': { exitCode: 1, stdout: pause, stderr: '' } }
    expect(names(run.nodeCompleted?.({ nodeId: 'assess-round', runId: 'r', attempt: 1, steps: recorded }))).toEqual([
      'paused'
    ])
    const context = {
      outcome: { reason: 'paused', haltReason: handoffHaltReason('escalation') },
      cancelled: false,
      steps: recorded
    } as const
    expect(names(run.runEnded?.(context))).toEqual([])
    expect(run.exit(context)).toEqual({ reason: 'paused', lastDecision: 'pause(escalation)' })
  })

  test('each way a leg ends names its exit', () => {
    const run = producers()
    const exit = (reason: 'completed' | 'paused' | 'exhausted') =>
      run.exit({ outcome: { reason }, cancelled: false, steps: {} })
    expect(exit('completed')).toEqual({ reason: 'finished', lastDecision: 'publish', exitCode: 0 })
    expect(exit('paused')).toEqual({ reason: 'paused', lastDecision: 'pause(halt)' })
    expect(exit('exhausted')).toEqual({ reason: 'paused', lastDecision: 'pause(max_rounds)' })
  })

  test('an agent step that fails writes no attempt', () => {
    const events = producers().nodeFailed?.({ nodeId: 'develop', runId: 'r', attempt: 2, steps: {}, error: 'x' })
    expect(events).toEqual([])
  })

  test('an unreadable assessment result produces nothing', () => {
    const recorded = { 'assess-round': { exitCode: 1, stdout: '{"decision":', stderr: '' } }
    expect(producers().nodeCompleted?.({ nodeId: 'assess-round', runId: 'r', attempt: 1, steps: recorded })).toEqual([])
  })

  test('the agent steps are the Flow agent steps', () => {
    const flowAgents: Record<string, string> = Object.fromEntries(
      steps.flatMap((step) => (step.type === 'agent' && step.role ? [[step.id, step.role]] : []))
    )
    expect(AGENT_STEP_ROLES).toEqual(flowAgents)
  })
})

describe('the handoff writes its rows', () => {
  test('one raised for the escalation record and one infrastructure_retry for a pause comment that took several attempts', () => {
    const recorded = recordedHandoff()
    const events: Array<Record<string, unknown>> = []
    // The real escalation writer logs one raised event once its records are written; the stand-in does the same.
    const deps = {
      ...recorded.deps,
      writeEscalationRecord: (facts: Parameters<typeof recorded.deps.writeEscalationRecord>[0]) => {
        const record = recorded.deps.writeEscalationRecord(facts)
        events.push({
          kind: 'handoff',
          event: 'raised',
          payload: {},
          class: 'authority',
          reason: facts.reason,
          requested_decision: facts.detail ?? null
        })
        return record
      },
      log: (event: unknown) => void events.push(event as Record<string, unknown>)
    }
    recorded.postResult = { attempts: 3, posted: true }
    const runtimeDir = mkdtempSync(`${tmpdir()}/handoff-log-`)
    createHandoff(
      {
        task: 1570,
        branch: 'task/issue-1570',
        runtimeDir,
        runId: 'r',
        agent: 'claude',
        round: () => 1,
        head: () => 'h',
        prNumber: () => 70,
        versions: () => ({ briefHash: null, objectivesVersion: null, rulingOrdinal: 0, policyDigest: 'p' }),
        halt: () => {}
      },
      config.loopId,
      deps
    ).pause({ reason: 'escalation', detail: 'needs a call' })
    expect(events.map((event) => `${event.kind}/${event.event}`)).toEqual([
      'handoff/raised',
      'dev_review_loop/infrastructure_retry'
    ])
    for (const [seq, event] of events.entries()) {
      const parsed = schemaFor(event.kind).safeParse({ ...event, ...envelope(seq) })
      if (!parsed.success) throw new Error(`${String(event.event)} does not parse: ${parsed.error.message}`)
      seen.add(`${event.kind}/${event.event}`)
    }
  })
})

describe('every produced row has a producer that wrote it', () => {
  test('each event a produced row names was written by a run or a producer above', () => {
    // The runner writes the heartbeat and the exit record; its own suite runs them.
    const missing = LOG_INVENTORY.flatMap((row) =>
      row.status === 'produced' && !row.from.startsWith('the runner')
        ? row.events.map((event) => `${row.family}/${event}`)
        : []
    ).filter((name) => !seen.has(name))
    expect(missing).toEqual([])
  })
})
