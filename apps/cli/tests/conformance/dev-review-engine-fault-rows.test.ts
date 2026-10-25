import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { runDirectory, type Agent, type RunTrace } from '../../../../processes/vinaya/bin/run-engine.js'
import { engineEvidenceOf } from '../../src/lib/dev-review-eval/exit-check.js'
import { loadRegistry } from '../../src/lib/dev-review-eval/registry.js'
import {
  isAutomaticRecoveryPause,
  isHostRepairPause,
  readEscalationRecord,
  readPauseState,
  type PauseState
} from '../../src/lib/dev-review-loop/pause-resume.js'
import { MAX_INFRASTRUCTURE_RETRIES } from '../../src/lib/dev-review-loop/round-assess.js'
import type { LogSinkDeps } from '../../src/lib/log-sink.js'
import { taskEscalationReadHandler } from '../../src/lib/task-tools/handlers.js'
import { readEscalationPacket, readTaskLoopStateObserved } from '../../src/lib/task-tools/read.js'
import type { Observation } from './dev-review-current-loop-adapter.js'
import {
  CONTROLLER_SECRETS,
  ENGINE_SCENARIO_DRIVERS,
  FAULT_IDS,
  MALFORMED_STREAM_LINES,
  PROMPTS_FILE,
  PROVIDER_TIMEOUT_MS,
  REASONING_CANARY,
  runEngineScenario,
  SOURCE_READS_FILE,
  STALE_HEAD,
  type EngineScenarioRun
} from './dev-review-engine-loop-adapter.js'
import corpus from '../fixtures/dev-review-engine-scenarios.json'
import engineFailures from '../fixtures/dev-review-engine-expected-failures.json'

/**
 * Engine-backend evidence for the fault-and-attack rows outside the isolation-and-security, run-control-and-effects
 * and shadow-mode groups and outside the Operator-owned rows.
 *
 * Each row runs on the real Engine Flow and actions through the corpus adapter, once with the Claude stub and once
 * with the Codex stub. A row maps to a corpus scenario's Engine run where one produces its fault; otherwise the run
 * is one of the adapter's fault runs, which change only the faked external input the fault names. Every run is
 * classified against the row's declared expected outcome; both vendors must classify every row identically, and no
 * run of these rows may carry an Engine expected-failure entry.
 *
 * The evidence runs at L7 scripted, through the Engine Flow with stub vendor processes (L3 for the Flow, stubs for
 * the vendor CLIs). Each row records that layer below; the rows the spec also places at L4 keep their live-CLI half
 * to the live adapter-conformance suites, which this file does not stand in for.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const THIS_TEST = 'apps/cli/tests/conformance/dev-review-engine-fault-rows.test.ts'
const AGENTS: readonly Agent[] = ['claude', 'codex']
const LAYER = 'L7 scripted: the Engine Flow (L3) with stub vendor processes'

interface Inspection {
  trace: RunTrace | null
  pause: PauseState | null
  events: string
  prompts: { role: string; prompt: string }[]
  sourceReads: Record<string, unknown>[]
  /** The pinned source's content on the default branch once the run ended. */
  sourceOnMain: string | null
  operatorReads: OperatorReads | null
}

interface OperatorReads {
  before: Record<string, string>
  after: Record<string, string>
  escalationRead: unknown
  mutatingInput: unknown
  packetPresent: boolean
  loopState: unknown
  /** The pause is still held, and its escalation record still there to be resolved. */
  pauseHeld: boolean
}

interface Run {
  key: string
  agent: Agent
  observation: Observation
  inspection: Inspection
  ms: number
  /** Warnings the shared Log sink wrote, for a run given a sink of its own. */
  warnings: string[]
}

/** A run the rows read: a corpus scenario or an adapter fault, optionally through a sink of its own. */
interface RunSpec {
  key: string
  scenario: string
  sink?: 'recording' | 'failing'
  operatorReads?: boolean
}

const RUN_SPECS: RunSpec[] = [
  ...FAULT_IDS.map((id) => ({
    key: id,
    scenario: id,
    ...(id === 'controller-secret' ? { sink: 'recording' as const } : {})
  })),
  ...[
    'clean-completion',
    'provider-failure',
    'required-source-failure',
    'reviewer-invalidity',
    'developer-failure',
    'mechanical-failure-repeats',
    'mechanical-failure-recovers',
    'bounded-exhaustion',
    'context-pressure'
  ].map((id) => ({ key: id, scenario: id })),
  { key: 'log-destination-failure', scenario: 'clean-completion', sink: 'failing' },
  { key: 'operator-read', scenario: 'human-pause', operatorReads: true }
]

const lines = (text: string): Record<string, unknown>[] =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
const readText = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '')

/** Every file under `dir`, by relative path, with its content's digest. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) out[relative(dir, path)] = createHash('sha256').update(readFileSync(path)).digest('hex')
    }
  }
  walk(dir)
  return out
}

/** The Operator's reads of a paused run, through its read tool and the read interface behind it. */
function operatorReads(run: EngineScenarioRun): OperatorReads {
  const before = snapshot(run.runtimeDir)
  const escalationRead = taskEscalationReadHandler({ task: { issue: run.task } })
  // A read handed fields that name a decision: the read tool's input carries no such field, and it changes nothing.
  const mutatingInput = taskEscalationReadHandler({
    task: { issue: run.task },
    decision: 'cancel',
    resolve: true,
    phase: 'publish'
  })
  const packetPresent = readEscalationPacket(run.runtimeDir, run.task) !== null
  const loopState = readTaskLoopStateObserved(run.runtimeDir, run.task).value
  const pause = readPauseState(run.runtimeDir, run.task)
  const record = pause?.escalationId === undefined ? null : readEscalationRecord(run.task, pause.escalationId)
  const after = snapshot(run.runtimeDir)
  return {
    before,
    after,
    escalationRead,
    mutatingInput,
    packetPresent,
    loopState,
    pauseHeld: pause !== null && record !== null
  }
}

function inspect(spec: RunSpec, run: EngineScenarioRun, into: { value: Inspection | null }): void {
  const tracePath = join(runDirectory(run.runtimeDir, run.task), 'trace.json')
  const repo = join(dirname(run.runtimeDir), 'repo')
  let sourceOnMain: string | null = null
  if (spec.scenario === 'source-mutation')
    sourceOnMain = execFileSync('git', ['show', 'refs/remotes/origin/main:sample.ts'], { cwd: repo, encoding: 'utf8' })
  into.value = {
    trace: existsSync(tracePath) ? (JSON.parse(readFileSync(tracePath, 'utf8')) as RunTrace) : null,
    pause: readPauseState(run.runtimeDir, run.task),
    events: readText(join(run.runtimeDir, 'events.jsonl')),
    prompts: lines(readText(join(run.runtimeDir, PROMPTS_FILE))) as { role: string; prompt: string }[],
    sourceReads: lines(readText(join(run.runtimeDir, SOURCE_READS_FILE))),
    sourceOnMain,
    operatorReads: spec.operatorReads ? operatorReads(run) : null
  }
}

const runs: Run[] = []
let scratch = ''

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'engine-fault-rows-'))
  for (const spec of RUN_SPECS) {
    for (const agent of AGENTS) {
      const warnings: string[] = []
      let sink: Partial<LogSinkDeps> | undefined
      if (spec.sink === 'recording') {
        const folder = { kind: 'folder' as const, folder: join(scratch, `${spec.key}-${agent}-logs`) }
        sink = { resolveLogDestination: () => folder, unresolvedLogDestination: () => folder }
      } else if (spec.sink === 'failing') {
        // The destination's parent is a plain file: no Log line can be written there.
        const blocker = join(scratch, `${spec.key}-${agent}-blocker`)
        writeFileSync(blocker, 'not a directory\n')
        const folder = { kind: 'folder' as const, folder: join(blocker, 'logs') }
        sink = {
          resolveLogDestination: () => folder,
          unresolvedLogDestination: () => folder,
          stderr: (message: string) => warnings.push(message)
        }
      }
      const inspection: { value: Inspection | null } = { value: null }
      const started = Date.now()
      const observation = await runEngineScenario(spec.scenario, agent, sink, (run) => inspect(spec, run, inspection))
      runs.push({
        key: spec.key,
        agent,
        observation,
        inspection: inspection.value as Inspection,
        ms: Date.now() - started,
        warnings
      })
    }
  }
}, 600_000)

afterAll(() => {
  if (scratch !== '') rmSync(scratch, { recursive: true, force: true })
})

const runOf = (key: string, agent: Agent): Run => {
  const run = runs.find((candidate) => candidate.key === key && candidate.agent === agent)
  if (run === undefined) throw new Error(`no run ${key} on ${agent}`)
  return run
}

// --- the checks every row is classified by ------------------------------------------------------------------------

type Check = string | null
const check = (holds: boolean, failure: string): Check => (holds ? null : failure)

type CorpusExpectation = {
  decision: string
  durable?: Record<string, unknown>
  effects?: Record<string, unknown> & { markersInclude?: string[]; markersExclude?: string[] }
  events?: { include?: string[]; exclude?: string[] }
}
const corpusScenarios = (corpus as { scenarios: { id: string; expect: CorpusExpectation }[] }).scenarios

/** Every way a corpus scenario's Engine run misses that scenario's portable expectation. */
function corpusExpectation(key: string, obs: Observation): Check[] {
  const expectation = corpusScenarios.find((scenario) => scenario.id === key)?.expect
  if (expectation === undefined) return [`${key} is not a corpus scenario`]
  const out: Check[] = [check(obs.decision === expectation.decision, `${key}: decision ${obs.decision}`)]
  for (const [field, want] of Object.entries(expectation.durable ?? {}))
    out.push(
      check(
        JSON.stringify(obs.durable[field as keyof Observation['durable']]) === JSON.stringify(want),
        `${key}: durable.${field}`
      )
    )
  const { markersInclude, markersExclude, ...counts } = expectation.effects ?? {}
  for (const [field, want] of Object.entries(counts))
    out.push(
      check(
        JSON.stringify(obs.effects[field as keyof Observation['effects']]) === JSON.stringify(want),
        `${key}: effects.${field}`
      )
    )
  for (const marker of markersInclude ?? [])
    out.push(check(obs.effects.markers.includes(marker), `${key}: no ${marker}`))
  for (const marker of markersExclude ?? []) out.push(check(!obs.effects.markers.includes(marker), `${key}: ${marker}`))
  for (const event of expectation.events?.include ?? [])
    out.push(check(obs.events.includes(event), `${key}: no ${event}`))
  for (const event of expectation.events?.exclude ?? [])
    out.push(check(!obs.events.includes(event), `${key}: ${event}`))
  return out
}

const VERDICT_MARKERS = ['reviewer-verdict', 'security-verdict', 'summary']
/** The run neither published nor posted a verdict: never an approval. */
const neverApproved = (run: Run): Check[] => [
  check(run.observation.effects.publishedRounds.length === 0, `${run.key}: published`),
  ...VERDICT_MARKERS.map((marker) =>
    check(!run.observation.effects.markers.includes(marker), `${run.key}: posted ${marker}`)
  )
]
/** The run paused for automatic recovery, inside the infrastructure retry bound. */
const automaticRecoveryWithinBound = (run: Run): Check[] => [
  check(run.observation.decision === 'pause:infrastructure', `${run.key}: decision ${run.observation.decision}`),
  check(isAutomaticRecoveryPause('infrastructure'), 'infrastructure is not an automatic-recovery pause'),
  check(
    (run.observation.durable.infrastructureRetries ?? Number.POSITIVE_INFINITY) < MAX_INFRASTRUCTURE_RETRIES,
    `${run.key}: infrastructure retries ${run.observation.durable.infrastructureRetries} not under ${MAX_INFRASTRUCTURE_RETRIES}`
  )
]
const developSteps = (run: Run) => (run.inspection.trace?.steps ?? []).filter((step) => step.nodeId === 'develop')
const pauseDetail = (run: Run) => run.inspection.pause?.detail ?? ''

interface FaultRow {
  id: string
  /** The corpus scenarios or adapter fault runs that produce the row's fault. */
  runs: string[]
  /** The layer the evidence runs at. */
  layer: string
  /** Every way the row's runs on one vendor miss the row's declared expected outcome. */
  classify: (agent: Agent) => Check[]
}

const FAULT_ROWS: FaultRow[] = [
  {
    id: 'fault-attack:01-developer-process-death',
    runs: ['developer-process-death'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('developer-process-death', agent)
      const steps = developSteps(run)
      return [
        // Typed developer failure: the killed turn's step ends with no exit status; the bounded retry runs once.
        check(steps.length === 2, `develop ran ${steps.length} times`),
        check(steps[0]?.exitCode !== 0, 'the killed turn reported success'),
        check(steps[1]?.exitCode === 0, 'the retried turn did not succeed'),
        check(run.observation.effects.developerDispatches === 2, 'not one retry'),
        // No duplicate effect: the round publishes once.
        check(JSON.stringify(run.observation.effects.publishedRounds) === '[1]', 'not one publication'),
        check(run.observation.effects.markers.filter((m) => m === 'summary').length === 1, 'duplicate summary')
      ]
    }
  },
  {
    id: 'fault-attack:02-reviewer-process-death',
    runs: ['reviewer-process-death'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('reviewer-process-death', agent)
      return [
        check(run.observation.effects.securityDispatches === 2, 'not the single reviewer retry'),
        check(/no review \(missing\)/.test(pauseDetail(run)), `pause detail: ${pauseDetail(run)}`),
        ...neverApproved(run)
      ]
    }
  },
  {
    id: 'fault-attack:04-stream-truncation',
    runs: ['stream-truncation'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('stream-truncation', agent)
      return [
        check(/non-JSON output on line \d+ of its structured stream/.test(run.observation.refusal ?? ''), 'untyped'),
        check(run.observation.effects.codeReviewerDispatches === 0, 'a reviewer judged the truncated turn'),
        ...automaticRecoveryWithinBound(run),
        ...neverApproved(run)
      ]
    }
  },
  {
    id: 'fault-attack:05-malformed-stream-lines-ndjson',
    runs: ['malformed-stream-lines'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('malformed-stream-lines', agent)
      return [
        check(/non-JSON output on line \d+ of its structured stream/.test(run.observation.refusal ?? ''), 'untyped'),
        // Never crosses the adapter boundary: no event, and no reviewer prompt, carries a malformed line.
        ...MALFORMED_STREAM_LINES.map((line) =>
          check(!run.inspection.events.includes(line.slice(0, 20)), `an event carries ${line}`)
        ),
        check(run.observation.effects.codeReviewerDispatches === 0, 'a reviewer judged the malformed turn'),
        ...automaticRecoveryWithinBound(run),
        ...neverApproved(run)
      ]
    }
  },
  {
    id: 'fault-attack:06-provider-timeout',
    runs: ['provider-timeout'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('provider-timeout', agent)
      const dispatches = run.observation.effects.developerDispatches
      return [
        check(dispatches === 2, `developer dispatched ${dispatches} times`),
        // Within bound: each dispatch ends at its ceiling, not when the stub would.
        check(run.ms < PROVIDER_TIMEOUT_MS * dispatches + 15_000, `took ${run.ms}ms`),
        ...automaticRecoveryWithinBound(run),
        ...neverApproved(run)
      ]
    }
  },
  {
    id: 'fault-attack:15-stale-head',
    runs: ['stale-head'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('stale-head', agent)
      return [
        check(pauseDetail(run).includes('no review'), `pause detail: ${pauseDetail(run)}`),
        check(!run.inspection.events.includes(`"head":"${STALE_HEAD}"`), 'a stale verdict was read as the round’s'),
        ...neverApproved(run)
      ]
    }
  },
  {
    id: 'fault-attack:16-source-mutation',
    runs: ['source-mutation'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('source-mutation', agent)
      const developer = run.inspection.sourceReads.find((read) => read.role === 'developer') as
        | { evidence: { ref: string; version: string }[] }
        | undefined
      const pinned = developer?.evidence.find((entry) => entry.ref === 'source:sample.ts')?.version
      const reviewerReads = run.inspection.sourceReads.filter((read) => read.role !== 'developer') as {
        role: string
        read: { ok: boolean; result?: { digest: string; content: string } } | null
      }[]
      return [
        check(run.inspection.sourceOnMain === 'export const value = 2\n', 'the source never moved'),
        check(
          pinned === `sha256:${createHash('sha256').update('export const value = 1\n').digest('hex')}`,
          'not pinned'
        ),
        check(reviewerReads.length === 2, `${reviewerReads.length} reviewer reads`),
        ...reviewerReads.map((read) =>
          check(
            read.read?.ok === true &&
              read.read.result?.digest === pinned &&
              read.read.result?.content === 'export const value = 1\n',
            `${read.role} resolved another digest`
          )
        ),
        check(run.observation.decision === 'publish', `decision ${run.observation.decision}`)
      ]
    }
  },
  {
    id: 'fault-attack:17-log-destination-failure',
    runs: ['log-destination-failure', 'clean-completion'],
    layer: LAYER,
    classify: (agent) => {
      const failed = runOf('log-destination-failure', agent)
      const clean = runOf('clean-completion', agent)
      return [
        // Decision unchanged.
        check(failed.observation.decision === clean.observation.decision, `decision ${failed.observation.decision}`),
        check(
          JSON.stringify(failed.observation.effects) === JSON.stringify(clean.observation.effects),
          'the effects changed'
        ),
        // A bounded warning: at least one, never one per event.
        check(failed.warnings.length >= 1, 'no warning'),
        check(failed.warnings.length <= 3, `${failed.warnings.length} warnings`)
      ]
    }
  },
  {
    id: 'fault-attack:18-receipt-fabrication',
    runs: ['required-source-failure'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('required-source-failure', agent)
      return [
        ...corpusExpectation('required-source-failure', run.observation),
        // No effect: the fabricated use is not accepted, so the turn never reaches review or the forge.
        check(run.observation.effects.codeReviewerDispatches === 0, 'reached review'),
        check(
          run.observation.effects.commits + run.observation.effects.pushes + run.observation.effects.prOpens === 0,
          'an effect'
        ),
        ...neverApproved(run)
      ]
    }
  },
  {
    id: 'fault-attack:30-reviewer-cross-talk',
    runs: ['reviewer-cross-talk'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('reviewer-cross-talk', agent)
      return [
        check(/no review \(role_mismatch\)/.test(pauseDetail(run)), `pause detail: ${pauseDetail(run)}`),
        ...neverApproved(run)
      ]
    }
  },
  {
    id: 'fault-attack:31-operator-read-used-to-mutate-control-state',
    runs: ['operator-read'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('operator-read', agent)
      const reads = run.inspection.operatorReads
      return [
        check(reads !== null, 'no read ran'),
        check(run.observation.decision === 'pause:escalation', `decision ${run.observation.decision}`),
        check((reads?.escalationRead as { ok?: boolean } | undefined)?.ok === true, 'the read failed'),
        check(reads?.packetPresent === true, 'nothing was read'),
        // Reads change nothing: every control file is byte-identical after the reads, the pause still unresolved.
        check(JSON.stringify(reads?.after) === JSON.stringify(reads?.before), 'a read changed a control file'),
        check(Object.keys(reads?.before ?? {}).length > 0, 'no control file to change'),
        check(reads?.pauseHeld === true, 'the pause is no longer held'),
        check(run.observation.durable.resolutions.length === 0, 'a resolution was recorded')
      ]
    }
  },
  {
    id: 'fault-attack:44-controller-held-secret-machine-local-identifier-session',
    runs: ['controller-secret'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('controller-secret', agent)
      const logText = JSON.stringify(run.observation.logLines ?? [])
      const surfaces: Record<string, string> = {
        prompts: JSON.stringify(run.inspection.prompts),
        events: run.inspection.events,
        log: logText
      }
      return [
        check(run.inspection.prompts.length >= 3, 'not every role was prompted'),
        check((run.observation.logLines ?? []).length > 0, 'no Log line was recorded'),
        ...Object.entries(surfaces).flatMap(([surface, text]) => [
          ...Object.entries(CONTROLLER_SECRETS).map(([key, value]) =>
            check(!text.includes(value), `${surface} carries ${key}`)
          ),
          check(!text.includes(REASONING_CANARY), `${surface} carries raw reasoning`)
        ]),
        // Structure kept: the run still completes and publishes.
        check(run.observation.decision === 'publish', `decision ${run.observation.decision}`)
      ]
    }
  },
  {
    id: 'fault-attack:45-confinement-missing-on-an-unsupported-host',
    runs: ['confinement-missing'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('confinement-missing', agent)
      return [
        check(run.observation.decision === 'pause:sandbox_refused', `decision ${run.observation.decision}`),
        // Before any turn.
        check(run.observation.effects.developerDispatches === 0, 'a Developer turn ran'),
        check(
          run.observation.effects.codeReviewerDispatches + run.observation.effects.securityDispatches === 0,
          'a reviewer ran'
        ),
        check(/bwrap/.test(pauseDetail(run)), `the refusal does not name the host's sandbox: ${pauseDetail(run)}`),
        check(isHostRepairPause('sandbox_refused'), 'sandbox_refused is not a capability refusal')
      ]
    }
  },
  {
    id: 'fault-attack:46-confinement-that-starts-and-fails-on-first-use',
    runs: ['confinement-fails-on-first-use'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('confinement-fails-on-first-use', agent)
      const pauses = run.observation.effects.markers.filter((marker) => marker.includes('paused'))
      return [
        check(run.observation.decision === 'pause:sandbox_refused', `decision ${run.observation.decision}`),
        check(/not permitted|Permission denied/.test(pauseDetail(run)), `pause detail: ${pauseDetail(run)}`),
        // One Operator-remediation pause, never counted as a Developer failure.
        check(pauses.length === 1, `${pauses.length} pauses`),
        check(run.observation.durable.escalations === 1, `${run.observation.durable.escalations} escalations`),
        check(
          isHostRepairPause('sandbox_refused') && !isAutomaticRecoveryPause('sandbox_refused'),
          'not Operator remediation'
        ),
        check(run.observation.durable.infrastructureRetries === 0, 'spent a retry'),
        check(run.observation.effects.developerDispatches === 0, 'counted against a Developer turn')
      ]
    }
  },
  {
    id: 'fault-attack:47-invalid-model-or-tool-output',
    runs: ['reviewer-invalidity', 'developer-failure'],
    layer: LAYER,
    classify: (agent) =>
      ['reviewer-invalidity', 'developer-failure'].flatMap((key) => {
        const run = runOf(key, agent)
        // Typed invalid result, bounded retry, never approval.
        return [...corpusExpectation(key, run.observation), ...automaticRecoveryWithinBound(run), ...neverApproved(run)]
      })
  },
  {
    id: 'fault-attack:48-provider-unavailable',
    runs: ['provider-failure'],
    layer: LAYER,
    classify: (agent) => {
      const run = runOf('provider-failure', agent)
      return [...corpusExpectation('provider-failure', run.observation), ...automaticRecoveryWithinBound(run)]
    }
  },
  {
    id: 'fault-attack:49-gate-failure',
    runs: ['mechanical-failure-repeats', 'mechanical-failure-recovers'],
    layer: LAYER,
    classify: (agent) => {
      const repeats = runOf('mechanical-failure-repeats', agent)
      const recovers = runOf('mechanical-failure-recovers', agent)
      return [
        // Classified red: revised once, then paused per policy when it repeats; a fixed gate goes on to review.
        ...corpusExpectation('mechanical-failure-repeats', repeats.observation),
        ...corpusExpectation('mechanical-failure-recovers', recovers.observation),
        check(repeats.observation.effects.codeReviewerDispatches === 0, 'a red gate reached review'),
        check(recovers.observation.effects.developerDispatches === 2, 'no revision')
      ]
    }
  },
  {
    id: 'fault-attack:52-hard-budget-exhaustion-turns-rounds-invalid-output-retries',
    runs: ['bounded-exhaustion', 'context-pressure'],
    layer: LAYER,
    classify: (agent) =>
      ['bounded-exhaustion', 'context-pressure'].flatMap((key) => {
        const run = runOf(key, agent)
        // Typed exhaustion, never reported as success.
        return [
          ...corpusExpectation(key, run.observation),
          check(
            /^pause:(max_rounds|time_budget)$/.test(run.observation.decision),
            `${key}: ${run.observation.decision}`
          ),
          check(run.observation.effects.publishedRounds.length === 0, `${key}: published`)
        ]
      })
  }
]

const failuresOf = (row: FaultRow, agent: Agent): string[] =>
  row.classify(agent).filter((entry): entry is string => entry !== null)
const classification = (row: FaultRow, agent: Agent) =>
  failuresOf(row, agent).length === 0 ? 'declared outcome' : 'different outcome'

describe('the fault-and-attack rows on the Engine, with both stub vendors', () => {
  for (const row of FAULT_ROWS)
    it(`${row.id} shows its declared outcome on claude and codex (${row.layer})`, () => {
      for (const agent of AGENTS) {
        const failures = failuresOf(row, agent)
        process.stdout.write(`  ${row.id} ${agent}: ${classification(row, agent)}\n`)
        expect({ row: row.id, agent, failures }).toEqual({ row: row.id, agent, failures: [] })
      }
    })
})

describe('both vendors classify every row identically, and none carries an expected failure', () => {
  it('runs every row on both vendors and classifies each identically', () => {
    expect(runs.length).toBe(RUN_SPECS.length * AGENTS.length)
    for (const row of FAULT_ROWS)
      expect({ row: row.id, claude: classification(row, 'claude') }).toEqual({
        row: row.id,
        claude: classification(row, 'codex')
      })
  })

  it('no corpus scenario a row runs carries an Engine expected-failure entry', () => {
    const scenarios = new Set(
      FAULT_ROWS.flatMap((row) => row.runs).flatMap((key) =>
        RUN_SPECS.filter((spec) => spec.key === key).map((spec) => spec.scenario)
      )
    )
    expect(
      (engineFailures as { entries: { scenario: string }[] }).entries.filter((entry) => scenarios.has(entry.scenario))
    ).toEqual([])
    for (const scenario of scenarios)
      expect(FAULT_IDS.includes(scenario) || ENGINE_SCENARIO_DRIVERS[scenario] !== undefined).toBe(true)
  })

  it('a fault run is no corpus scenario: the corpus and its drivers are unchanged by the fault runs', () => {
    const corpusIds = corpusScenarios.map((scenario) => scenario.id)
    expect(FAULT_IDS.filter((id) => corpusIds.includes(id))).toEqual([])
    expect(Object.keys(ENGINE_SCENARIO_DRIVERS).sort()).toEqual([...corpusIds].sort())
  })
})

describe('each of these rows names this test as its Engine evidence', () => {
  const loaded = loadRegistry(
    join(REPO_ROOT, 'apps/cli/tests/eval/registry/modules.json'),
    join(REPO_ROOT, 'apps/cli/tests/eval/registry/shards')
  )
  if (!loaded.ok) throw new Error(`registry refused: ${JSON.stringify(loaded.refusal)}`)
  const owed = (
    JSON.parse(readFileSync(join(REPO_ROOT, 'apps/cli/tests/eval/engine-evidence-owed.json'), 'utf8')) as {
      owed: string[]
    }
  ).owed

  it('covers eighteen distinct rows, each a fault-and-attack row of the registry', () => {
    const ids = FAULT_ROWS.map((row) => row.id)
    expect(new Set(ids).size).toBe(18)
    for (const id of ids)
      expect({ id, row: loaded.value.components.some(({ row }) => row.id === id) }).toEqual({ id, row: true })
  })

  it('every row is evidenced on the Engine by a test file that exists, and none is on the owed list', () => {
    for (const { id } of FAULT_ROWS) {
      const row = loaded.value.components.find((component) => component.row.id === id)?.row
      const state = row === undefined ? undefined : engineEvidenceOf(row)
      expect({ id, state }).toEqual({ id, state: { state: 'evidenced', test: THIS_TEST } })
      expect({ id, exists: existsSync(join(REPO_ROOT, THIS_TEST)) }).toEqual({ id, exists: true })
      expect({ id, owed: owed.includes(id) }).toEqual({ id, owed: false })
    }
  })
})
