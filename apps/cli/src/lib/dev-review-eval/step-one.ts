import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { beyondSurfacePaths, redact, withBeyondSurfaceBlock } from '@attalabs/aeg-core'
import {
  addCodexWritableDirs,
  buildCodexExecpolicyRules,
  codexSpawnEnvExtras,
  dispatchRole,
  type AgentVendor
} from '../dispatch'
import { publishingInstructionLine } from '../dev-review-loop'
import { runtimeDirForThisRepo } from '../run-paths'
import { startDevToolsHost } from '../task-tools/dev-tools-host'
import { devToolsSocketPath, driverDevBridgeInvocation } from '../task-tools/dev-tools-registration'
import { buildWorkerEnv, containerClaudeLogin, stageCodexPolicyHome } from '../worker-boundary'
import { prepareGradingCopy, testContamination, type Attribution, type HiddenInputs } from './contamination'
import { ENGINE_SPAWN, runEngineRoleStep, type SpawnFn, usageOfStream } from './engine-role-step'
import { suiteMean, type BootstrapMethod } from './estimators'
import { GENERIC_GRADERS } from './generic-graders'
import type { NeutralCase } from './neutral-case'
import type { TestResult as NeutralTestResult } from './neutral-outcomes'
import { type CloneStaging, git, stageTrial } from './staging'
import {
  extractOutcomes,
  renderCase,
  VINAYA_RENDERER_VERSION,
  type VinayaProcessInput,
  type VinayaTrialRecord
} from './vinaya-renderer'

export const STEP_ONE_SUITES = [
  'developer-capability.l5',
  'code-reviewer-quality.l5',
  'security-reviewer-quality.l5'
] as const
export const STEP_ONE_ADAPTERS = ['claude-code', 'codex'] as const

/**
 * The suites step one compares the standalone and Engine backends on: the
 * layer-`G` developer capability, code reviewer and security reviewer
 * suites, whose graders read only neutral outcomes.
 */
export const STEP_ONE_COMPARISON_SUITES = [
  'developer-capability-neutral.l5',
  'code-reviewer-quality-neutral.l5',
  'security-reviewer-quality-neutral.l5'
] as const

/** The layer-`G` suites step one runs only for development-only and practice results, never as comparison evidence. */
export const STEP_ONE_PRACTICE_SUITES = ['source-delivery-neutral.l5'] as const

/**
 * What a step-one run is for: `development-only` results, a `practice` run
 * of one trial per task that measures cost and decides nothing, or
 * `comparison` evidence for the backend comparison.
 */
export const STEP_ONE_PURPOSES = ['development-only', 'practice', 'comparison'] as const

export type StepOneSuite = (typeof STEP_ONE_SUITES)[number]
export type StepOneComparisonSuite = (typeof STEP_ONE_COMPARISON_SUITES)[number]
export type StepOneRunSuite = StepOneSuite | StepOneComparisonSuite | (typeof STEP_ONE_PRACTICE_SUITES)[number]
export type StepOnePurpose = (typeof STEP_ONE_PURPOSES)[number]
export type StepOneAdapter = (typeof STEP_ONE_ADAPTERS)[number]
export type StepOneRefusalCode =
  | 'held_out_forbidden'
  | 'engine_forbidden'
  | 'empty_development_split'
  | 'invalid_input'
  | 'layer_p_comparison'
  | 'comparison_forbidden'
  | 'case_selection_forbidden'

export type StepOneProcessLayer = 'G' | 'P'

/** Each suite step one may run, by its process layer as the module registry declares it. */
export const STEP_ONE_SUITE_LAYERS: Readonly<Record<StepOneRunSuite, StepOneProcessLayer>> = {
  'developer-capability.l5': 'P',
  'code-reviewer-quality.l5': 'P',
  'security-reviewer-quality.l5': 'P',
  'developer-capability-neutral.l5': 'G',
  'code-reviewer-quality-neutral.l5': 'G',
  'security-reviewer-quality-neutral.l5': 'G',
  'source-delivery-neutral.l5': 'G'
}
export type StepOneRefusal = { code: StepOneRefusalCode; detail: string }

/**
 * The renderer version a suite's trial records are made under: the current
 * Vinaya renderer version for a layer-`G` suite, and an empty string for a
 * layer-`P` suite, which has no renderer.
 */
export function rendererVersionOf(suite: StepOneRunSuite): string {
  return STEP_ONE_SUITE_LAYERS[suite] === 'G' ? VINAYA_RENDERER_VERSION : ''
}

const processOf = (suite: StepOneRunSuite) => ({
  layer: STEP_ONE_SUITE_LAYERS[suite],
  rendererVersion: rendererVersionOf(suite)
})

/** A trial's measured cost. `inputTokens` is uncached input for every adapter; cache reads and creations are counted apart. */
export interface StepOneUsage {
  wallTimeMs: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  subscriptionQuota: number | null
  estimatedCostUsd: number
}

type TraceCall = import('../../../tests/eval/tool-selection-suite').TraceCall

/**
 * The rate-limit window whose utilization a trial is charged against. Each
 * adapter reports several windows on one reading (Codex a primary and a
 * secondary window, Claude Code a five-hour and a seven-day one), and only
 * readings of the same window are compared.
 */
const QUOTA_WINDOW: Record<StepOneAdapter, string> = {
  codex: 'primary',
  'claude-code': 'five_hour'
}

/** Every value stored under `key` anywhere inside `value`. */
function valuesUnder(value: unknown, key: string): unknown[] {
  if (Array.isArray(value)) return value.flatMap((child) => valuesUnder(child, key))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([name, child]) =>
    name === key ? [child, ...valuesUnder(child, key)] : valuesUnder(child, key)
  )
}

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0

/** The utilization one vendor event reports for the adapter's charged window, or `null` when it reports none. */
function quotaReading(adapter: StepOneAdapter, event: unknown): number | null {
  const window = QUOTA_WINDOW[adapter]
  if (adapter === 'codex') {
    for (const limits of valuesUnder(event, 'rate_limits')) {
      const entry = (limits as Record<string, unknown> | null)?.[window] as Record<string, unknown> | undefined
      const used = entry?.used_percent ?? entry?.usedPercent
      if (finiteNonNegative(used)) return used
    }
    return null
  }
  for (const info of valuesUnder(event, 'rate_limit_info')) {
    const entry = info as Record<string, unknown> | null
    if (entry?.rateLimitType === window && finiteNonNegative(entry.utilization)) return entry.utilization
  }
  return null
}

/**
 * The subscription quota one trial consumed: the vendor's after reading minus
 * its before reading, both of the adapter's charged window and both taken from
 * that trial's own stream — the first and the last reading it reports. Equal
 * readings consumed zero. Without two readings of that window, or when the
 * window reset between them, the consumption is unavailable (`null`); it is
 * never inferred from any other number in the stream.
 */
export function subscriptionQuotaOf(adapter: StepOneAdapter, lines: readonly string[]): number | null {
  const readings: number[] = []
  for (const line of lines) {
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      // Vendor stdout can contain diagnostics; only structured telemetry counts.
      continue
    }
    const reading = quotaReading(adapter, event)
    if (reading !== null) readings.push(reading)
  }
  if (readings.length < 2) return null
  const before = readings[0] as number
  const after = readings.at(-1) as number
  return after < before ? null : after - before
}

/** Longest stored text of one unavailable trial's reason. */
const UNAVAILABLE_REASON_LIMIT = 500

/**
 * Why a trial is unavailable, as stored in the result: redacted with the Log's
 * own redaction and truncated, because the error can carry output of code the
 * trial's agent wrote.
 */
export function unavailableReason(prefix: string, error: unknown): string {
  const text = redact(`${prefix}: ${error instanceof Error ? error.message : String(error)}`, homedir())
  return text.length <= UNAVAILABLE_REASON_LIMIT ? text : `${text.slice(0, UNAVAILABLE_REASON_LIMIT)}…`
}

async function traceOf(adapter: StepOneAdapter, lines: readonly string[]): Promise<TraceCall[]> {
  const suite = await import('../../../tests/eval/tool-selection-suite')
  return adapter === 'claude-code' ? suite.claudeTrace(lines) : suite.codexTrace(lines)
}

/**
 * Claude Code's own harness tools, which exercise no neutral capability: the
 * turn-result emission, deferred-tool schema loading and the agent's own task
 * list. A layer-`G` trial record's trace leaves them out.
 */
export const CLAUDE_HARNESS_INTERNAL_TOOLS: readonly string[] = ['StructuredOutput', 'ToolSearch', 'TodoWrite']

/**
 * Claude Code's task-list and subagent built-ins, which exercise no neutral
 * capability of their own: the agent's task list, and the start, read and stop
 * of a subagent or background task. A subagent's own tool calls are in the
 * same stream and are traced as calls of their own. A layer-`G` trial
 * record's trace leaves these out too.
 */
export const CLAUDE_COORDINATION_TOOLS: readonly string[] = [
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskUpdate',
  'Agent',
  'Task',
  'TaskOutput',
  'TaskStop',
  'Workflow'
]

/**
 * The trace a layer-`G` trial record carries: `trace` without Claude Code's
 * harness-internal and coordination tools on the `claude-code` adapter,
 * unchanged on Codex. None of the dropped tools performs an effect, so the
 * effects step one counts are the same with or without them.
 */
export function layerGTrace(adapter: StepOneAdapter, trace: readonly TraceCall[]): TraceCall[] {
  return adapter === 'claude-code'
    ? trace.filter(
        (call) => !CLAUDE_HARNESS_INTERNAL_TOOLS.includes(call.tool) && !CLAUDE_COORDINATION_TOOLS.includes(call.tool)
      )
    : [...trace]
}

/** Step one's trace reader for a layer-`G` trial: the adapter transcript's calls, through `layerGTrace`. */
export async function layerGTraceOf(adapter: StepOneAdapter, lines: readonly string[]): Promise<TraceCall[]> {
  return layerGTrace(adapter, await traceOf(adapter, lines))
}

function performedEffects(
  trace: readonly TraceCall[],
  counts: Readonly<Record<string, number>>
): Array<{ operation: string; key: string }> {
  const remaining = { ...counts }
  const effects: Array<{ operation: string; key: string }> = []
  for (let index = trace.length - 1; index >= 0; index--) {
    const call = trace[index]
    if (call === undefined || (remaining[call.tool] ?? 0) < 1) continue
    effects.unshift({ operation: call.tool, key: JSON.stringify(call.args) })
    remaining[call.tool] = (remaining[call.tool] ?? 0) - 1
  }
  return effects
}

/** The Codex CLI every grading sandbox launches, pinned as the sandbox-conformance suite pins it. */
export const GRADING_CODEX_PACKAGE = '@openai/codex@0.160.0'

export interface GradingSandbox {
  /** The empty scratch directory: the child's home and temporary directory, always writable. */
  scratch: string
  /** The `codex sandbox` launch of `command`, writable only in the scratch directory and `writable`. */
  launch(command: readonly string[], writable: readonly string[]): { command: string[]; env: Record<string, string> }
  /** Runs `command` in the sandbox; throws, naming the exit and output tail, unless it exits 0. */
  run(command: readonly string[], cwd: string, writable: readonly string[], budgetMs: number): Promise<string>
  dispose(): void
}

export function resolveGradingCodex(toolRoot: string): string {
  // Never execute a `codex` selected through the controller's PATH. PATH is
  // operational configuration, not a provenance record, and an executable
  // planted there would run on the host before the grading sandbox existed.
  // Install the exact package named by the evaluation program into this
  // sandbox's host-only policy root and launch only that copy.
  mkdirSync(toolRoot, { recursive: true })
  const install = (offline: boolean) =>
    Bun.spawnSync(
      [
        process.execPath,
        'add',
        ...(offline ? ['--offline'] : []),
        '--silent',
        '--no-save',
        '--cwd',
        toolRoot,
        GRADING_CODEX_PACKAGE
      ],
      {
        cwd: toolRoot,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          LANG: process.env.LANG ?? 'C.UTF-8',
          HOME: toolRoot,
          TMPDIR: toolRoot,
          BUN_INSTALL_CACHE_DIR: join(homedir(), '.bun', 'install', 'cache')
        },
        stdout: 'pipe',
        stderr: 'pipe'
      }
    )
  // CI and development hosts normally already carry Bun's pinned package
  // cache. Prefer it so grading startup does not require the network; only a
  // cache miss may fetch the same exact version from the registry.
  let installedPackage = install(true)
  if (installedPackage.exitCode !== 0) installedPackage = install(false)
  if (installedPackage.exitCode !== 0) {
    throw new Error(
      `grading unavailable: Codex CLI could not be resolved: ${installedPackage.stderr.toString().slice(-2000)}`
    )
  }
  const executable = join(toolRoot, 'node_modules', '.bin', 'codex')
  if (!existsSync(executable)) throw new Error('grading unavailable: installed Codex CLI has no executable')
  return realpathSync(executable)
}

/** The setting that moves step one's working folders; tests point it at their own fixture directory. */
export const STEP_ONE_WORK_ROOT_ENV = 'VINAYA_STEP_ONE_TMP'

/**
 * Where step one's trial, grading and sandbox folders live: a disk folder under this repo's runtime area, never the
 * OS temp folder, which on a host with a small, quota-limited tmpfs fills with clones and refuses every later write.
 */
export function stepOneWorkRoot(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const configured = env[STEP_ONE_WORK_ROOT_ENV]
  const root = configured !== undefined && configured !== '' ? configured : join(runtimeDirForThisRepo(), 'step-one')
  mkdirSync(root, { recursive: true })
  return root
}

/**
 * Opens the one confinement every step over a trial's workspace runs in:
 * `codex sandbox` with network disabled, `/tmp` and `$TMPDIR` excluded, and
 * writable roots limited to an empty scratch directory plus the directory the
 * step works on. The policy home is staged by `stageCodexPolicyHome` from a
 * throwaway home holding a placeholder login, outside every writable root, and
 * the child environment is `PATH`, `LANG`, `HOME` and `TMPDIR` (both the
 * scratch directory) and `CODEX_HOME`. No forge, log or vendor token reaches it.
 */
export function openGradingSandbox(): GradingSandbox {
  const policyRoot = realpathSync(mkdtempSync(join(stepOneWorkRoot(), 'step-one-grading-policy-')))
  const scratch = realpathSync(mkdtempSync(join(stepOneWorkRoot(), 'step-one-grading-scratch-')))
  const dispose = () => {
    rmSync(policyRoot, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
  const throwawayHome = join(policyRoot, 'home')
  const codexExecutable = resolveGradingCodex(join(policyRoot, 'tool'))
  if (!isAbsolute(codexExecutable)) {
    dispose()
    throw new Error('grading unavailable: Codex CLI did not resolve to an absolute path')
  }
  mkdirSync(join(throwawayHome, '.codex'), { recursive: true })
  writeFileSync(join(throwawayHome, '.codex', 'auth.json'), '{}\n', {
    mode: 0o600
  })
  const staged = stageCodexPolicyHome({
    targetDir: join(policyRoot, 'codex-home'),
    realHome: throwawayHome,
    execpolicyRules: buildCodexExecpolicyRules('developer') ?? '',
    sandboxConfigToml: 'sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nnetwork_access = false\n'
  })
  if (staged === null) {
    dispose()
    throw new Error('grading unavailable: Codex policy home could not be staged')
  }
  const codexHome = codexSpawnEnvExtras('codex', staged.codexHome, scratch).attribution.CODEX_HOME as string
  const launch: GradingSandbox['launch'] = (command, writable) => {
    for (const root of [scratch, ...writable]) {
      const fromRoot = relative(realpathSync(root), codexExecutable)
      if (fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))) {
        throw new Error('grading unavailable: Codex CLI resolves inside a writable root')
      }
    }
    return {
      command: [
        codexExecutable,
        ...addCodexWritableDirs(
          [
            'sandbox',
            '--config',
            'sandbox_mode="workspace-write"',
            '--config',
            'sandbox_workspace_write.network_access=false',
            '--config',
            'sandbox_workspace_write.exclude_slash_tmp=true',
            '--config',
            'sandbox_workspace_write.exclude_tmpdir_env_var=true'
          ],
          [scratch, ...writable],
          true
        ),
        '--',
        ...command
      ],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        HOME: scratch,
        TMPDIR: scratch,
        CODEX_HOME: codexHome
      }
    }
  }
  return {
    scratch,
    launch,
    async run(command, cwd, writable, budgetMs) {
      const launched = launch(command, writable)
      const child = Bun.spawn(launched.command, {
        cwd,
        env: launched.env,
        stdout: 'pipe',
        stderr: 'pipe'
      })
      const timer = setTimeout(() => child.kill('SIGKILL'), budgetMs)
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      const code = await child.exited
      clearTimeout(timer)
      if (code !== 0)
        throw new Error(`\`${command.join(' ')}\` exited ${code} in codex sandbox: ${stderr.slice(-2000)}`)
      return stdout
    },
    dispose
  }
}

/** The `runTests` isolation that runs a test runner in `sandbox`, writable only in its scratch and `target`. */
export function gradingIsolation(sandbox: GradingSandbox, target: string) {
  return (command: readonly string[], _cwd: string, _reportDirectory: string) => sandbox.launch(command, [target])
}

/**
 * The production grading entry point: runs `testFiles` of the grading copy
 * with their own runners inside `sandbox`, their reports written to its
 * scratch directory.
 */
export async function gradeInSandbox(
  sandbox: GradingSandbox,
  gradingCopy: string,
  testFiles: readonly string[],
  timeoutMs: number
): Promise<import('../../../tests/eval/developer-capability-suite').TestResult[]> {
  const suite = await import('../../../tests/eval/developer-capability-suite')
  return suite.runTests(gradingCopy, testFiles, timeoutMs, gradingIsolation(sandbox, gradingCopy), sandbox.scratch)
}

export interface StepOneTrialResult {
  success: boolean
  unavailableReason?: string
  /** The trial's process layer and the renderer version its record was made under (see `rendererVersionOf`). */
  layer: StepOneProcessLayer
  rendererVersion: string
  usage: StepOneUsage
}

/**
 * Which tasks of each suite a practice run runs: the first `count` development
 * tasks in the suite's pinned order, or the named development task ids.
 */
export type StepOneCaseSelection = { count: number } | { ids: readonly string[] }

export interface StepOneSuiteInput {
  suite: StepOneRunSuite
  taskIds: readonly string[]
}

export interface StepOneOptions {
  split: 'development' | 'held-out'
  backend: 'standalone' | 'engine'
  /** `development-only` when absent. */
  purpose?: StepOnePurpose
  /** The suites to run; when absent, the comparison suites for `comparison` and `STEP_ONE_SUITES` otherwise. */
  suites?: readonly string[]
  /** The adapters to run; both of `STEP_ONE_ADAPTERS` when absent. */
  adapters?: readonly string[]
  /** The tasks to run, accepted only on a practice run; every development task when absent. */
  cases?: StepOneCaseSelection
  trialsPerTask: number
  bootstrap: {
    method: BootstrapMethod
    seed: number
    resamples: number
    confidence: number
  }
  pricing?: { inputUsdPerMillion: number; outputUsdPerMillion: number }
}

export interface StepOneResult {
  kind: 'development-standalone-step-one'
  split: 'development'
  backend: 'standalone'
  purpose: StepOnePurpose
  trialsPerTask: number
  runs: Array<{
    suite: StepOneRunSuite
    split: 'development'
    backend: 'standalone'
    adapter: StepOneAdapter
    /** The suite's process layer and the renderer version its trial records were made under. */
    layer: StepOneProcessLayer
    rendererVersion: string
    taskCount: number
    trialsPerTask: number
    tasks: Array<{
      taskId: string
      successes: number
      trials: number
      unavailable: string[]
    }>
    mean: number
    interval: { lower: number; upper: number }
    /** Subscription quota sums only trials with both readings; this many trials had no reading pair. */
    usage: StepOneUsage
    quotaUnavailableTrials: number
  }>
}

export type StepOneOutcome = { ok: true; value: StepOneResult } | { ok: false; refusal: StepOneRefusal }
export type StepOneExecutor = (input: {
  suite: StepOneRunSuite
  adapter: StepOneAdapter
  taskId: string
  attempt: number
}) => Promise<StepOneTrialResult>

const refusal = (code: StepOneRefusalCode, detail: string): StepOneOutcome => ({
  ok: false,
  refusal: { code, detail }
})

const isRunSuite = (suite: string): suite is StepOneRunSuite => Object.hasOwn(STEP_ONE_SUITE_LAYERS, suite)

/**
 * The suites a step-one request runs, or its refusal. Comparison evidence
 * comes only from the comparison suites: a layer-`P` suite named as
 * comparison evidence is refused, and so is a layer-`G` suite admitted only
 * for development-only and practice runs. A practice run has one trial per
 * task.
 */
export function selectStepOneSuites(
  purpose: StepOnePurpose,
  suites: readonly string[] | undefined,
  trialsPerTask: number
): { ok: true; suites: StepOneRunSuite[] } | { ok: false; refusal: StepOneRefusal } {
  const fail = (code: StepOneRefusalCode, detail: string) => ({ ok: false as const, refusal: { code, detail } })
  if (!(STEP_ONE_PURPOSES as readonly string[]).includes(purpose)) {
    return fail('invalid_input', `purpose must be one of ${STEP_ONE_PURPOSES.join(', ')}`)
  }
  const requested = suites ?? (purpose === 'comparison' ? STEP_ONE_COMPARISON_SUITES : STEP_ONE_SUITES)
  if (requested.length === 0) return fail('invalid_input', 'a step-one run names at least one suite')
  for (const suite of requested) {
    if (!isRunSuite(suite)) return fail('invalid_input', `${suite} is not a step-one suite`)
    if (purpose !== 'comparison') continue
    if (STEP_ONE_SUITE_LAYERS[suite] === 'P') {
      return fail('layer_p_comparison', `${suite} is a layer-P suite, and only layer-G suites are comparison evidence`)
    }
    if (!(STEP_ONE_COMPARISON_SUITES as readonly string[]).includes(suite)) {
      return fail('comparison_forbidden', `${suite} runs only for development-only and practice results`)
    }
  }
  if (purpose === 'practice' && trialsPerTask !== 1) {
    return fail('invalid_input', 'a practice run carries exactly one trial per task')
  }
  return { ok: true, suites: [...new Set(requested as readonly StepOneRunSuite[])] }
}

/**
 * The adapters a step-one request runs, or its refusal. Both adapters run
 * when none is named. A case selection is accepted only on a practice run,
 * and a count must be a whole number of at least 1; both checks read no
 * suite input.
 */
export function selectStepOneTrials(
  purpose: StepOnePurpose,
  adapters: readonly string[] | undefined,
  cases: StepOneCaseSelection | undefined
): { ok: true; adapters: StepOneAdapter[] } | { ok: false; refusal: StepOneRefusal } {
  const fail = (code: StepOneRefusalCode, detail: string) => ({ ok: false as const, refusal: { code, detail } })
  const requested = adapters ?? STEP_ONE_ADAPTERS
  if (requested.length === 0) return fail('invalid_input', 'a step-one run names at least one adapter')
  for (const adapter of requested) {
    if (!(STEP_ONE_ADAPTERS as readonly string[]).includes(adapter)) {
      return fail('invalid_input', `${adapter} is not a step-one adapter; use one of ${STEP_ONE_ADAPTERS.join(', ')}`)
    }
  }
  if (cases !== undefined) {
    if (purpose !== 'practice') {
      return fail('case_selection_forbidden', `a case selection is accepted only on a practice run, not ${purpose}`)
    }
    if ('count' in cases && (!Number.isInteger(cases.count) || cases.count < 1)) {
      return fail('invalid_input', 'a case count must be a whole number of at least 1')
    }
    if ('ids' in cases && cases.ids.length === 0) return fail('invalid_input', 'a case selection names at least one id')
  }
  return {
    ok: true,
    adapters: STEP_ONE_ADAPTERS.filter((adapter) => (requested as readonly string[]).includes(adapter))
  }
}

/**
 * The tasks of one suite a selection runs, in the suite's pinned order, or
 * the refusal naming a case id outside the suite's development split.
 */
function selectedTaskIds(
  suite: StepOneRunSuite,
  taskIds: readonly string[],
  cases: StepOneCaseSelection | undefined
): { ok: true; taskIds: string[] } | { ok: false; refusal: StepOneRefusal } {
  if (cases === undefined) return { ok: true, taskIds: [...taskIds] }
  if ('count' in cases) return { ok: true, taskIds: taskIds.slice(0, cases.count) }
  for (const id of cases.ids) {
    if (!taskIds.includes(id)) {
      return {
        ok: false,
        refusal: { code: 'invalid_input', detail: `${id} is not a development case of ${suite}` }
      }
    }
  }
  return { ok: true, taskIds: taskIds.filter((id) => cases.ids.includes(id)) }
}

/**
 * Runs milestone step one only. The split, backend, suite, adapter and case
 * selection checks precede every access to suite inputs, so a refused
 * invocation cannot open held-out data.
 */
export async function runStepOne(
  options: StepOneOptions,
  loadDevelopmentSuites: () => readonly StepOneSuiteInput[] | Promise<readonly StepOneSuiteInput[]>,
  execute: StepOneExecutor
): Promise<StepOneOutcome> {
  if (options.split !== 'development') return refusal('held_out_forbidden', 'step one may read only development splits')
  if (options.backend !== 'standalone')
    return refusal('engine_forbidden', 'step one runs only on the standalone backend')
  if (!Number.isInteger(options.trialsPerTask) || options.trialsPerTask < 1)
    return refusal('invalid_input', 'trialsPerTask must be a positive integer')
  const purpose = options.purpose ?? 'development-only'
  const selected = selectStepOneSuites(purpose, options.suites, options.trialsPerTask)
  if (!selected.ok) return selected
  const trials = selectStepOneTrials(purpose, options.adapters, options.cases)
  if (!trials.ok) return trials

  const suites = await loadDevelopmentSuites()
  // Every suite's tasks are resolved before any trial runs, so a refused
  // selection runs nothing.
  const planned: Array<{ suite: StepOneRunSuite; taskIds: string[] }> = []
  for (const suite of selected.suites) {
    const input = suites.find((entry) => entry.suite === suite)
    if (input === undefined || input.taskIds.length === 0)
      return refusal('empty_development_split', `${suite} has no reconstructable development task`)
    const taskIds = selectedTaskIds(suite, input.taskIds, options.cases)
    if (!taskIds.ok) return taskIds
    planned.push({ suite, taskIds: taskIds.taskIds })
  }
  const runs: StepOneResult['runs'] = []
  for (const { suite, taskIds } of planned) {
    for (const adapter of trials.adapters) {
      const tasks: Array<{
        taskId: string
        successes: number
        trials: number
        unavailable: string[]
      }> = []
      const usage: StepOneUsage = {
        wallTimeMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        subscriptionQuota: 0,
        estimatedCostUsd: 0
      }
      let quotaUnavailableTrials = 0
      for (const taskId of taskIds) {
        let successes = 0
        const unavailable: string[] = []
        for (let attempt = 1; attempt <= options.trialsPerTask; attempt++) {
          const trial = await execute({ suite, adapter, taskId, attempt })
          if (trial.success) successes++
          if (trial.unavailableReason !== undefined) unavailable.push(trial.unavailableReason)
          usage.wallTimeMs += trial.usage.wallTimeMs
          usage.inputTokens += trial.usage.inputTokens
          usage.outputTokens += trial.usage.outputTokens
          usage.cacheReadTokens += trial.usage.cacheReadTokens
          usage.cacheCreationTokens += trial.usage.cacheCreationTokens
          usage.estimatedCostUsd +=
            trial.usage.estimatedCostUsd ||
            (trial.usage.inputTokens * (options.pricing?.inputUsdPerMillion ?? 0) +
              trial.usage.outputTokens * (options.pricing?.outputUsdPerMillion ?? 0)) /
              1_000_000
          if (trial.usage.subscriptionQuota === null) quotaUnavailableTrials++
          else usage.subscriptionQuota = (usage.subscriptionQuota ?? 0) + trial.usage.subscriptionQuota
        }
        tasks.push({
          taskId,
          successes,
          trials: options.trialsPerTask,
          unavailable
        })
      }
      const estimate = suiteMean(tasks, options.bootstrap)
      if (!estimate.ok) return refusal('invalid_input', estimate.refusal.detail)
      runs.push({
        suite,
        split: 'development',
        backend: 'standalone',
        adapter,
        ...processOf(suite),
        taskCount: tasks.length,
        trialsPerTask: options.trialsPerTask,
        tasks,
        mean: estimate.value.mean,
        interval: estimate.value.interval,
        usage: {
          ...usage,
          subscriptionQuota:
            quotaUnavailableTrials === tasks.length * options.trialsPerTask ? null : usage.subscriptionQuota
        },
        quotaUnavailableTrials
      })
    }
  }
  return {
    ok: true,
    value: {
      kind: 'development-standalone-step-one',
      split: 'development',
      backend: 'standalone',
      purpose,
      trialsPerTask: options.trialsPerTask,
      runs
    }
  }
}

type DeveloperCase = import('../../../tests/eval/developer-capability-suite').DeveloperCapabilityCase
type ReviewCase = import('../../../tests/eval/reviewer-quality-suite').ReviewCase
type SourceCitationCase = import('../../../tests/eval/source-citation-suite').SourceCitationCase
type WorldState = ReturnType<import('../../../tests/eval/tool-selection-suite').World['state']>
type TestOutcomes = import('../../../tests/eval/developer-capability-suite').TestOutcomes
type LayerGSuite = StepOneComparisonSuite | (typeof STEP_ONE_PRACTICE_SUITES)[number]

/**
 * The development inputs step one runs on. Each layer-`G` suite's neutral
 * cases come with the layer-`P` cases of the same ids, which hold what a live
 * trial needs and a neutral case does not carry: a change case's hidden tests,
 * a review case's patch, an answer case's document contents.
 */
export interface LoadedDevelopment {
  suites: StepOneSuiteInput[]
  developerCases: DeveloperCase[]
  reviewerCases: ReviewCase[]
  neutralCases: Partial<Record<LayerGSuite, NeutralCase[]>>
  sourceCitationCases: SourceCitationCase[]
}

/** Development inputs with nothing loaded. */
export const NO_DEVELOPMENT: LoadedDevelopment = {
  suites: [],
  developerCases: [],
  reviewerCases: [],
  neutralCases: {},
  sourceCitationCases: []
}

export interface StepOneCommandRuntime {
  loadDevelopment(): Promise<LoadedDevelopment>
  execute(input: Parameters<StepOneExecutor>[0], context: StepOneCommandContext): Promise<StepOneTrialResult>
}

export interface StepOneCommandContext {
  repository: string
  developerBriefs: ReadonlyMap<number, string>
  models: Partial<Record<StepOneAdapter, string>>
  timeoutMs: number
  loaded: LoadedDevelopment
  /** Container mode for layer-`G` trials; absent, every trial runs on the host as it always has. */
  container?: StepOneContainer
}

/**
 * Container mode: a layer-`G` trial runs inside a container that is its own
 * sandbox, as one task. The role runs directly in `workingTree`, at the base
 * commit already checked out there, and its commit lands on that tree's
 * `HEAD`; the hidden tests and the reference commit are not in the container,
 * so the verifier outside it grades the trial, from the tree's diff against
 * the base commit and from the trial record written to `recordPath`.
 */
export interface StepOneContainer {
  /** The working tree the role runs in: `/app` in a trial container. */
  workingTree: string
  /** Where the run writes the trial record it produced, for the verifier. */
  recordPath: string
  /**
   * The backend a `change` or `review` case's role step runs on: `standalone`
   * (`dispatchRole`) when absent, or `engine`, a one-step Flow on the Atta
   * Engine runtime (`runEngineRoleStep`). Only a container trial takes the
   * Engine backend; `runStepOne` refuses it on the host.
   */
  backend?: StepOneBackend
  /**
   * Where the run appends the role's agent stream, one line as each arrives,
   * so a trial stopped before it records anything still leaves its stream.
   * Absent, the stream is kept in memory only. An `answer` turn's stream is
   * appended once the turn returns, since that turn hands back its whole
   * output at its end.
   */
  streamPath?: string
}

/**
 * A container trial's stream-line observer: keeps each line in `transcript`
 * and, when the container names a stream file, appends it there at once.
 */
function streamObserver(transcript: string[], container: StepOneContainer | undefined): (line: string) => void {
  const path = container?.streamPath
  return (line) => {
    transcript.push(line)
    if (path !== undefined) appendFileSync(path, `${line}\n`)
  }
}

/** The backends a container trial's role step runs on. */
export const STEP_ONE_BACKENDS = ['standalone', 'engine'] as const
export type StepOneBackend = (typeof STEP_ONE_BACKENDS)[number]

/** The record a container trial writes for its verifier: the trial record and the backend its role ran on. */
export type ContainerTrialRecord = VinayaTrialRecord & { backend: StepOneBackend }

const adapterVendor = (adapter: StepOneAdapter): AgentVendor => (adapter === 'claude-code' ? 'claude' : 'codex')
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

async function loadProductionDevelopment(): Promise<LoadedDevelopment> {
  const developer = await import('../../../tests/eval/developer-capability-suite')
  const reviewers = await import('../../../tests/eval/reviewer-quality-suite')
  const generic = await import('../../../tests/eval/generic-suites')
  const citation = await import('../../../tests/eval/source-citation-suite')
  const developerFile = developer.loadCaseFile()
  const developerSuite = developer.suiteFor(developerFile)
  const developerCases = developerFile.cases
  const codeFile = reviewers.loadDevelopment('code-reviewer')
  const securityFile = reviewers.loadDevelopment('security-reviewer')
  const code = codeFile.cases
  const security = securityFile.cases
  const codeSuite = reviewers.harnessSuite('code-reviewer', codeFile)
  const securitySuite = reviewers.harnessSuite('security-reviewer', securityFile)
  if (!codeSuite.ok) throw new Error(`code reviewer harness suite refused: ${JSON.stringify(codeSuite.refusal)}`)
  if (!securitySuite.ok)
    throw new Error(`security reviewer harness suite refused: ${JSON.stringify(securitySuite.refusal)}`)
  const neutralSuites = [
    ['developer-capability-neutral.l5', 'developer'],
    ['code-reviewer-quality-neutral.l5', 'codeReviewer'],
    ['security-reviewer-quality-neutral.l5', 'securityReviewer'],
    ['source-delivery-neutral.l5', 'sourceCitation']
  ] as const
  return {
    suites: [
      {
        suite: 'developer-capability.l5',
        taskIds: developerSuite.splits.development
      },
      {
        suite: 'code-reviewer-quality.l5',
        taskIds: codeSuite.value.splits.development
      },
      {
        suite: 'security-reviewer-quality.l5',
        taskIds: securitySuite.value.splits.development
      },
      ...neutralSuites.map(([suite, key]) => ({ suite, taskIds: generic.genericSuite(key).splits.development }))
    ],
    developerCases,
    reviewerCases: [...code, ...security],
    neutralCases: Object.fromEntries(neutralSuites.map(([suite, key]) => [suite, generic.developmentCases(key)])),
    sourceCitationCases: citation.loadCaseFile().cases
  }
}

function fileAt(repository: string, commit: string, path: string): Uint8Array {
  const result = Bun.spawnSync(['git', 'show', `${commit}:${path}`], {
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (result.exitCode !== 0) throw new Error(`cannot read pinned file ${commit}:${path}`)
  return result.stdout
}

function hiddenInputs(repository: string, item: DeveloperCase): HiddenInputs {
  return {
    failToPassTests: Object.fromEntries(
      item.hiddenTests.files.map((entry) => [entry.path, fileAt(repository, item.referenceCommit, entry.path)])
    ),
    referenceSolution: Object.fromEntries(
      item.referenceSolution.files.map((entry) => [entry.path, fileAt(repository, item.referenceCommit, entry.path)])
    ),
    pinnedPassToPassTests: Object.fromEntries(
      item.passToPassFiles.map((entry) => [entry.path, fileAt(repository, item.baseCommit, entry.path)])
    )
  }
}

const INSTALL_COMMAND = ['bun', 'install', '--frozen-lockfile', '--ignore-scripts', '--silent']

/** Longest one sandboxed install or commit step may run. */
const SANDBOX_STEP_BUDGET_MS = 600_000

/**
 * Fills the sandbox's package cache (under its scratch home) from the base
 * commit, cloned from the pinned repository and never from the trial's
 * workspace, so every install over the trial runs in the sandbox with
 * network disabled.
 */
async function warmPackageCache(sandbox: GradingSandbox, repository: string, baseCommit: string): Promise<void> {
  const parent = mkdtempSync(join(stepOneWorkRoot(), 'step-one-base-'))
  try {
    const checkout = join(parent, 'repository')
    git(parent, [
      'clone',
      '--quiet',
      '--no-local',
      '--no-tags',
      '--template=',
      `--revision=${baseCommit}`,
      '--',
      repository,
      checkout
    ])
    const run = Bun.spawn(INSTALL_COMMAND, {
      cwd: checkout,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HOME: sandbox.scratch,
        TMPDIR: parent
      },
      stdout: 'pipe',
      stderr: 'pipe'
    })
    const [, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text()])
    if ((await run.exited) !== 0) throw new Error(`base dependency installation failed: ${stderr.slice(-2000)}`)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

/**
 * The sandboxed step that commits a trial's work in its own worktree: it
 * stages and commits any uncommitted change, then prints the commit `HEAD`
 * names. A trial whose agent already committed its work is left as it is.
 */
export const TRIAL_COMMIT_SCRIPT = [
  'set -e',
  'g() { git -c core.hooksPath=/dev/null -c core.fsmonitor= --no-optional-locks "$@"; }',
  'if [ -n "$(g status --porcelain)" ]; then',
  '  g add -A',
  '  g -c user.name=\'Vinaya Evaluation\' -c user.email=eval@invalid.local commit --quiet --no-verify -m "$1"',
  'fi',
  'head=$(g rev-parse HEAD)',
  'if [ "$head" = "$3" ]; then',
  '  printf \'trial-commit %s\\n\' "$head"',
  '  exit 0',
  'fi',
  'g bundle create "$2" "$3"..HEAD',
  'printf \'trial-commit %s\\n\' "$head"'
].join('\n')

/** Commits the trial's work inside `sandbox`; returns the step's output for `verifyTrialCommit`. */
export function commitTrialInSandbox(
  sandbox: GradingSandbox,
  staging: CloneStaging,
  message: string,
  bundlePath = join(sandbox.scratch, 'trial.bundle')
): Promise<string> {
  return sandbox.run(
    ['/bin/sh', '-c', TRIAL_COMMIT_SCRIPT, 'commit-trial', message, bundlePath, staging.baseCommit],
    staging.workspace,
    [staging.workspace, staging.gitDir],
    SANDBOX_STEP_BUDGET_MS
  )
}

export type TrialCommit = { ok: true; commit: string } | { ok: false; reason: string }

/**
 * Reads the trial commit from the sandboxed commit step's output. The host
 * never verifies it against the trial repository; `importTrialBundle` verifies
 * the sandbox-created handoff in a new repository instead.
 */
export function verifyTrialCommit(staging: Pick<CloneStaging, 'baseCommit'>, output: string): TrialCommit {
  const reported = [...output.matchAll(/^trial-commit ([0-9a-f]{40}|[0-9a-f]{64})$/gm)].at(-1)?.[1]
  if (reported === undefined)
    return {
      ok: false,
      reason: 'the sandboxed commit step reported no commit'
    }
  if (reported === staging.baseCommit)
    return {
      ok: false,
      reason: 'Developer trial has no commit ahead of its base'
    }
  return { ok: true, commit: reported }
}

/**
 * Imports the sandbox-created bundle into a fresh repository whose base comes
 * only from the controller's pinned source repository. Every Git invocation
 * is isolated from system/global configuration, hooks, filesystem monitors
 * and transport helpers. No host Git process opens the trial repository.
 */
export function importTrialBundle(request: {
  repository: string
  baseCommit: string
  reportedCommit: string
  bundlePath: string
  parentDirectory: string
}): string {
  const target = join(request.parentDirectory, 'submitted')
  mkdirSync(target)
  const safeGit = (args: readonly string[]) =>
    git(target, ['-c', 'protocol.allow=never', '-c', 'include.path=/dev/null', ...args])
  safeGit(['init', '--quiet'])
  // `--stdin` supplies the trusted base as a pack directly; no transport or
  // repository-local configuration from the trial is consulted.
  const basePack = Bun.spawnSync(
    [
      'git',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=',
      '--no-optional-locks',
      'pack-objects',
      '--stdout',
      '--revs'
    ],
    {
      cwd: request.repository,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null'
      },
      stdin: Buffer.from(`${request.baseCommit}\n`),
      stdout: 'pipe',
      stderr: 'pipe'
    }
  )
  if (basePack.exitCode !== 0) throw new Error('could not read the pinned base from the trusted repository')
  const unpack = Bun.spawnSync(
    [
      'git',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=',
      '--no-optional-locks',
      '-c',
      'protocol.allow=never',
      'unpack-objects',
      '-r'
    ],
    {
      cwd: target,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null'
      },
      stdin: basePack.stdout,
      stdout: 'pipe',
      stderr: 'pipe'
    }
  )
  if (unpack.exitCode !== 0) throw new Error('could not install the pinned base in the grading repository')
  safeGit(['update-ref', 'refs/heads/base', request.baseCommit])
  safeGit(['-c', 'protocol.file.allow=always', 'fetch', '--quiet', '--no-tags', request.bundlePath, 'HEAD'])
  const fetched = safeGit(['rev-parse', 'FETCH_HEAD']).trim()
  if (fetched !== request.reportedCommit) throw new Error('the trial bundle head differs from the sandbox report')
  if (safeGit(['cat-file', '-t', fetched]).trim() !== 'commit') throw new Error('the trial bundle head is not a commit')
  try {
    safeGit(['merge-base', '--is-ancestor', request.baseCommit, fetched])
  } catch {
    throw new Error('the trial bundle head does not descend from its base')
  }
  safeGit(['update-ref', 'refs/heads/submitted', fetched])
  safeGit(['symbolic-ref', 'HEAD', 'refs/heads/submitted'])
  safeGit(['reset', '--hard', '--quiet', fetched])
  return target
}

/**
 * A dispatch's tokens as step-one usage. Codex counts its cached input inside
 * `input_tokens`, which the handle's `usage.input` keeps raw, so the cache read
 * is subtracted here to leave uncached input; Claude's `input_tokens` already
 * excludes cache.
 */
function tokensOf(
  adapter: StepOneAdapter,
  handle: {
    usage: { input: number; output: number } | null
    cacheUsage?: { read: number; creation: number } | null
  }
): Pick<StepOneUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'> {
  const input = handle.usage?.input ?? 0
  const cacheReadTokens = handle.cacheUsage?.read ?? 0
  return {
    inputTokens: adapter === 'codex' ? Math.max(0, input - cacheReadTokens) : input,
    outputTokens: handle.usage?.output ?? 0,
    cacheReadTokens,
    cacheCreationTokens: handle.cacheUsage?.creation ?? 0
  }
}

/**
 * A trial's usage. Its tokens are read from the role's own stream
 * (`usageOfStream`), which counts every assistant message even when the run
 * was stopped, or threw, before the stream's closing event; a stream with no
 * usage falls back to the dispatch handle's.
 */
export function trialUsage(
  adapter: StepOneAdapter,
  handle: {
    durationMs: number
    usage: { input: number; output: number } | null
    cacheUsage?: { read: number; creation: number } | null
  } | null,
  transcript: readonly string[]
): StepOneUsage {
  const streamed = usageOfStream(adapter, transcript)
  return {
    wallTimeMs: handle?.durationMs ?? 0,
    ...(streamed.usage !== null
      ? tokensOf(adapter, streamed)
      : handle === null
        ? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }
        : tokensOf(adapter, handle)),
    subscriptionQuota: handle === null ? 0 : subscriptionQuotaOf(adapter, transcript),
    estimatedCostUsd: 0
  }
}

/** A trial with no usage measured: nothing was dispatched. */
const NO_USAGE: StepOneUsage = {
  wallTimeMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  subscriptionQuota: null,
  estimatedCostUsd: 0
}

/**
 * Documents a Developer trial is delivered by injection: each one's content at
 * the base commit, its prepared source entry and the controller's receipt.
 */
async function injectedSources(repository: string, baseCommit: string, sourceIds: readonly string[]) {
  const sourceManifest = await import('../source-manifest')
  const preparedAt = new Date(0).toISOString()
  const sources = sourceIds.map((sourceId) => {
    const content = fileAt(repository, baseCommit, sourceId)
    return {
      sourceId,
      canonicalUri: `repository:${sourceId}`,
      requirementText: sourceId,
      governs: 'the mechanism named by the frozen brief',
      objectiveIds: [],
      retrievedAt: preparedAt,
      versionOrRevision: baseCommit,
      contentDigest: sourceManifest.sha256Digest(content),
      mediaType: 'text/plain',
      deliveryMode: 'injected' as const,
      snapshotRef: `git:blob:${digest(Buffer.from(content).toString())}`,
      freshnessPolicy: 'pinned' as const,
      trustClassification: 'repository' as const
    }
  })
  const receipts = sources.map((source) => ({
    schemaVersion: 1 as const,
    sourceId: source.sourceId,
    source: source.sourceId,
    round: 1,
    recordedAt: preparedAt,
    mode: 'injected' as const,
    recordedBy: 'controller' as const,
    pinnedDigest: source.contentDigest,
    deliveredDigest: source.contentDigest,
    revision: 'match' as const,
    decision: 'counted' as const
  }))
  const contents = new Map(
    sourceIds.map((sourceId) => [sourceId, Buffer.from(fileAt(repository, baseCommit, sourceId)).toString('utf8')])
  )
  return { preparedAt, sources, receipts, contents }
}

/** What one Developer trial recorded, once its commit was imported and its hidden tests ran in the sandbox. */
interface DeveloperRun {
  handle: Awaited<ReturnType<typeof dispatchRole>>
  trace: TraceCall[]
  toolState: WorldState
  commit: string
  /** The fresh repository the trial's commit was imported into. */
  submitted: string
  outcomes: TestOutcomes
  changedPaths: string[]
}

type Staged<T> =
  | { ok: true; value: T; usage: StepOneUsage }
  | { ok: false; unavailableReason: string; usage: StepOneUsage }

type ReadOnlyDeveloperTurn = typeof import('../../../tests/eval/source-citation-suite').readOnlyDeveloperTurn

/**
 * The steps a live trial takes, each a seam: production passes the real ones
 * (`PRODUCTION_VINAYA_PROCESS_STEPS`), and a test passes recording fakes, so
 * which steps a run calls is observable without a model, a sandbox or a
 * container.
 */
export interface VinayaProcessSteps {
  dispatch: typeof dispatchRole
  readOnlyTurn: (...args: Parameters<ReadOnlyDeveloperTurn>) => Promise<ReturnType<ReadOnlyDeveloperTurn>>
  startToolHost: typeof startDevToolsHost
  stageTrial: typeof stageTrial
  hiddenInputs: typeof hiddenInputs
  testContamination: typeof testContamination
  openGradingSandbox: typeof openGradingSandbox
  warmPackageCache: typeof warmPackageCache
  commitTrialInSandbox: typeof commitTrialInSandbox
  importTrialBundle: typeof importTrialBundle
  prepareGradingCopy: typeof prepareGradingCopy
  gradeInSandbox: typeof gradeInSandbox
  /** The spawn an Engine role step launches its agent with; a test passes a stub agent. */
  engineSpawn: SpawnFn
}

export const PRODUCTION_VINAYA_PROCESS_STEPS: VinayaProcessSteps = {
  dispatch: dispatchRole,
  readOnlyTurn: async (...args) =>
    (await import('../../../tests/eval/source-citation-suite')).readOnlyDeveloperTurn(...args),
  startToolHost: startDevToolsHost,
  stageTrial,
  hiddenInputs,
  testContamination,
  openGradingSandbox,
  warmPackageCache,
  commitTrialInSandbox,
  importTrialBundle,
  prepareGradingCopy,
  gradeInSandbox,
  engineSpawn: ENGINE_SPAWN
}

/**
 * Runs one Developer trial of `item` with `prompt`: stages a clone at the
 * base commit, installs dependencies in the sandbox, dispatches the Developer
 * with the driver-run tools, commits its work in the sandbox, imports the
 * commit into a fresh repository, and runs the hidden and pass-to-pass tests
 * in the sandbox. `finish` reads the run while its directories still exist.
 */
async function runDeveloperTrial<T>(
  input: Parameters<StepOneExecutor>[0],
  context: StepOneCommandContext,
  item: DeveloperCase,
  prompt: string,
  finish: (run: DeveloperRun) => T,
  steps: VinayaProcessSteps = PRODUCTION_VINAYA_PROCESS_STEPS
): Promise<Staged<T>> {
  const suite = await import('../../../tests/eval/developer-capability-suite')
  const parent = mkdtempSync(join(stepOneWorkRoot(), 'step-one-developer-'))
  const submissionParent = mkdtempSync(join(stepOneWorkRoot(), 'step-one-submission-'))
  const gradingParent = mkdtempSync(join(stepOneWorkRoot(), 'step-one-grading-'))
  const hidden = steps.hiddenInputs(context.repository, item)
  const staging = steps.stageTrial({
    trialId: `${item.id}.${input.adapter}.${input.attempt}`,
    sourceRepository: context.repository,
    baseCommit: item.baseCommit,
    parentDirectory: parent,
    mode: 'clone',
    taskBranch: `task/eval/${item.pullRequest}-${input.attempt}`
  })
  if (staging.kind !== 'clone') throw new Error('a Developer trial is staged as a clone')
  let toolHost: Awaited<ReturnType<typeof startDevToolsHost>> | null = null
  let sandbox: GradingSandbox | null = null
  const transcript: string[] = []
  let handle: Awaited<ReturnType<typeof dispatchRole>> | null = null
  const unavailable = (prefix: string, error: unknown): Staged<T> => ({
    ok: false,
    unavailableReason: unavailableReason(prefix, error),
    usage: trialUsage(input.adapter, handle, transcript)
  })
  try {
    const contamination = steps.testContamination(staging, hidden)
    if (!contamination.clean) throw new Error(`trial contamination: ${JSON.stringify(contamination.findings)}`)
    try {
      sandbox = steps.openGradingSandbox()
      await steps.warmPackageCache(sandbox, context.repository, item.baseCommit)
      await sandbox.run(INSTALL_COMMAND, staging.workspace, [staging.workspace], SANDBOX_STEP_BUDGET_MS)
    } catch (error) {
      return unavailable('Codex trial sandbox unavailable before the trial', error)
    }
    const promptPath = join(staging.root.path, 'prompt.md')
    writeFileSync(promptPath, prompt)
    const tools = await import('../../../tests/eval/tool-selection-suite')
    const world = tools.createWorld({ issue: item.pullRequest }, 'developer')
    const socketPath = devToolsSocketPath(`step-one:${item.id}:${input.adapter}:${input.attempt}`)
    toolHost = await steps.startToolHost({
      socketPath,
      serverVersion: 'step-one-1',
      context: world.context,
      role: 'developer'
    })
    const devToolsBridge = driverDevBridgeInvocation(socketPath, join(import.meta.dir, '../../index.ts'))
    handle = await steps.dispatch('developer', adapterVendor(input.adapter), prompt, {
      promptFile: promptPath,
      cwd: staging.workspace,
      unattended: true,
      ...(context.models[input.adapter] === undefined ? {} : { model: context.models[input.adapter] }),
      turnResultKnownFindingIds: [],
      devToolsBridge,
      observeStdoutLine: (line) => transcript.push(line)
    })
    const trace = await traceOf(input.adapter, transcript)
    const toolState = world.state()
    let committed: TrialCommit
    const bundlePath = join(sandbox.scratch, 'trial.bundle')
    try {
      committed = verifyTrialCommit(
        staging,
        await steps.commitTrialInSandbox(
          sandbox,
          staging,
          `Eval(developer): Commit ${item.id} trial ${input.attempt}`,
          bundlePath
        )
      )
    } catch (error) {
      return unavailable('Developer trial could not be committed', error)
    }
    if (!committed.ok) return unavailable('Developer trial unavailable', committed.reason)
    let outcomes: TestOutcomes
    let submitted: string
    try {
      submitted = steps.importTrialBundle({
        repository: context.repository,
        baseCommit: item.baseCommit,
        reportedCommit: committed.commit,
        bundlePath,
        parentDirectory: submissionParent
      })
      const trustedStaging = {
        ...staging,
        workspace: submitted,
        gitDir: join(submitted, '.git')
      }
      const attribution: Attribution = {
        kind: 'clone',
        trialId: staging.trialId,
        created: [],
        reachable: [],
        unreachable: [],
        unattributable: [],
        missing: [],
        attributable: true
      }
      const grading = steps.prepareGradingCopy({
        staging: trustedStaging,
        attribution,
        hidden,
        parentDirectory: gradingParent,
        apply: 'fail-to-pass',
        commit: committed.commit
      })
      // The submitted tree controls its package manifests: its install runs
      // in the sandbox, from the base commit's package cache, with lifecycle
      // scripts disabled.
      await sandbox.run(INSTALL_COMMAND, grading.path, [grading.path], SANDBOX_STEP_BUDGET_MS)
      const testFiles = [
        ...new Set([
          ...item.hiddenTests.files.map((entry) => entry.path),
          ...item.passToPassFiles.map((entry) => entry.path)
        ])
      ]
      outcomes = suite.outcomesOf(await steps.gradeInSandbox(sandbox, grading.path, testFiles, context.timeoutMs))
    } catch (error) {
      return unavailable('Codex grading sandbox unavailable', error)
    }
    const changedPaths = git(submitted, ['diff', '--name-only', item.baseCommit, committed.commit])
      .split('\n')
      .filter(Boolean)
    return {
      ok: true,
      value: finish({ handle, trace, toolState, commit: committed.commit, submitted, outcomes, changedPaths }),
      usage: trialUsage(input.adapter, handle, transcript)
    }
  } finally {
    await toolHost?.close()
    sandbox?.dispose()
    rmSync(parent, { recursive: true, force: true })
    rmSync(submissionParent, { recursive: true, force: true })
    rmSync(gradingParent, { recursive: true, force: true })
  }
}

/**
 * Commits a container-mode trial's work on the working tree's own `HEAD`: any
 * uncommitted change is staged and committed, with hooks and the filesystem
 * monitor off; a trial whose agent already committed is left as it is. No
 * bundle is written, since the verifier reads the tree itself.
 */
export function commitInWorkingTree(workingTree: string, message: string, baseCommit: string): TrialCommit {
  const g = (args: readonly string[]) =>
    git(workingTree, ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=', '--no-optional-locks', ...args])
  if (g(['status', '--porcelain']).trim() !== '') {
    g(['add', '-A'])
    g([
      '-c',
      'user.name=Vinaya Evaluation',
      '-c',
      'user.email=eval@invalid.local',
      'commit',
      '--quiet',
      '--no-verify',
      '-m',
      message
    ])
  }
  return verifyTrialCommit({ baseCommit }, `trial-commit ${g(['rev-parse', 'HEAD']).trim()}\n`)
}

/** What one container-mode Developer trial recorded: its run and its commit on the working tree. */
interface DeveloperInTreeRun {
  handle: Awaited<ReturnType<typeof dispatchRole>>
  trace: TraceCall[]
  toolState: WorldState
  base: string
  commit: string
  changedPaths: string[]
  patchDigest: string
}

/**
 * Runs one container-mode Developer trial of `item` with `prompt`, directly
 * in the container's working tree at the base commit checked out there, and
 * commits the work on that tree's `HEAD`. The role step is `dispatchRole`, or on
 * the Engine backend the Developer's one-step Flow (`runEngineRoleStep`) with
 * the same tool host. Each host step it leaves out, and
 * why:
 *
 * - `hiddenInputs`: the hidden tests and the reference commit are not in the
 *   container; the verifier measures them.
 * - the contamination check: no hidden input exists in the container to
 *   contaminate the workspace.
 * - the temporary clone and the staging copy: the role works in the given
 *   tree, so its diff against the base commit is the role's work.
 * - the grading-sandbox open, the package-cache warm and the sandboxed
 *   installs: nothing is graded here, and the container is the sandbox.
 * - the trial-bundle import and host hidden-test grading: there is no host
 *   copy to import into; grading is the verifier's job.
 */
async function runDeveloperInTree(
  input: Parameters<StepOneExecutor>[0],
  context: StepOneCommandContext,
  container: StepOneContainer,
  item: DeveloperCase,
  prompt: string,
  steps: VinayaProcessSteps,
  /** The documents the turn result must cite, on the Engine backend's turn schema. */
  requiredSources: readonly string[] = []
): Promise<Staged<DeveloperInTreeRun>> {
  const tree = container.workingTree
  const base = git(tree, ['rev-parse', 'HEAD']).trim()
  // The prompt file lives outside the working tree, so it is never part of the role's diff.
  const parent = mkdtempSync(join(stepOneWorkRoot(), 'step-one-container-'))
  let toolHost: Awaited<ReturnType<typeof startDevToolsHost>> | null = null
  const transcript: string[] = []
  let handle: Awaited<ReturnType<typeof dispatchRole>> | null = null
  try {
    const promptPath = join(parent, 'prompt.md')
    writeFileSync(promptPath, prompt)
    const tools = await import('../../../tests/eval/tool-selection-suite')
    const world = tools.createWorld({ issue: item.pullRequest }, 'developer')
    const socketPath = devToolsSocketPath(`step-one:${item.id}:${input.adapter}:${input.attempt}`)
    toolHost = await steps.startToolHost({
      socketPath,
      serverVersion: 'step-one-1',
      context: world.context,
      role: 'developer'
    })
    const devToolsBridge = driverDevBridgeInvocation(socketPath, join(import.meta.dir, '../../index.ts'))
    if (container.backend === 'engine') {
      const { developerTurnResultJsonSchema } = await import('../developer-turn-result')
      handle = await runEngineRoleStep({
        role: 'developer',
        adapter: input.adapter,
        prompt,
        workingTree: tree,
        scratch: join(parent, 'engine'),
        ...(context.models[input.adapter] === undefined ? {} : { model: context.models[input.adapter] }),
        timeoutMs: context.timeoutMs,
        outputSchema: developerTurnResultJsonSchema({ knownFindingIds: [], requiredSources: [...requiredSources] }),
        devToolsBridge,
        spawnFn: steps.engineSpawn,
        observeStdoutLine: streamObserver(transcript, container)
      })
    } else {
      handle = await steps.dispatch('developer', adapterVendor(input.adapter), prompt, {
        promptFile: promptPath,
        cwd: tree,
        unattended: true,
        containerMode: true,
        ...(context.models[input.adapter] === undefined ? {} : { model: context.models[input.adapter] }),
        turnResultKnownFindingIds: [],
        devToolsBridge,
        observeStdoutLine: streamObserver(transcript, container)
      })
    }
    const trace = await traceOf(input.adapter, transcript)
    const toolState = world.state()
    let committed: TrialCommit
    try {
      committed = commitInWorkingTree(tree, `Eval(developer): Commit ${item.id} trial ${input.attempt}`, base)
    } catch (error) {
      return {
        ok: false,
        unavailableReason: unavailableReason('Developer trial could not be committed', error),
        usage: trialUsage(input.adapter, handle, transcript)
      }
    }
    if (!committed.ok) {
      return {
        ok: false,
        unavailableReason: unavailableReason('Developer trial unavailable', committed.reason),
        usage: trialUsage(input.adapter, handle, transcript)
      }
    }
    const changedPaths = git(tree, ['diff', '--name-only', base, committed.commit]).split('\n').filter(Boolean)
    const patchDigest = digest(git(tree, ['diff', '--binary', base, committed.commit]))
    return {
      ok: true,
      value: { handle, trace, toolState, base, commit: committed.commit, changedPaths, patchDigest },
      usage: trialUsage(input.adapter, handle, transcript)
    }
  } finally {
    await toolHost?.close()
    rmSync(parent, { recursive: true, force: true })
  }
}

/** The driver-run publication tools a Developer trial called, by how many effects each performed. */
function publicationCounts(toolState: WorldState): Record<string, number> {
  return {
    publish_changes: toolState.pushes,
    open_pull_request: toolState.pullRequestsOpened,
    update_pull_request_body: toolState.bodyWrites,
    refresh_evidence: toolState.evidenceRefreshes
  }
}

async function executeDeveloper(
  input: Parameters<StepOneExecutor>[0],
  context: StepOneCommandContext,
  item: DeveloperCase
): Promise<StepOneTrialResult> {
  const suite = await import('../../../tests/eval/developer-capability-suite')
  const brief = context.developerBriefs.get(item.pullRequest)
  if (brief === undefined || suite.sha256(brief) !== item.brief.digest.replace(/^sha256:/, ''))
    throw new Error(`developer brief for pull request ${item.pullRequest} is absent or differs from its pinned digest`)
  const sourceManifest = await import('../source-manifest')
  const delivered = await injectedSources(context.repository, item.baseCommit, item.requiredSources)
  const manifestBody = {
    schemaVersion: 1 as const,
    round: 1,
    base: item.baseCommit,
    briefDigest: item.brief.digest,
    preparedAt: delivered.preparedAt,
    sources: delivered.sources
  }
  const manifest = {
    ...manifestBody,
    digest: sourceManifest.manifestDigest(manifestBody)
  }
  const prompt = [
    brief,
    ...delivered.sources.map(
      (source) => `Required source ${source.sourceId}:\n\n${delivered.contents.get(source.sourceId) ?? ''}`
    )
  ].join('\n\n')
  const run = await runDeveloperTrial(input, context, item, prompt, (trial) =>
    suite.gradeDeveloperTrial(item, {
      caseId: item.id,
      testOutcomes: trial.outcomes,
      changedPaths: trial.changedPaths,
      pullRequestBody: trial.toolState.pullRequest?.body ?? null,
      manifest,
      receipts: delivered.receipts,
      trace: trial.trace,
      turnResults: [{ attempt: 1, raw: trial.handle.turnOutput?.raw ?? null }],
      effects: performedEffects(trial.trace, publicationCounts(trial.toolState)),
      usage: {
        toolErrors: trial.handle.failureReason === undefined ? 0 : 1,
        wallMs: trial.handle.durationMs,
        inputTokens: trial.handle.usage?.input ?? 0,
        outputTokens: trial.handle.usage?.output ?? 0
      }
    })
  )
  if (!run.ok)
    return { success: false, unavailableReason: run.unavailableReason, ...processOf(input.suite), usage: run.usage }
  return { success: run.value.verdict === 'pass', ...processOf(input.suite), usage: run.usage }
}

/**
 * A container reviewer trial's role step on the Engine backend: the
 * reviewer's one-step Flow in the working tree, its `read_source` tool served
 * by a dev-tools host the trial starts on an empty source world, since the
 * Engine's generated settings require that server and a review case delivers
 * no document.
 */
async function runEngineReviewer(
  input: Parameters<StepOneExecutor>[0],
  context: StepOneCommandContext,
  container: StepOneContainer,
  item: ReviewCase,
  prompt: string,
  parent: string,
  steps: VinayaProcessSteps,
  transcript: string[]
): Promise<Awaited<ReturnType<typeof dispatchRole>>> {
  const { reviewResultJsonSchema } = await import('../review-result')
  const tools = await import('../../../tests/eval/tool-selection-suite')
  const granted = item.role === 'security-reviewer' ? 'security' : 'code-reviewer'
  const world = tools.createWorld({}, granted)
  const socketPath = devToolsSocketPath(`step-one:${item.id}:${item.role}:${input.adapter}:${input.attempt}`)
  const toolHost = await steps.startToolHost({
    socketPath,
    serverVersion: 'step-one-1',
    context: world.context,
    role: granted
  })
  try {
    return await runEngineRoleStep({
      role: item.role,
      adapter: input.adapter,
      prompt,
      workingTree: container.workingTree,
      scratch: join(parent, 'engine'),
      ...(context.models[input.adapter] === undefined ? {} : { model: context.models[input.adapter] }),
      timeoutMs: context.timeoutMs,
      outputSchema: reviewResultJsonSchema(item.role),
      devToolsBridge: driverDevBridgeInvocation(socketPath, join(import.meta.dir, '../../index.ts')),
      spawnFn: steps.engineSpawn,
      observeStdoutLine: streamObserver(transcript, container)
    })
  } finally {
    await toolHost.close()
  }
}

/**
 * Stages a reviewer trial's snapshot at `baseCommit`, dispatches `role` with
 * `prompt`, and cleans up after `finish`. In container mode the reviewer runs
 * directly in the container's working tree instead: no snapshot is staged, and
 * the contamination check is skipped because no hidden input exists there; on
 * the Engine backend the reviewer runs as its one-step Flow (`runEngineReviewer`).
 */
async function runReviewerTrial<T>(
  input: Parameters<StepOneExecutor>[0],
  context: StepOneCommandContext,
  item: ReviewCase,
  prompt: string,
  finish: (handle: Awaited<ReturnType<typeof dispatchRole>>, transcript: readonly string[]) => Promise<T> | T,
  steps: VinayaProcessSteps = PRODUCTION_VINAYA_PROCESS_STEPS
): Promise<T> {
  const parent = mkdtempSync(join(stepOneWorkRoot(), 'step-one-reviewer-'))
  const role = item.role === 'security-reviewer' ? 'security' : 'code-reviewer'
  if (context.container !== undefined) {
    try {
      // The prompt file lives outside the working tree, so it is never part of the tree's diff.
      const promptPath = join(parent, 'prompt.md')
      writeFileSync(promptPath, prompt)
      const transcript: string[] = []
      if (context.container.backend === 'engine') {
        const handle = await runEngineReviewer(
          input,
          context,
          context.container,
          item,
          prompt,
          parent,
          steps,
          transcript
        )
        return await finish(handle, transcript)
      }
      const handle = await steps.dispatch(role, adapterVendor(input.adapter), prompt, {
        promptFile: promptPath,
        cwd: context.container.workingTree,
        unattended: true,
        containerMode: true,
        ...(context.models[input.adapter] === undefined ? {} : { model: context.models[input.adapter] }),
        observeStdoutLine: streamObserver(transcript, context.container)
      })
      return await finish(handle, transcript)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  }
  const staging = steps.stageTrial({
    trialId: `${item.id}.${input.adapter}.${input.attempt}`,
    sourceRepository: context.repository,
    baseCommit: item.baseCommit,
    parentDirectory: parent,
    mode: 'snapshot'
  })
  try {
    const contamination = steps.testContamination(staging, {
      failToPassTests: {},
      referenceSolution: {}
    })
    if (!contamination.clean) throw new Error(`trial contamination: ${JSON.stringify(contamination.findings)}`)
    const promptPath = join(staging.root.path, 'prompt.md')
    writeFileSync(promptPath, prompt)
    const transcript: string[] = []
    const handle = await steps.dispatch(role, adapterVendor(input.adapter), prompt, {
      promptFile: promptPath,
      cwd: staging.workspace,
      unattended: true,
      ...(context.models[input.adapter] === undefined ? {} : { model: context.models[input.adapter] }),
      observeStdoutLine: (line) => transcript.push(line)
    })
    return await finish(handle, transcript)
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

async function executeReviewer(
  input: Parameters<StepOneExecutor>[0],
  context: StepOneCommandContext,
  item: ReviewCase
): Promise<StepOneTrialResult> {
  const suite = await import('../../../tests/eval/reviewer-quality-suite')
  const patch = suite.patchBytes(item)
  const headSha = item.patch.source === 'git' ? item.patch.changedCommit : digest(patch)
  const manifestDigest = digest(JSON.stringify({ item: item.id, patch: item.patch.digest }))
  const binding = {
    role: item.role,
    headSha,
    manifestDigest,
    objectiveIds: item.objectives
  }
  const prompt = [
    `Review the following pinned patch as the ${item.role}.`,
    `Bind reviewResult to headSha ${headSha} and manifestDigest ${manifestDigest}.`,
    `Return one objectiveResult for each of: ${item.objectives.join(', ')}.`,
    '```diff',
    patch,
    '```'
  ].join('\n\n')
  return runReviewerTrial(input, context, item, prompt, (handle, transcript) => ({
    success: suite.gradeItem(item, handle.reviewOutput?.raw ?? null, binding).pass,
    ...processOf(input.suite),
    usage: {
      wallTimeMs: handle.durationMs,
      ...tokensOf(input.adapter, handle),
      subscriptionQuota: subscriptionQuotaOf(input.adapter, transcript),
      estimatedCostUsd: 0
    }
  }))
}

// ── Layer G ─────────────────────────────────────────────────────────────────

/** What one live run of a rendered neutral case recorded: its Vinaya trial record, or why it has none. */
export type VinayaProcessRun =
  | { ok: true; record: VinayaTrialRecord; usage: StepOneUsage }
  | { ok: false; unavailableReason: string; usage: StepOneUsage }

/** One rendered neutral case to run through the Vinaya process. */
export interface VinayaProcessRequest {
  trial: Parameters<StepOneExecutor>[0]
  neutralCase: NeutralCase
  input: VinayaProcessInput
}

/**
 * The seam between dispatch and record: runs the rendered input and returns
 * the trial record. Production dispatches the role on the selected adapter;
 * a test returns a fixture record and calls no model.
 */
export type VinayaProcessRunner = (
  request: VinayaProcessRequest,
  context: StepOneCommandContext
) => Promise<VinayaProcessRun>

/** Each performed effect as the trial record names it: its operation is its kind, its key its idempotency key. */
function recordedEffects(trace: readonly TraceCall[], counts: Readonly<Record<string, number>>) {
  return performedEffects(trace, counts).map(({ operation, key }) => ({ kind: operation, idempotencyKey: key }))
}

/**
 * Runs one layer-`G` trial: renders the neutral case with the Vinaya
 * renderer, runs it through `run`, extracts the neutral outcomes from the
 * trial record, and counts the trial a success exactly when every generic
 * grader passes. A case the renderer refuses, a run that fails or records no
 * record, and a record that cannot be extracted or is of another case make
 * the trial unavailable, with the reason; it is never graded another way.
 */
export async function executeLayerGTrial(
  trial: Parameters<StepOneExecutor>[0],
  neutralCase: NeutralCase,
  run: (request: VinayaProcessRequest) => Promise<VinayaProcessRun>
): Promise<StepOneTrialResult> {
  const layerG = { layer: 'G' as const, rendererVersion: VINAYA_RENDERER_VERSION }
  const unavailable = (reason: string, usage: StepOneUsage): StepOneTrialResult => ({
    success: false,
    unavailableReason: reason,
    ...layerG,
    usage
  })
  const rendered = renderCase(neutralCase)
  if (!rendered.ok) {
    const { code, field, detail } = rendered.refusal
    return unavailable(
      unavailableReason('the Vinaya renderer refused the case', `${code} at ${field}: ${detail}`),
      NO_USAGE
    )
  }
  let ran: VinayaProcessRun
  try {
    ran = await run({ trial, neutralCase, input: rendered.input })
  } catch (error) {
    return unavailable(unavailableReason('the Vinaya process run failed', error), NO_USAGE)
  }
  if (!ran.ok) return unavailable(ran.unavailableReason, ran.usage)
  if (ran.record?.input?.caseDigest !== rendered.input.caseDigest) {
    return unavailable(unavailableReason('the trial record is unusable', 'it records another case'), ran.usage)
  }
  const extracted = extractOutcomes(ran.record)
  if (!extracted.ok) {
    const { code, field, detail } = extracted.refusal
    return unavailable(
      unavailableReason('the trial record could not be extracted', `${code} at ${field}: ${detail}`),
      ran.usage
    )
  }
  let success = true
  for (const grader of GENERIC_GRADERS) {
    const verdict = await grader.grade({ case: neutralCase, outcomes: extracted.outcomes })
    if (verdict.verdict !== 'pass') success = false
  }
  return { success, ...layerG, usage: ran.usage }
}

/** Each hidden test of a change case with its result in the run, named as the case names it; a test that did not run is `not-run`. */
async function neutralTestResults(
  c: Extract<NeutralCase, { kind: 'change' }>,
  outcomes: TestOutcomes
): Promise<NeutralTestResult[]> {
  const suite = await import('../../../tests/eval/developer-capability-suite')
  return c.hiddenTests.map((test) => {
    // A pass-to-pass test is named by its name digest, a fail-to-pass test by its name.
    const name = test.expectation === 'fail-to-pass' ? suite.testDigest(test.name) : test.name
    const outcome = outcomes[suite.outcomeKey(test.path, name)]
    const result = outcome === undefined ? 'not-run' : outcome === 'skip' ? 'skipped' : outcome
    return { path: test.path, name: test.name, result }
  })
}

/** The record of a `change` case's run, but for its hidden tests, from what the Developer produced. */
function changeRecord(
  adapter: StepOneAdapter,
  input: VinayaProcessInput,
  developer: {
    handle: Awaited<ReturnType<typeof dispatchRole>>
    trace: TraceCall[]
    toolState: WorldState
    base: string
    commit: string
    changedPaths: string[]
    patchDigest: string
  },
  receipts: VinayaTrialRecord['receipts'],
  measured: boolean
): Omit<VinayaTrialRecord, 'hiddenTests'> {
  const opened = developer.toolState.pullRequest
  return {
    rendererVersion: input.rendererVersion,
    input,
    pullRequest:
      opened === null
        ? null
        : {
            headSha: developer.commit,
            baseSha: developer.base,
            diffDigest: developer.patchDigest,
            body: withBeyondSurfaceBlock(
              opened.body,
              beyondSurfacePaths(developer.changedPaths, input.surface ?? { in: [], out: [] })
            )
          },
    measuredChange: measured
      ? {
          base: developer.base,
          head: developer.commit,
          patchDigest: developer.patchDigest,
          changedPaths: developer.changedPaths
        }
      : null,
    checks: null,
    reviews: null,
    readyForMerge: null,
    developerTurnResult: developer.handle.turnOutput?.raw ?? null,
    receipts,
    trace: layerGTrace(adapter, developer.trace).map((call) => ({ tool: call.tool })),
    effects: recordedEffects(developer.trace, publicationCounts(developer.toolState))
  }
}

/**
 * A `change` case: the Developer is dispatched with the rendered brief, its
 * delivered documents and the review loop's publishing instruction, on the
 * layer-`P` developer case of the same id, and the hidden tests run on the
 * trial's commit. The pull request is the one the Developer opened through
 * `open_pull_request`, never one made for it, on that commit, its body carrying the
 * beyond-Surface record the review-loop driver writes. In container mode the
 * Developer runs in the container's working tree, whose files at the base
 * commit deliver the documents, and the record's `measuredChange` and
 * `hiddenTests` stay unset for the verifier to fill.
 */
async function runChangeCase(
  request: VinayaProcessRequest,
  context: StepOneCommandContext,
  item: DeveloperCase,
  steps: VinayaProcessSteps
): Promise<VinayaProcessRun> {
  const { trial, neutralCase: c, input } = request
  if (c.kind !== 'change') throw new Error(`${c.id} is not a change case`)
  const container = context.container
  const delivered =
    container === undefined
      ? await injectedSources(
          context.repository,
          item.baseCommit,
          input.sources.map((source) => source.sourceId)
        )
      : await injectedSources(
          container.workingTree,
          git(container.workingTree, ['rev-parse', 'HEAD']).trim(),
          input.sources.map((source) => source.sourceId)
        )
  for (const source of input.sources) {
    if (digest(delivered.contents.get(source.sourceId) ?? '') !== source.contentDigest)
      throw new Error(`delivered document ${source.sourceId} differs from its pinned content digest`)
  }
  // The prompt ends with the review loop's own publishing instruction: the Developer opens its pull request itself,
  // closing the issue number the trial's fake forge world is created with, as the real loop's brief names it.
  const prompt = [
    input.brief,
    ...input.sources.map(
      (source) =>
        `${source.required ? 'Required source' : 'Delivered document'} ${source.sourceId}:\n\n${delivered.contents.get(source.sourceId) ?? ''}`
    ),
    `This task's issue is #${item.pullRequest}: the pull request body's first line is \`Closes #${item.pullRequest}\`.`,
    `When your work is ready, ${publishingInstructionLine()}`
  ].join('\n\n')
  if (container !== undefined) {
    const run = await runDeveloperInTree(
      trial,
      context,
      container,
      item,
      prompt,
      steps,
      input.sources.filter((source) => source.required).map((source) => source.sourceId)
    )
    if (!run.ok) return run
    // The hidden tests are not in the container: the verifier runs them on the tree's commit.
    const record: VinayaTrialRecord = {
      ...changeRecord(trial.adapter, input, run.value, delivered.receipts, false),
      hiddenTests: null
    }
    return { ok: true, record, usage: run.usage }
  }
  const run = await runDeveloperTrial(
    trial,
    context,
    item,
    prompt,
    (developer) => ({
      ...changeRecord(
        trial.adapter,
        input,
        {
          ...developer,
          base: item.baseCommit,
          patchDigest: digest(git(developer.submitted, ['diff', '--binary', item.baseCommit, developer.commit]))
        },
        delivered.receipts,
        true
      ),
      outcomes: developer.outcomes
    }),
    steps
  )
  if (!run.ok) return run
  const { outcomes, ...recorded } = run.value
  const head = recorded.measuredChange?.head ?? ''
  const record: VinayaTrialRecord = {
    ...recorded,
    hiddenTests: { revision: head, results: await neutralTestResults(c, outcomes) }
  }
  return { ok: true, record, usage: run.usage }
}

/**
 * A `review` case: the suite's reviewer is dispatched on the change under
 * review, the patch of the layer-`P` reviewer case of the same id, and its
 * result is bound to the rendered brief's hash and that change's head.
 */
async function runReviewCase(
  request: VinayaProcessRequest,
  context: StepOneCommandContext,
  item: ReviewCase,
  steps: VinayaProcessSteps
): Promise<VinayaProcessRun> {
  const { trial, input } = request
  const change = input.changeUnderReview
  if (change === null) throw new Error(`${input.caseId} has no change under review`)
  // A reviewer reports no source use, so a review case's documents could never be shown used.
  if (input.sources.length > 0) throw new Error(`${input.caseId} delivers documents to a reviewer`)
  const suite = await import('../../../tests/eval/reviewer-quality-suite')
  const prompt = [
    input.brief,
    `Review the following change as the ${item.role}: base ${change.base}, head ${change.head}.`,
    `Bind reviewResult to headSha ${change.head} and manifestDigest ${input.briefHash}.`,
    `Return one objectiveResult for each of: ${input.objectives.map((objective) => objective.id).join(', ')}.`,
    '```diff',
    suite.patchBytes(item),
    '```'
  ].join('\n\n')
  return runReviewerTrial(
    trial,
    context,
    item,
    prompt,
    async (handle, transcript) => {
      const trace = await layerGTraceOf(trial.adapter, transcript)
      const record: VinayaTrialRecord = {
        rendererVersion: input.rendererVersion,
        input,
        pullRequest: null,
        measuredChange: null,
        hiddenTests: null,
        checks: null,
        reviews: [
          {
            reviewId: `${input.caseId}.${trial.adapter}.${trial.attempt}.${item.role}`,
            role: item.role,
            binding: {
              headSha: change.head,
              baseSha: change.base,
              briefHash: input.briefHash,
              diffDigest: change.patchDigest
            },
            output: handle.reviewOutput?.raw ?? null
          }
        ],
        readyForMerge: null,
        developerTurnResult: null,
        receipts: [],
        trace: trace.map((call) => ({ tool: call.tool })),
        // A reviewer holds no driver-run tool, so it performs no effect.
        effects: recordedEffects(trace, {})
      }
      return { ok: true as const, record, usage: trialUsage(trial.adapter, handle, transcript) }
    },
    steps
  )
}

/**
 * An `answer` case, run as the source-citation suite's live trial runs: the
 * Developer is dispatched in an empty workspace holding only the injected
 * documents of the layer-`P` source-citation case of the same id, the others
 * served by `fetch_documentation`, told to change nothing; nothing is
 * committed, and the record carries no change. In container mode the
 * Developer works in the container's working tree instead, with each injected
 * document the tree does not already hold written into it; a Claude turn
 * there authenticates from the container's subscription token alone.
 */
async function runAnswerCase(
  request: VinayaProcessRequest,
  context: StepOneCommandContext,
  item: SourceCitationCase,
  steps: VinayaProcessSteps
): Promise<VinayaProcessRun> {
  const { trial, input } = request
  for (const source of input.sources) {
    const spec = item.sources.find((entry) => entry.sourceId === source.sourceId)
    if (spec === undefined || digest(spec.content) !== source.contentDigest)
      throw new Error(`delivered document ${source.sourceId} differs from its pinned content digest`)
  }
  const citation = await import('../../../tests/eval/source-citation-suite')
  const sourceManifest = await import('../source-manifest')
  const { manifest, receipts } = citation.evidenceFor(item)
  const required = new Set(input.sources.filter((source) => source.required).map((source) => source.sourceId))
  const alsoDelivered = manifest.sources.filter((source) => !required.has(source.sourceId))
  const prompt = [
    input.brief,
    'Answer from the delivered documents. This task changes nothing: you cannot edit a file, and you publish nothing.',
    sourceManifest.requiredSourcesPromptBlock({
      ...manifest,
      sources: manifest.sources.filter((source) => required.has(source.sourceId))
    }) ?? 'This task has no required sources.',
    ...(alsoDelivered.length === 0
      ? []
      : [
          `Also delivered, not required: ${alsoDelivered
            .map((source) =>
              source.deliveryMode === 'injected'
                ? `\`${source.sourceId}\` in your worktree`
                : `\`${source.sourceId}\` via \`fetch_documentation\``
            )
            .join(', ')}.`
        ]),
    'Return status completed, addressedFindingIds [], reportedChecks null, and sourceUses that cites only the delivered documents you used.'
  ].join('\n\n')
  const container = context.container
  const parent = mkdtempSync(join(stepOneWorkRoot(), 'step-one-answer-'))
  const workspace = container?.workingTree ?? join(parent, 'workspace')
  if (container === undefined) mkdirSync(workspace)
  for (const source of item.sources.filter((entry) => entry.deliveryMode === 'injected')) {
    const path = join(workspace, source.sourceId)
    if (container !== undefined && existsSync(path)) continue
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source.content)
  }
  // In container mode a Claude turn gets the named worker allowlist and the
  // subscription token, never the container's whole environment.
  const containerLogin = containerClaudeLogin(process.env, container !== undefined && trial.adapter === 'claude-code')
  if (container !== undefined && trial.adapter === 'claude-code' && containerLogin === null)
    throw new Error('container mode authenticates Claude only from the subscription token in CLAUDE_CODE_OAUTH_TOKEN')
  const world = citation.worldFor(item, (source) => source.content)
  const socketPath = devToolsSocketPath(`step-one:${item.id}:${trial.adapter}:${trial.attempt}`)
  const toolHost = await steps.startToolHost({
    socketPath,
    serverVersion: 'step-one-1',
    context: world.context,
    role: 'developer'
  })
  try {
    const { developerTurnResultJsonSchema } = await import('../developer-turn-result')
    const { readClaudeTurnOutput, readCodexTurnOutput } = await import('../dev-review-loop/turn-result')
    const tools = await import('../../../tests/eval/tool-selection-suite')
    // The read-only turn the source-citation suite's live trial runs: Claude
    // Code holds only the served driver-run tools and Codex runs read-only, so
    // the Developer cannot write a file whatever the prompt says.
    const runTurn = await steps.readOnlyTurn(
      trial.adapter,
      parent,
      workspace,
      driverDevBridgeInvocation(socketPath, join(import.meta.dir, '../../index.ts')),
      developerTurnResultJsonSchema({ knownFindingIds: [], requiredSources: [...required] }),
      {
        ...(context.models['claude-code'] === undefined ? {} : { claudeModel: context.models['claude-code'] }),
        ...(context.models.codex === undefined ? {} : { codexModel: context.models.codex }),
        ...(containerLogin === null ? {} : { claudeEnv: buildWorkerEnv(process.env, containerLogin) }),
        timeoutSec: Math.ceil(context.timeoutMs / 1000)
      }
    )
    const started = Date.now()
    const stdout = await runTurn(prompt, null)
    const wallTimeMs = Date.now() - started
    const transcript = stdout.split('\n').filter(Boolean)
    if (container?.streamPath !== undefined && transcript.length > 0)
      appendFileSync(container.streamPath, `${transcript.join('\n')}\n`)
    const turn = trial.adapter === 'claude-code' ? readClaudeTurnOutput(stdout) : readCodexTurnOutput(stdout)
    const tokens = tools.usageOf(trial.adapter, transcript)
    const trace = await layerGTraceOf(trial.adapter, transcript)
    const record: VinayaTrialRecord = {
      rendererVersion: input.rendererVersion,
      input,
      pullRequest: null,
      measuredChange: null,
      hiddenTests: null,
      checks: null,
      reviews: null,
      readyForMerge: null,
      developerTurnResult: turn.raw ?? null,
      receipts: [...receipts, ...citation.fetchedReceipts(manifest, world, (source) => source.content, item.sources)],
      trace: trace.map((call) => ({ tool: call.tool })),
      effects: recordedEffects(trace, publicationCounts(world.state()))
    }
    const usage: StepOneUsage = {
      wallTimeMs,
      // `usageOf` folds cache into its input figure; step-one usage counts it apart.
      inputTokens: Math.max(0, tokens.inputTokens - tokens.cacheReadTokens - tokens.cacheCreationTokens),
      outputTokens: tokens.outputTokens,
      cacheReadTokens: tokens.cacheReadTokens,
      cacheCreationTokens: tokens.cacheCreationTokens,
      subscriptionQuota: subscriptionQuotaOf(trial.adapter, transcript),
      estimatedCostUsd: 0
    }
    return { ok: true, record, usage }
  } finally {
    await toolHost.close()
    rmSync(parent, { recursive: true, force: true })
  }
}

/**
 * The run of a rendered case through `steps`: each kind dispatched its own
 * way, on its layer-`P` counterpart. In container mode the record a run
 * produced is also written to the container's `recordPath` for the verifier,
 * naming the backend the role ran on.
 */
export function vinayaProcess(steps: VinayaProcessSteps): VinayaProcessRunner {
  return async (request, context) => {
    const ran = await runKind(request, context, steps)
    if (context.container !== undefined && ran.ok) {
      const written: ContainerTrialRecord = { ...ran.record, backend: context.container.backend ?? 'standalone' }
      writeFileSync(context.container.recordPath, `${JSON.stringify(written, null, 2)}\n`)
    }
    return ran
  }
}

function runKind(
  request: VinayaProcessRequest,
  context: StepOneCommandContext,
  steps: VinayaProcessSteps
): Promise<VinayaProcessRun> {
  const c = request.neutralCase
  if (c.kind === 'change') {
    const item = context.loaded.developerCases.find((entry) => entry.id === c.id)
    if (item === undefined) throw new Error(`${c.id} has no layer-P developer case`)
    return runChangeCase(request, context, item, steps)
  }
  if (c.kind === 'review') {
    const role = request.trial.suite === 'security-reviewer-quality-neutral.l5' ? 'security-reviewer' : 'code-reviewer'
    const item = context.loaded.reviewerCases.find((entry) => entry.id === c.id && entry.role === role)
    if (item === undefined) throw new Error(`${c.id} has no layer-P ${role} case`)
    return runReviewCase(request, context, item, steps)
  }
  if (c.kind === 'answer') {
    // The read-only answer turn has no Engine role step; recording it under the Engine would misname its backend.
    if (context.container?.backend === 'engine') throw new Error('an answer case runs only on the standalone backend')
    const item = context.loaded.sourceCitationCases.find((entry) => entry.id === c.id)
    if (item === undefined) throw new Error(`${c.id} has no layer-P source-citation case`)
    return runAnswerCase(request, context, item, steps)
  }
  throw new Error(`step one runs no ${c.kind} case`)
}

/** Production's run of a rendered case: each kind dispatched its own way, on its layer-`P` counterpart. */
export const runVinayaProcess: VinayaProcessRunner = async (request, context) => {
  return vinayaProcess(PRODUCTION_VINAYA_PROCESS_STEPS)(request, context)
}

async function executeLayerP(input: Parameters<StepOneExecutor>[0], context: StepOneCommandContext) {
  if (input.suite === 'developer-capability.l5') {
    const item = context.loaded.developerCases.find((entry) => entry.id === input.taskId)
    if (item === undefined) throw new Error(`unknown Developer task ${input.taskId}`)
    return executeDeveloper(input, context, item)
  }
  const item = context.loaded.reviewerCases.find(
    (entry) =>
      entry.id === input.taskId &&
      entry.role === (input.suite === 'code-reviewer-quality.l5' ? 'code-reviewer' : 'security-reviewer')
  )
  if (item === undefined) throw new Error(`unknown reviewer task ${input.taskId}`)
  return executeReviewer(input, context, item)
}

/**
 * The step-one runtime whose layer-`G` trials run through `run`: a layer-`G`
 * trial renders its development neutral case and is graded by the generic
 * graders alone, a layer-`P` trial by its suite's own grader.
 */
export function stepOneRuntime(run: VinayaProcessRunner): StepOneCommandRuntime {
  return {
    loadDevelopment: loadProductionDevelopment,
    async execute(input, context) {
      if (STEP_ONE_SUITE_LAYERS[input.suite] === 'P') {
        // Container mode is for layer-`G` trials only; a layer-`P` trial always runs on the host.
        if (context.container !== undefined) throw new Error(`container mode runs no layer-P suite: ${input.suite}`)
        return executeLayerP(input, context)
      }
      const neutralCase = context.loaded.neutralCases[input.suite as LayerGSuite]?.find(
        (entry) => entry.id === input.taskId
      )
      if (neutralCase === undefined) throw new Error(`unknown ${input.suite} task ${input.taskId}`)
      return executeLayerGTrial(input, neutralCase, (request) => run(request, context))
    }
  }
}

export const PRODUCTION_STEP_ONE_RUNTIME: StepOneCommandRuntime = stepOneRuntime(runVinayaProcess)

const flag = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? undefined : args[index + 1]
}

/** Every value given for a repeatable flag, in order. */
const flags = (args: readonly string[], name: string): string[] =>
  args.flatMap((arg, index) =>
    arg === `--${name}` && args[index + 1] !== undefined ? [args[index + 1] as string] : []
  )

function numberFlag(args: readonly string[], name: string): number {
  const value = Number(flag(args, name))
  if (!Number.isFinite(value)) throw new Error(`--${name} is required and must be numeric`)
  return value
}

/**
 * The `--cases` selection: one whole number alone is a count; otherwise each
 * value, given once per flag or comma-separated, is a case id.
 */
function caseSelection(args: readonly string[]): StepOneCaseSelection | undefined {
  const values = flags(args, 'cases').flatMap((value) => value.split(',').filter((part) => part !== ''))
  if (values.length === 0) return undefined
  const only = values.length === 1 ? (values[0] as string) : undefined
  if (only !== undefined && /^-?\d+$/.test(only)) return { count: Number(only) }
  return { ids: [...new Set(values)] }
}

function briefsFromSnapshot(path: string): Map<number, string> {
  const briefs = new Map<number, string>()
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    const row = JSON.parse(line) as { pr?: unknown; brief?: unknown }
    if (Number.isInteger(row.pr) && typeof row.brief === 'string') briefs.set(row.pr as number, row.brief)
  }
  return briefs
}

export async function runStepOneCommand(
  argv: readonly string[],
  runtime: StepOneCommandRuntime = PRODUCTION_STEP_ONE_RUNTIME
): Promise<StepOneOutcome> {
  if (argv[0] !== 'run')
    throw new Error(
      'usage: step-one.ts run --split development --backend standalone [--purpose <development-only|practice|comparison>] [--suite <name>]... [--adapter <claude-code|codex>] [--cases <n>|--cases <id>...] --trials <n> --bootstrap <percentile|basic> --seed <n> --resamples <n> --confidence <x> [--developer-snapshot <jsonl>] --input-cost-per-million <usd> --output-cost-per-million <usd> [--claude-model <m>] [--codex-model <m>] [--timeout-sec <n>] [--container-tree <dir> --container-record <file>] [--out <file>]'
    )
  const split = flag(argv, 'split')
  const backend = flag(argv, 'backend')
  const snapshot = flag(argv, 'developer-snapshot')
  const claudeModel = flag(argv, 'claude-model')
  const codexModel = flag(argv, 'codex-model')
  // Container mode is this trial entry's explicit choice, both flags or neither.
  const containerTree = flag(argv, 'container-tree')
  const containerRecord = flag(argv, 'container-record')
  if ((containerTree === undefined) !== (containerRecord === undefined))
    throw new Error('--container-tree and --container-record are given together or not at all')
  const context: StepOneCommandContext = {
    repository: join(import.meta.dir, '../../../../..'),
    developerBriefs: snapshot === undefined || !existsSync(snapshot) ? new Map() : briefsFromSnapshot(snapshot),
    models: {
      ...(claudeModel === undefined ? {} : { 'claude-code': claudeModel }),
      ...(codexModel === undefined ? {} : { codex: codexModel })
    },
    timeoutMs: Number(flag(argv, 'timeout-sec') ?? '1800') * 1000,
    loaded: NO_DEVELOPMENT,
    ...(containerTree === undefined || containerRecord === undefined
      ? {}
      : { container: { workingTree: containerTree, recordPath: containerRecord } })
  }
  const cases = caseSelection(argv)
  const outcome = await runStepOne(
    {
      split: split as StepOneOptions['split'],
      backend: backend as StepOneOptions['backend'],
      purpose: (flag(argv, 'purpose') ?? 'development-only') as StepOnePurpose,
      ...(flags(argv, 'suite').length === 0 ? {} : { suites: flags(argv, 'suite') }),
      ...(flags(argv, 'adapter').length === 0 ? {} : { adapters: flags(argv, 'adapter') }),
      ...(cases === undefined ? {} : { cases }),
      trialsPerTask: numberFlag(argv, 'trials'),
      bootstrap: {
        method: flag(argv, 'bootstrap') as BootstrapMethod,
        seed: numberFlag(argv, 'seed'),
        resamples: numberFlag(argv, 'resamples'),
        confidence: numberFlag(argv, 'confidence')
      },
      pricing: {
        inputUsdPerMillion: numberFlag(argv, 'input-cost-per-million'),
        outputUsdPerMillion: numberFlag(argv, 'output-cost-per-million')
      }
    },
    // Loaded only once every check that reads no suite input has passed.
    async () => {
      context.loaded = await runtime.loadDevelopment()
      return context.loaded.suites
    },
    (input) => runtime.execute(input, context)
  )
  const text = `${JSON.stringify(outcome, null, 2)}\n`
  const out = flag(argv, 'out')
  if (out === undefined) process.stdout.write(text)
  else writeFileSync(out, text)
  return outcome
}

if (import.meta.main) {
  runStepOneCommand(process.argv.slice(2))
    .then((outcome) => process.exit(outcome.ok ? 0 : 2))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
}
