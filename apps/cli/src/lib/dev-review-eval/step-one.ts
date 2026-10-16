import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { attributeTrialObjects, prepareGradingCopy, testContamination, type HiddenInputs } from './contamination'
import { suiteMean, type BootstrapMethod } from './estimators'
import { git, stageTrial } from './staging'

export const STEP_ONE_SUITES = [
  'developer-capability.l5',
  'code-reviewer-quality.l5',
  'security-reviewer-quality.l5'
] as const
export const STEP_ONE_ADAPTERS = ['claude-code', 'codex'] as const

export type StepOneSuite = (typeof STEP_ONE_SUITES)[number]
export type StepOneAdapter = (typeof STEP_ONE_ADAPTERS)[number]
export type StepOneRefusalCode = 'held_out_forbidden' | 'engine_forbidden' | 'empty_development_split' | 'invalid_input'
export type StepOneRefusal = { code: StepOneRefusalCode; detail: string }

export interface StepOneUsage {
  wallTimeMs: number
  inputTokens: number
  outputTokens: number
  subscriptionQuota: number | null
  estimatedCostUsd: number
}

type TraceCall = import('../../../tests/eval/tool-selection-suite').TraceCall

/** Reports the increase between the first and last subscription-utilization readings. */
export function subscriptionQuotaOf(adapter: StepOneAdapter, lines: readonly string[]): number | null {
  const keys = adapter === 'codex' ? ['used_percent', 'usedPercent'] : ['utilization', 'used_percent']
  const observed: number[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      if (keys.includes(key) && typeof child === 'number' && Number.isFinite(child) && child >= 0) observed.push(child)
      else visit(child)
    }
  }
  for (const line of lines) {
    try {
      visit(JSON.parse(line))
    } catch {
      // Vendor stdout can contain diagnostics; only structured telemetry counts.
    }
  }
  if (observed.length < 2) return null
  return Math.max(0, (observed.at(-1) as number) - (observed[0] as number))
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

export function gradingIsolation(workspace: string) {
  return (command: readonly string[], cwd: string, scratch: string) => {
    const home = join(scratch, 'home')
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex', 'auth.json'), '{}\n', { mode: 0o600 })
    const staged = stageCodexPolicyHome({
      targetDir: join(scratch, 'codex-home'),
      realHome: home,
      execpolicyRules: buildCodexExecpolicyRules('developer') ?? '',
      sandboxConfigToml: 'sandbox_mode = "workspace-write"\n[sandbox_workspace_write]\nnetwork_access = false\n'
    })
    if (staged === null) throw new Error('grading unavailable: Codex policy home could not be staged')
    const extras = codexSpawnEnvExtras('codex', staged.codexHome, scratch).attribution
    const args = addCodexWritableDirs(
      [
        'sandbox',
        '--config',
        'sandbox_mode="workspace-write"',
        '--config',
        'sandbox_workspace_write.network_access=false'
      ],
      [scratch, workspace],
      true
    )
    return {
      command: [process.execPath, 'x', '@openai/codex@0.160.0', ...args, '--', ...command],
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        LANG: process.env.LANG ?? 'C.UTF-8',
        HOME: home,
        TMPDIR: scratch,
        CODEX_HOME: extras.CODEX_HOME as string
      },
      cwd
    }
  }
}

export interface StepOneTrialResult {
  success: boolean
  unavailableReason?: string
  usage: StepOneUsage
}

export interface StepOneSuiteInput {
  suite: StepOneSuite
  taskIds: readonly string[]
}

export interface StepOneOptions {
  split: 'development' | 'held-out'
  backend: 'standalone' | 'engine'
  trialsPerTask: number
  bootstrap: { method: BootstrapMethod; seed: number; resamples: number; confidence: number }
  pricing?: { inputUsdPerMillion: number; outputUsdPerMillion: number }
}

export interface StepOneResult {
  kind: 'development-standalone-step-one'
  split: 'development'
  backend: 'standalone'
  trialsPerTask: number
  runs: Array<{
    suite: StepOneSuite
    split: 'development'
    backend: 'standalone'
    adapter: StepOneAdapter
    taskCount: number
    trialsPerTask: number
    tasks: Array<{ taskId: string; successes: number; trials: number; unavailable: string[] }>
    mean: number
    interval: { lower: number; upper: number }
    usage: StepOneUsage
  }>
}

export type StepOneOutcome = { ok: true; value: StepOneResult } | { ok: false; refusal: StepOneRefusal }
export type StepOneExecutor = (input: {
  suite: StepOneSuite
  adapter: StepOneAdapter
  taskId: string
  attempt: number
}) => Promise<StepOneTrialResult>

const refusal = (code: StepOneRefusalCode, detail: string): StepOneOutcome => ({ ok: false, refusal: { code, detail } })

/**
 * Runs milestone step one only. The split and backend checks precede every
 * access to suite inputs, so a refused invocation cannot open held-out data.
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

  const suites = loadDevelopmentSuites()
  const runs: StepOneResult['runs'] = []
  for (const suite of STEP_ONE_SUITES) {
    const input = suites.find((entry) => entry.suite === suite)
    if (input === undefined || input.taskIds.length === 0)
      return refusal('empty_development_split', `${suite} has no reconstructable development task`)
    for (const adapter of STEP_ONE_ADAPTERS) {
      const tasks: Array<{ taskId: string; successes: number; trials: number; unavailable: string[] }> = []
      const usage: StepOneUsage = {
        wallTimeMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        subscriptionQuota: 0,
        estimatedCostUsd: 0
      }
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
          usage.subscriptionQuota =
            usage.subscriptionQuota === null || trial.usage.subscriptionQuota === null
              ? null
              : usage.subscriptionQuota + trial.usage.subscriptionQuota
        }
        tasks.push({ taskId, successes, trials: options.trialsPerTask, unavailable })
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
        usage
      })
    }
  }
  return {
    ok: true,
    value: {
      kind: 'development-standalone-step-one',
      split: 'development',
      backend: 'standalone',
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
  const developerCases = developer.loadCaseFile().cases
  const code = reviewers.loadDevelopment('code-reviewer').cases
  const security = reviewers.loadDevelopment('security-reviewer').cases
  return {
    suites: [
      { suite: 'developer-capability.l5', taskIds: developerCases.map((entry) => entry.id) },
      { suite: 'code-reviewer-quality.l5', taskIds: code.map((entry) => entry.id) },
      { suite: 'security-reviewer-quality.l5', taskIds: security.map((entry) => entry.id) }
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
    )
  }
}

async function installForTrial(workspace: string, untrusted = false): Promise<void> {
  const run = Bun.spawn(
    ['bun', 'install', '--frozen-lockfile', '--silent', ...(untrusted ? ['--ignore-scripts'] : [])],
    {
      cwd: workspace,
      env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), TMPDIR: tmpdir() },
      stdout: 'pipe',
      stderr: 'pipe'
    }
  )
  const code = await run.exited
  if (code !== 0) throw new Error(`trial dependency installation failed: ${await new Response(run.stderr).text()}`)
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
  const manifest = { ...manifestBody, digest: sourceManifest.manifestDigest(manifestBody) }
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
  let toolHost: Awaited<ReturnType<typeof startDevToolsHost>> | null = null
  try {
    const contamination = testContamination(staging, hidden)
    if (!contamination.clean) throw new Error(`trial contamination: ${JSON.stringify(contamination.findings)}`)
    await installForTrial(staging.workspace)
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
    const transcript: string[] = []
    const handle = await dispatchRole('developer', adapterVendor(input.adapter), prompt, {
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
    if (git(staging.workspace, ['status', '--porcelain']).trim() === '') {
      return {
        success: false,
        unavailableReason: 'Developer trial produced no commit-worthy workspace change',
        usage: {
          wallTimeMs: handle.durationMs,
          inputTokens: handle.usage?.input ?? 0,
          outputTokens: handle.usage?.output ?? 0,
          subscriptionQuota: subscriptionQuotaOf(input.adapter, transcript),
          estimatedCostUsd: 0
        }
      }
    }
    try {
      git(staging.workspace, ['add', '-A'])
      git(staging.workspace, [
        '-c',
        'user.name=Vinaya Evaluation',
        '-c',
        'user.email=eval@invalid.local',
        'commit',
        '-m',
        `Eval(developer): Commit ${item.id} trial ${input.attempt}`
      ])
    } catch (error) {
      return {
        success: false,
        unavailableReason: `Developer trial could not be committed: ${(error as Error).message}`,
        usage: {
          wallTimeMs: handle.durationMs,
          inputTokens: handle.usage?.input ?? 0,
          outputTokens: handle.usage?.output ?? 0,
          subscriptionQuota: subscriptionQuotaOf(input.adapter, transcript),
          estimatedCostUsd: 0
        }
      }
    }
    const attribution = attributeTrialObjects(staging, hidden)
    const grading = prepareGradingCopy({
      staging,
      attribution,
      hidden,
      parentDirectory: gradingParent,
      apply: 'fail-to-pass'
    })
    // The submitted tree controls package manifests. Dependency lifecycle
    // scripts are therefore disabled before its tests enter the OS boundary.
    await installForTrial(grading.path, true)
    const testFiles = [
      ...new Set([
        ...item.hiddenTests.files.map((entry) => entry.path),
        ...item.passToPassFiles.map((entry) => entry.path)
      ])
    ]
    let outcomes: ReturnType<typeof suite.outcomesOf>
    try {
      outcomes = suite.outcomesOf(
        await suite.runTests(grading.path, testFiles, context.timeoutMs, gradingIsolation(grading.path))
      )
    } catch (error) {
      return {
        success: false,
        unavailableReason: `Codex grading sandbox unavailable: ${(error as Error).message}`,
        usage: {
          wallTimeMs: handle.durationMs,
          inputTokens: handle.usage?.input ?? 0,
          outputTokens: handle.usage?.output ?? 0,
          subscriptionQuota: subscriptionQuotaOf(input.adapter, transcript),
          estimatedCostUsd: 0
        }
      }
    }
    const changedPaths = git(staging.workspace, ['diff', '--name-only', item.baseCommit]).split('\n').filter(Boolean)
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
      usage: {
        wallTimeMs: handle.durationMs,
        inputTokens: handle.usage?.input ?? 0,
        outputTokens: handle.usage?.output ?? 0,
        subscriptionQuota: subscriptionQuotaOf(input.adapter, transcript),
        estimatedCostUsd: 0
      }
    }
  } finally {
    await toolHost?.close()
    rmSync(parent, { recursive: true, force: true })
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
    const contamination = testContamination(staging, { failToPassTests: {}, referenceSolution: {} })
    if (!contamination.clean) throw new Error(`trial contamination: ${JSON.stringify(contamination.findings)}`)
    const patch = suite.patchBytes(item)
    const headSha = item.patch.source === 'git' ? item.patch.changedCommit : digest(patch)
    const manifestDigest = digest(JSON.stringify({ item: item.id, patch: item.patch.digest }))
    const binding = { role: item.role, headSha, manifestDigest, objectiveIds: item.objectives }
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
      'usage: step-one.ts run --split development --backend standalone --trials <n> --bootstrap <percentile|basic> --seed <n> --resamples <n> --confidence <x> --developer-snapshot <jsonl> --input-cost-per-million <usd> --output-cost-per-million <usd> [--claude-model <m>] [--codex-model <m>] [--timeout-sec <n>] [--out <file>]'
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
