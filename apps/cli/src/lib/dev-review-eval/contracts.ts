/**
 * The evaluation harness's typed contracts: the four ports the evaluation
 * program names — Task, Trial, Grader, Report — and the Suite that groups
 * tasks. Vocabulary follows `apps/cli/specs/dev-review-evaluation-program.md`
 * §3 exactly; this module's own specification is `apps/cli/specs/evals.md`.
 *
 * Every value that crosses a port is plain data, and each has a validator that
 * either returns the value or refuses it with a typed reason naming the
 * offending field. Nothing here runs an agent, stages an environment or picks
 * a statistical method — those values are inputs, frozen by a later milestone.
 *
 * The harness is internal: no CLI entry or command imports it, and an
 * architecture test (`tests/eval/not-shipped.test.ts`) keeps it that way.
 */

// ── Validation result ───────────────────────────────────────────────────────

/** Why a value was refused. `path` names the field, dotted from the root. */
export type ContractRefusalCode =
  | 'not_object'
  | 'missing_field'
  | 'wrong_type'
  | 'empty'
  | 'bad_digest'
  | 'bad_commit'
  | 'bad_name'
  | 'out_of_range'
  | 'duplicate'
  | 'unknown_value'
  | 'unknown_from_code_grader'
  | 'reason_required'
  | 'reference_solution_required'
  | 'grader_not_pinned'
  | 'splits_overlap'
  | 'splits_changed'
  | 'shared_isolation'
  | 'inconsistent'

export interface ContractRefusal {
  code: ContractRefusalCode
  path: string
  detail: string
}

export type Validated<T> = { ok: true; value: T } | { ok: false; refusal: ContractRefusal }

class Refused extends Error {
  constructor(readonly refusal: ContractRefusal) {
    super(refusal.detail)
  }
}

function refuse(code: ContractRefusalCode, path: string, detail: string): never {
  throw new Refused({ code, path, detail })
}

function run<T>(input: unknown, check: (input: unknown) => T): Validated<T> {
  try {
    return { ok: true, value: check(input) }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, refusal: error.refusal }
    throw error
  }
}

// ── Field readers ───────────────────────────────────────────────────────────

/** A SHA-256 digest written as 64 lowercase hexadecimal characters. */
export type Digest = string

const DIGEST = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{40}$/
/** Stable identifiers: lowercase kebab segments, optionally `/`-separated. */
const NAME = /^[a-z0-9]+(?:[-.][a-z0-9]+)*(?:\/[a-z0-9]+(?:[-.][a-z0-9]+)*)*$/

function record(input: unknown, path: string): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    refuse('not_object', path, `${path || 'value'} must be an object`)
  }
  return input as Record<string, unknown>
}

function field(obj: Record<string, unknown>, key: string, path: string): unknown {
  if (!(key in obj) || obj[key] === undefined)
    refuse('missing_field', join(path, key), `${join(path, key)} is required`)
  return obj[key]
}

function join(path: string, key: string | number): string {
  return path === '' ? String(key) : `${path}.${key}`
}

function text(input: unknown, path: string): string {
  if (typeof input !== 'string') refuse('wrong_type', path, `${path} must be a string`)
  if (input.trim() === '') refuse('empty', path, `${path} must not be empty`)
  return input
}

function name(input: unknown, path: string): string {
  const value = text(input, path)
  if (!NAME.test(value))
    refuse('bad_name', path, `${path} must be a stable lowercase identifier, got ${JSON.stringify(value)}`)
  return value
}

function digest(input: unknown, path: string): Digest {
  const value = text(input, path)
  if (!DIGEST.test(value)) refuse('bad_digest', path, `${path} must be a 64-character lowercase SHA-256 digest`)
  return value
}

function commit(input: unknown, path: string): string {
  const value = text(input, path)
  if (!COMMIT.test(value)) refuse('bad_commit', path, `${path} must be a 40-character lowercase commit id`)
  return value
}

function integer(input: unknown, path: string, min: number): number {
  if (typeof input !== 'number' || !Number.isInteger(input)) refuse('wrong_type', path, `${path} must be an integer`)
  if (input < min) refuse('out_of_range', path, `${path} must be at least ${min}, got ${input}`)
  return input
}

function finite(input: unknown, path: string, min: number, max: number): number {
  if (typeof input !== 'number' || !Number.isFinite(input))
    refuse('wrong_type', path, `${path} must be a finite number`)
  if (input < min || input > max) refuse('out_of_range', path, `${path} must lie in [${min}, ${max}], got ${input}`)
  return input
}

function oneOf<T extends string>(input: unknown, path: string, allowed: readonly T[]): T {
  if (typeof input !== 'string') refuse('wrong_type', path, `${path} must be a string`)
  if (!(allowed as readonly string[]).includes(input)) {
    refuse('unknown_value', path, `${path} must be one of ${allowed.join(', ')}, got ${JSON.stringify(input)}`)
  }
  return input as T
}

function list<T>(input: unknown, path: string, item: (value: unknown, path: string) => T): T[] {
  if (!Array.isArray(input)) refuse('wrong_type', path, `${path} must be an array`)
  return input.map((value, index) => item(value, join(path, index)))
}

function distinct(values: readonly string[], path: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) refuse('duplicate', path, `${path} lists ${JSON.stringify(value)} more than once`)
    seen.add(value)
  }
}

function digestMap(input: unknown, path: string): Record<string, Digest> {
  const obj = record(input, path)
  const out: Record<string, Digest> = {}
  for (const [key, value] of Object.entries(obj)) out[name(key, join(path, '<key>'))] = digest(value, join(path, key))
  return out
}

// ── Grader ──────────────────────────────────────────────────────────────────

/** A code grader is pinned by its identifier, version and logic digest. */
export interface CodeGraderIdentity {
  kind: 'code'
  id: string
  version: string
  logicDigest: Digest
}

/**
 * A model grader is pinned by every element the evaluation program's §7
 * lists; changing any one requires recalibration.
 */
export interface ModelGraderIdentity {
  kind: 'model'
  id: string
  version: string
  adapterVersion: string
  cliVersion: string
  model: string
  promptDigest: Digest
  outputSchemaDigest: Digest
  calibrationCorpusDigest: Digest
}

export type GraderIdentity = CodeGraderIdentity | ModelGraderIdentity

/** One grader's verdict on one aspect of one trial. `unknown` is model-only. */
export type GraderVerdict =
  | { verdict: 'pass' }
  | { verdict: 'fail'; reason: string }
  | { verdict: 'unknown'; reason: string }

/** A verdict bound to the pinned grader that produced it. */
export interface GraderResult {
  grader: GraderIdentity
  result: GraderVerdict
}

/**
 * The Grader port: pinned logic scoring one aspect of a trial's outcome. Its
 * input is the trial's recorded outcome, never what the agent said happened.
 */
export interface Grader<Outcome = unknown> {
  identity: GraderIdentity
  grade(outcome: Outcome): Promise<GraderVerdict>
}

function graderIdentity(input: unknown, path: string): GraderIdentity {
  const obj = record(input, path)
  const kind = oneOf(field(obj, 'kind', path), join(path, 'kind'), ['code', 'model'] as const)
  const id = name(field(obj, 'id', path), join(path, 'id'))
  const version = text(field(obj, 'version', path), join(path, 'version'))
  if (kind === 'code') {
    return { kind, id, version, logicDigest: digest(field(obj, 'logicDigest', path), join(path, 'logicDigest')) }
  }
  return {
    kind,
    id,
    version,
    adapterVersion: text(field(obj, 'adapterVersion', path), join(path, 'adapterVersion')),
    cliVersion: text(field(obj, 'cliVersion', path), join(path, 'cliVersion')),
    model: text(field(obj, 'model', path), join(path, 'model')),
    promptDigest: digest(field(obj, 'promptDigest', path), join(path, 'promptDigest')),
    outputSchemaDigest: digest(field(obj, 'outputSchemaDigest', path), join(path, 'outputSchemaDigest')),
    calibrationCorpusDigest: digest(field(obj, 'calibrationCorpusDigest', path), join(path, 'calibrationCorpusDigest'))
  }
}

function graderVerdict(input: unknown, path: string, kind: GraderIdentity['kind']): GraderVerdict {
  const obj = record(input, path)
  const verdict = oneOf(field(obj, 'verdict', path), join(path, 'verdict'), ['pass', 'fail', 'unknown'] as const)
  if (verdict === 'pass') return { verdict }
  if (verdict === 'unknown' && kind === 'code') {
    refuse('unknown_from_code_grader', join(path, 'verdict'), 'only a model grader may return unknown')
  }
  if (!('reason' in obj) || obj.reason === undefined) {
    refuse('reason_required', join(path, 'reason'), `a ${verdict} verdict must carry a reason`)
  }
  return { verdict, reason: text(obj.reason, join(path, 'reason')) }
}

function graderResult(input: unknown, path: string): GraderResult {
  const obj = record(input, path)
  const grader = graderIdentity(field(obj, 'grader', path), join(path, 'grader'))
  return { grader, result: graderVerdict(field(obj, 'result', path), join(path, 'result'), grader.kind) }
}

export function validateGraderIdentity(input: unknown): Validated<GraderIdentity> {
  return run(input, (value) => graderIdentity(value, ''))
}

export function validateGraderResult(input: unknown): Validated<GraderResult> {
  return run(input, (value) => graderResult(value, ''))
}

// ── Task ────────────────────────────────────────────────────────────────────

/** A pinned, versioned reference to a piece of harness logic. */
export interface PinnedRef {
  id: string
  version: string
}

/** The fixed inputs a task stages before any model process starts. */
export interface TaskInputs {
  repositoryCommit: string
  briefDigest: Digest
  stagedInputDigests: Record<string, Digest>
  scriptedEnvironmentDigest: Digest | null
}

/** §9 "Pinning": everything a task's result depends on, recorded. */
export interface PinningRecord {
  repositoryCommit: string
  briefDigest: Digest
  stagedInputDigests: Record<string, Digest>
  referenceSolutionDigest: Digest | null
  expectedOutcomeDigest: Digest
  graders: GraderIdentity[]
}

/**
 * One test case. A coding task carries a reference solution proving it
 * solvable; a non-coding task (a review, a selection) may carry none.
 */
export interface Task {
  id: string
  kind: 'coding' | 'non-coding'
  inputs: TaskInputs
  environmentBuilder: PinnedRef
  referenceSolution: { digest: Digest } | null
  graders: GraderIdentity[]
  pinning: PinningRecord
}

function pinnedRef(input: unknown, path: string): PinnedRef {
  const obj = record(input, path)
  return {
    id: name(field(obj, 'id', path), join(path, 'id')),
    version: text(field(obj, 'version', path), join(path, 'version'))
  }
}

function nullableDigest(input: unknown, path: string): Digest | null {
  return input === null ? null : digest(input, path)
}

function graderKey(identity: GraderIdentity): string {
  return JSON.stringify(Object.entries(identity).sort(([a], [b]) => a.localeCompare(b)))
}

function graderList(input: unknown, path: string): GraderIdentity[] {
  const graders = list(input, path, graderIdentity)
  if (graders.length === 0) refuse('empty', path, `${path} must name at least one grader`)
  distinct(
    graders.map((g) => g.id),
    path
  )
  return graders
}

function task(input: unknown, path: string): Task {
  const obj = record(input, path)
  const id = name(field(obj, 'id', path), join(path, 'id'))
  const kind = oneOf(field(obj, 'kind', path), join(path, 'kind'), ['coding', 'non-coding'] as const)

  const inputsPath = join(path, 'inputs')
  const rawInputs = record(field(obj, 'inputs', path), inputsPath)
  const inputs: TaskInputs = {
    repositoryCommit: commit(field(rawInputs, 'repositoryCommit', inputsPath), join(inputsPath, 'repositoryCommit')),
    briefDigest: digest(field(rawInputs, 'briefDigest', inputsPath), join(inputsPath, 'briefDigest')),
    stagedInputDigests: digestMap(
      field(rawInputs, 'stagedInputDigests', inputsPath),
      join(inputsPath, 'stagedInputDigests')
    ),
    scriptedEnvironmentDigest: nullableDigest(
      field(rawInputs, 'scriptedEnvironmentDigest', inputsPath),
      join(inputsPath, 'scriptedEnvironmentDigest')
    )
  }

  const environmentBuilder = pinnedRef(field(obj, 'environmentBuilder', path), join(path, 'environmentBuilder'))

  const rawSolution = field(obj, 'referenceSolution', path)
  const referenceSolution =
    rawSolution === null
      ? null
      : {
          digest: digest(
            field(record(rawSolution, join(path, 'referenceSolution')), 'digest', join(path, 'referenceSolution')),
            join(path, 'referenceSolution.digest')
          )
        }
  if (kind === 'coding' && referenceSolution === null) {
    refuse(
      'reference_solution_required',
      join(path, 'referenceSolution'),
      'a coding task must carry a reference solution'
    )
  }

  const graders = graderList(field(obj, 'graders', path), join(path, 'graders'))

  const pinPath = join(path, 'pinning')
  const rawPin = record(field(obj, 'pinning', path), pinPath)
  const pinning: PinningRecord = {
    repositoryCommit: commit(field(rawPin, 'repositoryCommit', pinPath), join(pinPath, 'repositoryCommit')),
    briefDigest: digest(field(rawPin, 'briefDigest', pinPath), join(pinPath, 'briefDigest')),
    stagedInputDigests: digestMap(field(rawPin, 'stagedInputDigests', pinPath), join(pinPath, 'stagedInputDigests')),
    referenceSolutionDigest: nullableDigest(
      field(rawPin, 'referenceSolutionDigest', pinPath),
      join(pinPath, 'referenceSolutionDigest')
    ),
    expectedOutcomeDigest: digest(
      field(rawPin, 'expectedOutcomeDigest', pinPath),
      join(pinPath, 'expectedOutcomeDigest')
    ),
    graders: graderList(field(rawPin, 'graders', pinPath), join(pinPath, 'graders'))
  }

  // The pinning record restates the task; any disagreement means one of them is stale.
  if (pinning.repositoryCommit !== inputs.repositoryCommit) {
    refuse(
      'inconsistent',
      join(pinPath, 'repositoryCommit'),
      'pinning.repositoryCommit differs from inputs.repositoryCommit'
    )
  }
  if (pinning.briefDigest !== inputs.briefDigest) {
    refuse('inconsistent', join(pinPath, 'briefDigest'), 'pinning.briefDigest differs from inputs.briefDigest')
  }
  if (
    JSON.stringify(sortedEntries(pinning.stagedInputDigests)) !==
    JSON.stringify(sortedEntries(inputs.stagedInputDigests))
  ) {
    refuse(
      'inconsistent',
      join(pinPath, 'stagedInputDigests'),
      'pinning.stagedInputDigests differs from inputs.stagedInputDigests'
    )
  }
  if (pinning.referenceSolutionDigest !== (referenceSolution?.digest ?? null)) {
    refuse(
      'inconsistent',
      join(pinPath, 'referenceSolutionDigest'),
      'pinning.referenceSolutionDigest differs from referenceSolution'
    )
  }
  const pinned = new Set(pinning.graders.map(graderKey))
  for (const [index, grader] of graders.entries()) {
    if (!pinned.has(graderKey(grader))) {
      refuse(
        'grader_not_pinned',
        join(join(path, 'graders'), index),
        `grader ${grader.id} is not pinned at this identity`
      )
    }
  }
  if (pinning.graders.length !== graders.length) {
    refuse('inconsistent', join(pinPath, 'graders'), 'pinning.graders names a grader the task does not run')
  }

  return { id, kind, inputs, environmentBuilder, referenceSolution, graders, pinning }
}

function sortedEntries(map: Record<string, string>): [string, string][] {
  return Object.entries(map).sort(([a], [b]) => a.localeCompare(b))
}

export function validateTask(input: unknown): Validated<Task> {
  return run(input, (value) => task(value, ''))
}

// ── Trial ───────────────────────────────────────────────────────────────────

/**
 * What part of the system under test a trial exercised. A graph-backed
 * condition may run one node alone or one section by partial execution; every
 * other trial runs whole.
 */
export type TrialScope =
  | { kind: 'whole' }
  | { kind: 'node'; node: string }
  | { kind: 'section'; fromNode: string; toNode: string }

/**
 * The per-trial isolation identities. Each is fresh for its trial: no two
 * trials in one run share a workspace, vendor home, checkpointer or Log
 * destination (`validateTrialSet` enforces it).
 */
export interface TrialIsolation {
  workspaceId: string
  vendorHomeId: string
  checkpointerId: string
  logDestinationId: string
}

/** How the trial ended: graded, or stopped before grading with a reason. */
export type TrialOutcome =
  | { kind: 'graded'; outcomeDigest: Digest; grades: GraderResult[] }
  | { kind: 'errored'; reason: string }

/** One isolated execution of one task under one condition. */
export interface Trial {
  id: string
  taskId: string
  condition: string
  attempt: number
  scope: TrialScope
  isolation: TrialIsolation
  outcome: TrialOutcome
  transcriptDigests: Digest[]
}

function trialScope(input: unknown, path: string): TrialScope {
  const obj = record(input, path)
  const kind = oneOf(field(obj, 'kind', path), join(path, 'kind'), ['whole', 'node', 'section'] as const)
  if (kind === 'whole') return { kind }
  if (kind === 'node') return { kind, node: text(field(obj, 'node', path), join(path, 'node')) }
  return {
    kind,
    fromNode: text(field(obj, 'fromNode', path), join(path, 'fromNode')),
    toNode: text(field(obj, 'toNode', path), join(path, 'toNode'))
  }
}

const ISOLATION_KEYS = ['workspaceId', 'vendorHomeId', 'checkpointerId', 'logDestinationId'] as const

function trialIsolation(input: unknown, path: string): TrialIsolation {
  const obj = record(input, path)
  const out = {} as TrialIsolation
  for (const key of ISOLATION_KEYS) out[key] = text(field(obj, key, path), join(path, key))
  return out
}

function trialOutcome(input: unknown, path: string): TrialOutcome {
  const obj = record(input, path)
  const kind = oneOf(field(obj, 'kind', path), join(path, 'kind'), ['graded', 'errored'] as const)
  if (kind === 'errored') return { kind, reason: text(field(obj, 'reason', path), join(path, 'reason')) }
  const grades = list(field(obj, 'grades', path), join(path, 'grades'), graderResult)
  if (grades.length === 0) refuse('empty', join(path, 'grades'), 'a graded outcome must carry at least one grade')
  distinct(
    grades.map((g) => g.grader.id),
    join(path, 'grades')
  )
  return { kind, outcomeDigest: digest(field(obj, 'outcomeDigest', path), join(path, 'outcomeDigest')), grades }
}

function trial(input: unknown, path: string): Trial {
  const obj = record(input, path)
  const transcriptDigests = list(field(obj, 'transcriptDigests', path), join(path, 'transcriptDigests'), digest)
  distinct(transcriptDigests, join(path, 'transcriptDigests'))
  return {
    id: name(field(obj, 'id', path), join(path, 'id')),
    taskId: name(field(obj, 'taskId', path), join(path, 'taskId')),
    condition: name(field(obj, 'condition', path), join(path, 'condition')),
    attempt: integer(field(obj, 'attempt', path), join(path, 'attempt'), 1),
    scope: trialScope(field(obj, 'scope', path), join(path, 'scope')),
    isolation: trialIsolation(field(obj, 'isolation', path), join(path, 'isolation')),
    outcome: trialOutcome(field(obj, 'outcome', path), join(path, 'outcome')),
    transcriptDigests
  }
}

export function validateTrial(input: unknown): Validated<Trial> {
  return run(input, (value) => trial(value, ''))
}

/**
 * Validates a run's trials together: each must be valid on its own, ids and
 * (task, condition, attempt) triples must be unique, and no isolation identity
 * may be shared between two trials — every trial starts clean.
 */
export function validateTrialSet(input: unknown): Validated<Trial[]> {
  return run(input, (value) => {
    const trials = list(value, 'trials', trial)
    distinct(
      trials.map((t) => t.id),
      'trials.id'
    )
    distinct(
      trials.map((t) => `${t.taskId} ${t.condition} ${t.attempt}`),
      'trials.attempt'
    )
    for (const key of ISOLATION_KEYS) {
      const owner = new Map<string, string>()
      for (const t of trials) {
        const prior = owner.get(t.isolation[key])
        if (prior !== undefined) {
          refuse(
            'shared_isolation',
            `trials.isolation.${key}`,
            `trials ${prior} and ${t.id} share ${key} ${t.isolation[key]}`
          )
        }
        owner.set(t.isolation[key], t.id)
      }
    }
    return trials
  })
}

/**
 * A trial's task-level verdict: `pass` only when every grade passes, `fail`
 * when any grade fails or the trial errored, otherwise `unknown` — which the
 * evaluation program routes to human adjudication before it may be counted.
 */
export function trialVerdict(t: Trial): 'pass' | 'fail' | 'unknown' {
  if (t.outcome.kind === 'errored') return 'fail'
  const verdicts = t.outcome.grades.map((g) => g.result.verdict)
  if (verdicts.includes('fail')) return 'fail'
  if (verdicts.includes('unknown')) return 'unknown'
  return 'pass'
}

// ── Suite ───────────────────────────────────────────────────────────────────

export const EVALUATION_LAYERS = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8'] as const
export type EvaluationLayer = (typeof EVALUATION_LAYERS)[number]

/** Development and held-out task ids, fixed when the suite is created. */
export interface SuiteSplits {
  development: readonly string[]
  heldOut: readonly string[]
}

/** A named, versioned set of tasks measuring one module or behaviour. */
export interface Suite {
  name: string
  version: number
  layer: EvaluationLayer
  kind: 'capability' | 'regression'
  splits: SuiteSplits
}

function suite(input: unknown, path: string): Suite {
  const obj = record(input, path)
  const splitsPath = join(path, 'splits')
  const rawSplits = record(field(obj, 'splits', path), splitsPath)
  const development = list(field(rawSplits, 'development', splitsPath), join(splitsPath, 'development'), name)
  const heldOut = list(field(rawSplits, 'heldOut', splitsPath), join(splitsPath, 'heldOut'), name)
  distinct(development, join(splitsPath, 'development'))
  distinct(heldOut, join(splitsPath, 'heldOut'))
  if (development.length + heldOut.length === 0) refuse('empty', splitsPath, 'a suite must hold at least one task')
  const dev = new Set(development)
  const shared = heldOut.find((id) => dev.has(id))
  if (shared !== undefined) {
    refuse('splits_overlap', splitsPath, `task ${shared} is in both the development and the held-out split`)
  }
  return {
    name: name(field(obj, 'name', path), join(path, 'name')),
    version: integer(field(obj, 'version', path), join(path, 'version'), 1),
    layer: oneOf(field(obj, 'layer', path), join(path, 'layer'), EVALUATION_LAYERS),
    kind: oneOf(field(obj, 'kind', path), join(path, 'kind'), ['capability', 'regression'] as const),
    splits: { development, heldOut }
  }
}

export function validateSuite(input: unknown): Validated<Suite> {
  return run(input, (value) => suite(value, ''))
}

/**
 * Creates a suite: validates it, then freezes it so its splits cannot be
 * mutated after creation.
 */
export function createSuite(input: unknown): Validated<Readonly<Suite>> {
  const result = validateSuite(input)
  if (!result.ok) return result
  const { splits } = result.value
  return {
    ok: true,
    value: Object.freeze({
      ...result.value,
      splits: Object.freeze({
        development: Object.freeze([...splits.development]),
        heldOut: Object.freeze([...splits.heldOut])
      })
    })
  }
}

/**
 * Refuses a suite that claims to be an already-recorded suite (same name and
 * version) but whose splits differ from the recorded ones.
 */
export function validateSuiteRevision(recorded: Suite, candidate: unknown): Validated<Suite> {
  return run(candidate, (value) => {
    const next = suite(value, '')
    if (next.name !== recorded.name || next.version !== recorded.version) return next
    const same = (a: readonly string[], b: readonly string[]) =>
      JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
    if (
      !same(next.splits.development, recorded.splits.development) ||
      !same(next.splits.heldOut, recorded.splits.heldOut)
    ) {
      refuse(
        'splits_changed',
        'splits',
        `suite ${next.name} version ${next.version} cannot change its splits after creation`
      )
    }
    return next
  })
}

// ── Report ──────────────────────────────────────────────────────────────────

/** Per-task tally: successes c out of n trials under one condition. */
export interface TaskTally {
  taskId: string
  successes: number
  trials: number
}

/** The resampling inputs a randomised interval was computed with. */
export interface ResamplingRecord {
  method: string
  seed: number
  resamples: number
  confidence: number
}

export interface Interval {
  lower: number
  upper: number
}

/** A quarantined task: still shown, counted separately, with its cause. */
export interface Quarantine {
  taskId: string
  cause: 'broken-task' | 'broken-grader' | 'environment'
  reason: string
  reasonVersion: number
  adjudicationDigest: Digest
}

export interface ConditionReport {
  condition: string
  tasks: TaskTally[]
  mean: number
  interval: Interval
  resampling: ResamplingRecord
  passHatK: { k: number; value: number }[]
}

export interface PairedReport {
  baseline: string
  candidate: string
  meanDifference: number
  interval: Interval
  resampling: ResamplingRecord
  regressions: string[]
  severeRegressions: string[]
}

/**
 * Per-task and per-suite estimates, the paired comparison where one ran,
 * quarantined tasks counted apart, and the transcripts behind it by digest.
 */
export interface Report {
  suite: { name: string; version: number }
  split: 'development' | 'held-out'
  conditions: ConditionReport[]
  paired: PairedReport | null
  quarantined: Quarantine[]
  transcriptDigests: Digest[]
}

function tally(input: unknown, path: string): TaskTally {
  const obj = record(input, path)
  const t: TaskTally = {
    taskId: name(field(obj, 'taskId', path), join(path, 'taskId')),
    successes: integer(field(obj, 'successes', path), join(path, 'successes'), 0),
    trials: integer(field(obj, 'trials', path), join(path, 'trials'), 1)
  }
  if (t.successes > t.trials) refuse('out_of_range', join(path, 'successes'), 'successes cannot exceed trials')
  return t
}

function resampling(input: unknown, path: string): ResamplingRecord {
  const obj = record(input, path)
  return {
    method: text(field(obj, 'method', path), join(path, 'method')),
    seed: integer(field(obj, 'seed', path), join(path, 'seed'), 0),
    resamples: integer(field(obj, 'resamples', path), join(path, 'resamples'), 1),
    confidence: finite(field(obj, 'confidence', path), join(path, 'confidence'), Number.MIN_VALUE, 1 - Number.EPSILON)
  }
}

function interval(input: unknown, path: string, estimate: number, min: number, max: number): Interval {
  const obj = record(input, path)
  const lower = finite(field(obj, 'lower', path), join(path, 'lower'), min, max)
  const upper = finite(field(obj, 'upper', path), join(path, 'upper'), min, max)
  if (lower > estimate || estimate > upper) {
    refuse('inconsistent', path, `interval [${lower}, ${upper}] does not contain its estimate ${estimate}`)
  }
  return { lower, upper }
}

function conditionReport(input: unknown, path: string): ConditionReport {
  const obj = record(input, path)
  const tasks = list(field(obj, 'tasks', path), join(path, 'tasks'), tally)
  if (tasks.length === 0) refuse('empty', join(path, 'tasks'), 'a condition must report at least one task')
  distinct(
    tasks.map((t) => t.taskId),
    join(path, 'tasks')
  )
  const mean = finite(field(obj, 'mean', path), join(path, 'mean'), 0, 1)
  const passHatK = list(field(obj, 'passHatK', path), join(path, 'passHatK'), (value, p) => {
    const entry = record(value, p)
    const k = integer(field(entry, 'k', p), join(p, 'k'), 1)
    const short = tasks.find((t) => t.trials < k)
    if (short !== undefined)
      refuse('out_of_range', join(p, 'k'), `task ${short.taskId} ran ${short.trials} trials, fewer than k = ${k}`)
    return { k, value: finite(field(entry, 'value', p), join(p, 'value'), 0, 1) }
  })
  return {
    condition: name(field(obj, 'condition', path), join(path, 'condition')),
    tasks,
    mean,
    interval: interval(field(obj, 'interval', path), join(path, 'interval'), mean, 0, 1),
    resampling: resampling(field(obj, 'resampling', path), join(path, 'resampling')),
    passHatK
  }
}

function pairedReport(input: unknown, path: string, conditions: ConditionReport[]): PairedReport {
  const obj = record(input, path)
  const baseline = name(field(obj, 'baseline', path), join(path, 'baseline'))
  const candidate = name(field(obj, 'candidate', path), join(path, 'candidate'))
  const named = new Map(conditions.map((c) => [c.condition, c]))
  for (const [key, condition] of [
    ['baseline', baseline],
    ['candidate', candidate]
  ] as const) {
    if (!named.has(condition))
      refuse('inconsistent', join(path, key), `${key} ${condition} is not a reported condition`)
  }
  if (baseline === candidate) refuse('inconsistent', join(path, 'candidate'), 'baseline and candidate must differ')
  const meanDifference = finite(field(obj, 'meanDifference', path), join(path, 'meanDifference'), -1, 1)
  const regressions = list(field(obj, 'regressions', path), join(path, 'regressions'), name)
  const severeRegressions = list(field(obj, 'severeRegressions', path), join(path, 'severeRegressions'), name)
  distinct(regressions, join(path, 'regressions'))
  distinct(severeRegressions, join(path, 'severeRegressions'))
  const listed = new Set(regressions)
  const stray = severeRegressions.find((id) => !listed.has(id))
  if (stray !== undefined) {
    refuse('inconsistent', join(path, 'severeRegressions'), `severe regression ${stray} is not listed as a regression`)
  }
  return {
    baseline,
    candidate,
    meanDifference,
    interval: interval(field(obj, 'interval', path), join(path, 'interval'), meanDifference, -1, 1),
    resampling: resampling(field(obj, 'resampling', path), join(path, 'resampling')),
    regressions,
    severeRegressions
  }
}

function quarantine(input: unknown, path: string): Quarantine {
  const obj = record(input, path)
  return {
    taskId: name(field(obj, 'taskId', path), join(path, 'taskId')),
    cause: oneOf(field(obj, 'cause', path), join(path, 'cause'), [
      'broken-task',
      'broken-grader',
      'environment'
    ] as const),
    reason: text(field(obj, 'reason', path), join(path, 'reason')),
    reasonVersion: integer(field(obj, 'reasonVersion', path), join(path, 'reasonVersion'), 1),
    adjudicationDigest: digest(field(obj, 'adjudicationDigest', path), join(path, 'adjudicationDigest'))
  }
}

function report(input: unknown, path: string): Report {
  const obj = record(input, path)
  const suitePath = join(path, 'suite')
  const rawSuite = record(field(obj, 'suite', path), suitePath)
  const conditions = list(field(obj, 'conditions', path), join(path, 'conditions'), conditionReport)
  if (conditions.length === 0) refuse('empty', join(path, 'conditions'), 'a report must carry at least one condition')
  distinct(
    conditions.map((c) => c.condition),
    join(path, 'conditions')
  )
  const rawPaired = field(obj, 'paired', path)
  const quarantined = list(field(obj, 'quarantined', path), join(path, 'quarantined'), quarantine)
  distinct(
    quarantined.map((q) => q.taskId),
    join(path, 'quarantined')
  )
  // Quarantined tasks are counted apart, never silently dropped: a task may
  // not appear in both the estimates and the quarantine list.
  const estimated = new Set(conditions.flatMap((c) => c.tasks.map((t) => t.taskId)))
  const both = quarantined.find((q) => estimated.has(q.taskId))
  if (both !== undefined) {
    refuse('inconsistent', join(path, 'quarantined'), `task ${both.taskId} is both quarantined and estimated`)
  }
  const transcriptDigests = list(field(obj, 'transcriptDigests', path), join(path, 'transcriptDigests'), digest)
  distinct(transcriptDigests, join(path, 'transcriptDigests'))
  return {
    suite: {
      name: name(field(rawSuite, 'name', suitePath), join(suitePath, 'name')),
      version: integer(field(rawSuite, 'version', suitePath), join(suitePath, 'version'), 1)
    },
    split: oneOf(field(obj, 'split', path), join(path, 'split'), ['development', 'held-out'] as const),
    conditions,
    paired: rawPaired === null ? null : pairedReport(rawPaired, join(path, 'paired'), conditions),
    quarantined,
    transcriptDigests
  }
}

export function validateReport(input: unknown): Validated<Report> {
  return run(input, (value) => report(value, ''))
}

export function validateTaskTally(input: unknown): Validated<TaskTally> {
  return run(input, (value) => tally(value, ''))
}
