import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { redact } from '@attalabs/aeg-core'
import {
  addCodexWritableDirs,
  buildCodexExecpolicyRules,
  codexSpawnEnvExtras,
  dispatchRole,
  type AgentVendor
} from '../dispatch'
import { startDevToolsHost } from '../task-tools/dev-tools-host'
import { devToolsSocketPath, driverDevBridgeInvocation } from '../task-tools/dev-tools-registration'
import { stageCodexPolicyHome } from '../worker-boundary'
import { prepareGradingCopy, testContamination, type Attribution, type HiddenInputs } from './contamination'
import { suiteMean, type BootstrapMethod } from './estimators'
import { type CloneStaging, git, stageTrial } from './staging'

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

/** Each suite step one may run, by its process layer as the module registry declares it. */
export const STEP_ONE_SUITE_LAYERS: Readonly<Record<StepOneRunSuite, 'G' | 'P'>> = {
  'developer-capability.l5': 'P',
  'code-reviewer-quality.l5': 'P',
  'security-reviewer-quality.l5': 'P',
  'developer-capability-neutral.l5': 'G',
  'code-reviewer-quality-neutral.l5': 'G',
  'security-reviewer-quality-neutral.l5': 'G',
  'source-delivery-neutral.l5': 'G'
}
export type StepOneRefusal = { code: StepOneRefusalCode; detail: string }

export interface StepOneUsage {
  wallTimeMs: number
  inputTokens: number
  outputTokens: number
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
  const policyRoot = realpathSync(mkdtempSync(join(tmpdir(), 'step-one-grading-policy-')))
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'step-one-grading-scratch-')))
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
  usage: StepOneUsage
}

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
 * Runs milestone step one only. The split, backend and suite checks precede
 * every access to suite inputs, so a refused invocation cannot open held-out data.
 */
export async function runStepOne(
  options: StepOneOptions,
  loadDevelopmentSuites: () => readonly StepOneSuiteInput[],
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

  const suites = loadDevelopmentSuites()
  const runs: StepOneResult['runs'] = []
  for (const suite of selected.suites) {
    const input = suites.find((entry) => entry.suite === suite)
    if (input === undefined || input.taskIds.length === 0)
      return refusal('empty_development_split', `${suite} has no reconstructable development task`)
    for (const adapter of STEP_ONE_ADAPTERS) {
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
        subscriptionQuota: 0,
        estimatedCostUsd: 0
      }
      let quotaUnavailableTrials = 0
      for (const taskId of input.taskIds) {
        let successes = 0
        const unavailable: string[] = []
        for (let attempt = 1; attempt <= options.trialsPerTask; attempt++) {
          const trial = await execute({ suite, adapter, taskId, attempt })
          if (trial.success) successes++
          if (trial.unavailableReason !== undefined) unavailable.push(trial.unavailableReason)
          usage.wallTimeMs += trial.usage.wallTimeMs
          usage.inputTokens += trial.usage.inputTokens
          usage.outputTokens += trial.usage.outputTokens
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

interface LoadedDevelopment {
  suites: StepOneSuiteInput[]
  developerCases: DeveloperCase[]
  reviewerCases: ReviewCase[]
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
}

const adapterVendor = (adapter: StepOneAdapter): AgentVendor => (adapter === 'claude-code' ? 'claude' : 'codex')
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')

async function loadProductionDevelopment(): Promise<LoadedDevelopment> {
  const developer = await import('../../../tests/eval/developer-capability-suite')
  const reviewers = await import('../../../tests/eval/reviewer-quality-suite')
  const generic = await import('../../../tests/eval/generic-suites')
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
      ...(
        [
          ['developer-capability-neutral.l5', 'developer'],
          ['code-reviewer-quality-neutral.l5', 'codeReviewer'],
          ['security-reviewer-quality-neutral.l5', 'securityReviewer'],
          ['source-delivery-neutral.l5', 'sourceCitation']
        ] as const
      ).map(([suite, key]) => ({ suite, taskIds: generic.genericSuite(key).splits.development }))
    ],
    developerCases,
    reviewerCases: [...code, ...security]
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
  const parent = mkdtempSync(join(tmpdir(), 'step-one-base-'))
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

function trialUsage(
  adapter: StepOneAdapter,
  handle: {
    durationMs: number
    usage: { input: number; output: number } | null
  } | null,
  transcript: readonly string[]
): StepOneUsage {
  return {
    wallTimeMs: handle?.durationMs ?? 0,
    inputTokens: handle?.usage?.input ?? 0,
    outputTokens: handle?.usage?.output ?? 0,
    subscriptionQuota: handle === null ? 0 : subscriptionQuotaOf(adapter, transcript),
    estimatedCostUsd: 0
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
  const parent = mkdtempSync(join(tmpdir(), 'step-one-developer-'))
  const submissionParent = mkdtempSync(join(tmpdir(), 'step-one-submission-'))
  const gradingParent = mkdtempSync(join(tmpdir(), 'step-one-grading-'))
  const hidden = hiddenInputs(context.repository, item)
  const sourceManifest = await import('../source-manifest')
  const preparedAt = new Date(0).toISOString()
  const preparedSources = item.requiredSources.map((sourceId) => {
    const content = fileAt(context.repository, item.baseCommit, sourceId)
    return {
      sourceId,
      canonicalUri: `repository:${sourceId}`,
      requirementText: sourceId,
      governs: 'the mechanism named by the frozen brief',
      objectiveIds: [],
      retrievedAt: preparedAt,
      versionOrRevision: item.baseCommit,
      contentDigest: sourceManifest.sha256Digest(content),
      mediaType: 'text/plain',
      deliveryMode: 'injected' as const,
      snapshotRef: `git:blob:${digest(Buffer.from(content).toString())}`,
      freshnessPolicy: 'pinned' as const,
      trustClassification: 'repository' as const
    }
  })
  const manifestBody = {
    schemaVersion: 1 as const,
    round: 1,
    base: item.baseCommit,
    briefDigest: item.brief.digest,
    preparedAt,
    sources: preparedSources
  }
  const manifest = {
    ...manifestBody,
    digest: sourceManifest.manifestDigest(manifestBody)
  }
  const receipts = preparedSources.map((source) => ({
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
  const prompt = [
    brief,
    ...preparedSources.map((source) => {
      const content = Buffer.from(fileAt(context.repository, item.baseCommit, source.sourceId)).toString('utf8')
      return `Required source ${source.sourceId}:\n\n${content}`
    })
  ].join('\n\n')
  const staging = stageTrial({
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
  const unavailable = (prefix: string, error: unknown): StepOneTrialResult => ({
    success: false,
    unavailableReason: unavailableReason(prefix, error),
    usage: trialUsage(input.adapter, handle, transcript)
  })
  try {
    const contamination = testContamination(staging, hidden)
    if (!contamination.clean) throw new Error(`trial contamination: ${JSON.stringify(contamination.findings)}`)
    try {
      sandbox = openGradingSandbox()
      await warmPackageCache(sandbox, context.repository, item.baseCommit)
      await sandbox.run(INSTALL_COMMAND, staging.workspace, [staging.workspace], SANDBOX_STEP_BUDGET_MS)
    } catch (error) {
      return unavailable('Codex trial sandbox unavailable before the trial', error)
    }
    const promptPath = join(staging.root.path, 'prompt.md')
    writeFileSync(promptPath, prompt)
    const tools = await import('../../../tests/eval/tool-selection-suite')
    const world = tools.createWorld({ issue: item.pullRequest }, 'developer')
    const socketPath = devToolsSocketPath(`step-one:${item.id}:${input.adapter}:${input.attempt}`)
    toolHost = await startDevToolsHost({
      socketPath,
      serverVersion: 'step-one-1',
      context: world.context,
      role: 'developer'
    })
    const devToolsBridge = driverDevBridgeInvocation(socketPath, join(import.meta.dir, '../../index.ts'))
    handle = await dispatchRole('developer', adapterVendor(input.adapter), prompt, {
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
        await commitTrialInSandbox(
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
    let outcomes: ReturnType<typeof suite.outcomesOf>
    let submitted: string
    try {
      submitted = importTrialBundle({
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
      const grading = prepareGradingCopy({
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
      outcomes = suite.outcomesOf(await gradeInSandbox(sandbox, grading.path, testFiles, context.timeoutMs))
    } catch (error) {
      return unavailable('Codex grading sandbox unavailable', error)
    }
    const changedPaths = git(submitted, ['diff', '--name-only', item.baseCommit, committed.commit])
      .split('\n')
      .filter(Boolean)
    const grade = suite.gradeDeveloperTrial(item, {
      caseId: item.id,
      testOutcomes: outcomes,
      changedPaths,
      pullRequestBody: toolState.pullRequest?.body ?? null,
      manifest,
      receipts,
      trace,
      turnResults: [{ attempt: 1, raw: handle.turnOutput?.raw ?? null }],
      effects: performedEffects(trace, {
        publish_changes: toolState.pushes,
        open_pull_request: toolState.pullRequestsOpened,
        update_pull_request_body: toolState.bodyWrites,
        refresh_evidence: toolState.evidenceRefreshes
      }),
      usage: {
        toolErrors: handle.failureReason === undefined ? 0 : 1,
        wallMs: handle.durationMs,
        inputTokens: handle.usage?.input ?? 0,
        outputTokens: handle.usage?.output ?? 0
      }
    })
    return {
      success: grade.verdict === 'pass',
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

async function executeReviewer(
  input: Parameters<StepOneExecutor>[0],
  context: StepOneCommandContext,
  item: ReviewCase
): Promise<StepOneTrialResult> {
  const suite = await import('../../../tests/eval/reviewer-quality-suite')
  const parent = mkdtempSync(join(tmpdir(), 'step-one-reviewer-'))
  const staging = stageTrial({
    trialId: `${item.id}.${input.adapter}.${input.attempt}`,
    sourceRepository: context.repository,
    baseCommit: item.baseCommit,
    parentDirectory: parent,
    mode: 'snapshot'
  })
  try {
    const contamination = testContamination(staging, {
      failToPassTests: {},
      referenceSolution: {}
    })
    if (!contamination.clean) throw new Error(`trial contamination: ${JSON.stringify(contamination.findings)}`)
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
    const promptPath = join(staging.root.path, 'prompt.md')
    writeFileSync(promptPath, prompt)
    const transcript: string[] = []
    const handle = await dispatchRole(
      item.role === 'security-reviewer' ? 'security' : 'code-reviewer',
      adapterVendor(input.adapter),
      prompt,
      {
        promptFile: promptPath,
        cwd: staging.workspace,
        unattended: true,
        ...(context.models[input.adapter] === undefined ? {} : { model: context.models[input.adapter] }),
        observeStdoutLine: (line) => transcript.push(line)
      }
    )
    const grade = suite.gradeItem(item, handle.reviewOutput?.raw ?? null, binding)
    return {
      success: grade.pass,
      usage: {
        wallTimeMs: handle.durationMs,
        inputTokens: handle.usage?.input ?? 0,
        outputTokens: handle.usage?.output ?? 0,
        subscriptionQuota: subscriptionQuotaOf(input.adapter, transcript),
        estimatedCostUsd: 0
      }
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
}

async function executeProduction(input: Parameters<StepOneExecutor>[0], context: StepOneCommandContext) {
  // A layer-G trial runs the rendered neutral case through the Vinaya process
  // and is graded on the outcomes the renderer extracts; no live executor for
  // one exists yet, so such a trial is refused rather than graded another way.
  if (STEP_ONE_SUITE_LAYERS[input.suite] === 'G') {
    throw new Error(`no live executor runs ${input.suite} trials yet`)
  }
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

export const PRODUCTION_STEP_ONE_RUNTIME: StepOneCommandRuntime = {
  loadDevelopment: loadProductionDevelopment,
  execute: executeProduction
}

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
      'usage: step-one.ts run --split development --backend standalone [--purpose <development-only|practice|comparison>] [--suite <name>]... --trials <n> --bootstrap <percentile|basic> --seed <n> --resamples <n> --confidence <x> --developer-snapshot <jsonl> --input-cost-per-million <usd> --output-cost-per-million <usd> [--claude-model <m>] [--codex-model <m>] [--timeout-sec <n>] [--out <file>]'
    )
  const split = flag(argv, 'split')
  const backend = flag(argv, 'backend')
  const loaded = split === 'development' && backend === 'standalone' ? await runtime.loadDevelopment() : null
  const snapshot = flag(argv, 'developer-snapshot')
  const claudeModel = flag(argv, 'claude-model')
  const codexModel = flag(argv, 'codex-model')
  const context: StepOneCommandContext = {
    repository: join(import.meta.dir, '../../../../..'),
    developerBriefs: snapshot === undefined || !existsSync(snapshot) ? new Map() : briefsFromSnapshot(snapshot),
    models: {
      ...(claudeModel === undefined ? {} : { 'claude-code': claudeModel }),
      ...(codexModel === undefined ? {} : { codex: codexModel })
    },
    timeoutMs: Number(flag(argv, 'timeout-sec') ?? '1800') * 1000,
    loaded: loaded ?? { suites: [], developerCases: [], reviewerCases: [] }
  }
  const outcome = await runStepOne(
    {
      split: split as StepOneOptions['split'],
      backend: backend as StepOneOptions['backend'],
      purpose: (flag(argv, 'purpose') ?? 'development-only') as StepOnePurpose,
      ...(flags(argv, 'suite').length === 0 ? {} : { suites: flags(argv, 'suite') }),
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
    () => loaded?.suites ?? [],
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
