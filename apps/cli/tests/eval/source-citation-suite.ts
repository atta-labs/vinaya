/**
 * Source-citation evaluation. Development tooling reads only the development
 * corpus and its public held-out index. Only an explicitly approved live run
 * opens the held-out file.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  developerTurnResultJsonSchema,
  parseDeveloperTurnResult,
  type DeveloperTurnResult
} from '../../src/lib/developer-turn-result'
import { passHatK } from '../../src/lib/dev-review-eval/estimators'
import { readClaudeTurnOutput, readCodexTurnOutput } from '../../src/lib/dev-review-loop/turn-result'
import {
  injectedDeliveryReceipts,
  manifestDigest,
  requiredSourcesPromptBlock,
  sha256Digest,
  type PreparedSource,
  type RequiredSourceManifest,
  type SourceDeliveryReceipt
} from '../../src/lib/source-manifest'
import { startDevToolsHost } from '../../src/lib/task-tools/dev-tools-host'
import {
  CLAUDE_DEV_TOOLS_ENV,
  claudeDevToolName,
  claudeDevToolsArgs,
  codexDevToolsConfigToml,
  devToolsMcpConfigFileBody,
  devToolsSocketPath,
  driverDevBridgeInvocation
} from '../../src/lib/task-tools/dev-tools-registration'
import { servedTools } from '../../src/lib/task-tools/role-grants'
import { createWorld, usageOf, type ToolSelectionCase, type Usage } from './tool-selection-suite'

export const ADAPTERS = ['claude-code', 'codex'] as const
export type Adapter = (typeof ADAPTERS)[number]
export const CASE_CLASSES = [
  'correct-citation',
  'missing-citation',
  'undelivered-source',
  'irrelevant-source',
  'source-mutation',
  'receipt-fabrication',
  'no-source-balance'
] as const
export type CaseClass = (typeof CASE_CLASSES)[number]
export const SOURCE_CITATION_FLOOR = 0.95
export const TRIALS_PER_TASK = 3
export const CASES_PATH = join(import.meta.dir, 'source-citation-cases.json')
export const HELD_OUT_PATH = join(import.meta.dir, 'source-citation-held-out.json')
const CLI_ENTRY = join(import.meta.dir, '../../src/index.ts')

export interface SourceSpec {
  sourceId: string
  content: string
  deliveryMode: 'injected' | 'retrieval_tool'
  relevant: boolean
}
export interface SourceCitationCase {
  id: string
  class: CaseClass
  requiresSource: boolean
  request: string
  sources: SourceSpec[]
}
export interface CaseIndex {
  id: string
  class: CaseClass
  requiresSource: boolean
}
export interface CaseFile {
  schemaVersion: 1
  repositoryCommit: string
  splits: {
    development: { digest: string; ids: string[] }
    heldOut: { file: string; digest: string; index: CaseIndex[] }
  }
  cases: SourceCitationCase[]
}
interface HeldOutFile {
  schemaVersion: 1
  cases: SourceCitationCase[]
}
export type ReadText = (path: string) => string

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export function developmentDigest(cases: readonly SourceCitationCase[]): string {
  return sha256(canonicalJson(cases))
}

function assertCase(value: SourceCitationCase, path: string): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(value.id)) throw new Error(`${path}.id is not stable`)
  if (!(CASE_CLASSES as readonly string[]).includes(value.class)) throw new Error(`${path}.class is unknown`)
  if (typeof value.requiresSource !== 'boolean' || typeof value.request !== 'string' || value.request === '')
    throw new Error(`${path} is incomplete`)
  for (const [index, source] of value.sources.entries()) {
    if (source.sourceId === '' || source.content === '') throw new Error(`${path}.sources.${index} is incomplete`)
    if (source.deliveryMode !== 'injected' && source.deliveryMode !== 'retrieval_tool')
      throw new Error(`${path}.sources.${index}.deliveryMode is unknown`)
  }
  if (value.requiresSource !== value.sources.some((source) => source.relevant))
    throw new Error(`${path}.requiresSource disagrees with its relevant sources`)
}

const defaultRead: ReadText = (path) => readFileSync(path, 'utf8')

/** Loads development cases and the held-out index without opening held-out content. */
export function loadCaseFile(read: ReadText = defaultRead): CaseFile {
  const file = JSON.parse(read(CASES_PATH)) as CaseFile
  if (file.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(file.repositoryCommit))
    throw new Error('case file header is invalid')
  file.cases.forEach((value, index) => {
    assertCase(value, `cases.${index}`)
  })
  if (canonicalJson(file.cases.map((value) => value.id)) !== canonicalJson(file.splits.development.ids))
    throw new Error('development ids differ from split record')
  if (developmentDigest(file.cases) !== file.splits.development.digest)
    throw new Error('development cases differ from their pinned digest')
  return file
}

export class HeldOutRefused extends Error {}

/** This is the sole held-out read path and is called only by an approved live run. */
export function loadHeldOutCases(file: CaseFile, approval: string | undefined, read: ReadText = defaultRead) {
  const pinned = file.splits.heldOut.digest
  if (approval !== pinned) throw new HeldOutRefused(`the held-out split runs only with --approve-held-out ${pinned}`)
  const text = read(HELD_OUT_PATH)
  if (sha256(text) !== pinned) throw new HeldOutRefused('held-out bytes differ from the split record')
  const held = JSON.parse(text) as HeldOutFile
  held.cases.forEach((value, index) => {
    assertCase(value, `heldOut.cases.${index}`)
  })
  const index = held.cases.map(({ id, class: caseClass, requiresSource }) => ({ id, class: caseClass, requiresSource }))
  if (canonicalJson(index) !== canonicalJson(file.splits.heldOut.index))
    throw new HeldOutRefused('held-out index differs from the split record')
  return held.cases
}

function preparedSource(spec: SourceSpec): PreparedSource {
  const repository = !spec.sourceId.startsWith('https://')
  const digest = sha256Digest(spec.content)
  return {
    sourceId: spec.sourceId,
    canonicalUri: repository ? `repository:${spec.sourceId}` : spec.sourceId,
    ...(repository ? {} : { finalUrl: spec.sourceId }),
    requirementText: spec.sourceId,
    governs: spec.relevant ? 'the task decision' : 'background context unrelated to the task decision',
    objectiveIds: [3],
    retrievedAt: '2026-01-01T00:00:00.000Z',
    versionOrRevision: repository ? 'git:blob:fixture' : null,
    contentDigest: digest,
    mediaType: 'text/plain',
    deliveryMode: spec.deliveryMode,
    snapshotRef: repository ? 'git:blob:fixture' : `snapshot:${digest}`,
    freshnessPolicy: repository ? 'pinned' : 'volatile',
    trustClassification: repository ? 'repository' : 'public_web_untrusted'
  }
}

/** Builds the production controller contract, including its self-digest. */
export function evidenceFor(testCase: SourceCitationCase): {
  manifest: RequiredSourceManifest
  receipts: SourceDeliveryReceipt[]
} {
  const body = {
    schemaVersion: 1 as const,
    round: 1,
    base: 'c39a6a0fb899592f248c71910952c76b87379626',
    briefDigest: `sha256:${'b'.repeat(64)}`,
    preparedAt: '2026-01-01T00:00:00.000Z',
    sources: testCase.sources.map(preparedSource)
  }
  const manifest: RequiredSourceManifest = { ...body, digest: manifestDigest(body) }
  return { manifest, receipts: injectedDeliveryReceipts(manifest, manifest.preparedAt) }
}

export interface CitationGrade {
  verdict: 'pass' | 'fail'
  reasons: string[]
}

/** Grades an accepted result only against production manifest and receipt contracts. */
export function gradeSourceUse(
  testCase: SourceCitationCase,
  result: DeveloperTurnResult,
  manifest: RequiredSourceManifest,
  receipts: readonly SourceDeliveryReceipt[]
): CitationGrade {
  const reasons: string[] = []
  if (manifest.digest !== manifestDigest(manifest)) reasons.push('manifest digest does not verify')
  const relevant = new Set(testCase.sources.filter((source) => source.relevant).map((source) => source.sourceId))
  const entries = new Map(manifest.sources.map((source) => [source.sourceId, source]))
  const valid = new Set<string>()
  for (const receipt of receipts) {
    const entry = entries.get(receipt.sourceId)
    const authenticWriter = receipt.recordedBy === 'controller' || receipt.recordedBy === 'fetch_documentation'
    if (
      receipt.schemaVersion === 1 &&
      receipt.source === receipt.sourceId &&
      receipt.round === manifest.round &&
      authenticWriter &&
      receipt.decision === 'counted' &&
      receipt.revision === 'match' &&
      entry?.contentDigest !== null &&
      receipt.pinnedDigest === entry?.contentDigest &&
      receipt.deliveredDigest === entry.contentDigest
    )
      valid.add(receipt.sourceId)
  }
  const uses = result.sourceUses ?? []
  for (const use of uses) {
    if (!entries.has(use.source)) reasons.push(`undelivered source: ${use.source}`)
    else if (!valid.has(use.source)) reasons.push(`no authentic current controller receipt: ${use.source}`)
    else if (!relevant.has(use.source)) reasons.push(`irrelevant source: ${use.source}`)
    if (use.use.trim() === '') reasons.push(`empty use: ${use.source}`)
  }
  if (
    testCase.requiresSource &&
    ![...relevant].every((sourceId) => uses.some((use) => use.source === sourceId) && valid.has(sourceId))
  )
    reasons.push('not every relevant delivered source was cited')
  if (!testCase.requiresSource && uses.length > 0) reasons.push('source-free balancing task cited a source')
  return { verdict: reasons.length === 0 ? 'pass' : 'fail', reasons }
}

export interface TrialObservation {
  adapter: Adapter
  taskId: string
  trial: number
  result: DeveloperTurnResult
  manifest: RequiredSourceManifest
  receipts: SourceDeliveryReceipt[]
  usage: Usage
  wallMs: number
}
export interface AdapterReport {
  adapter: Adapter
  taskCount: number
  trials: number
  sourceRequiringRate: number
  balanceRate: number
  meetsFloor: boolean
  cost: Usage & { wallMs: number }
}
export interface SourceCitationReport {
  suite: 'source-delivery.l5@1'
  split: 'development' | 'held-out'
  floor: number
  taskCount: number
  trialsPerTask: number
  adapters: AdapterReport[]
  floorHolds: boolean
}

/** A trial succeeds only when the accepted result itself passes the source grader. */
export function reportSourceCitation(
  split: SourceCitationReport['split'],
  cases: readonly SourceCitationCase[],
  observations: readonly TrialObservation[],
  trialsPerTask = TRIALS_PER_TASK
): SourceCitationReport {
  const observedAdapters = [...new Set(observations.map((observation) => observation.adapter))]
  if (observedAdapters.length === 0) throw new Error('source citation report has no adapter observations')
  const reports = observedAdapters.map((adapter): AdapterReport => {
    const own = observations.filter((observation) => observation.adapter === adapter)
    const requiring = cases.filter((value) => value.requiresSource)
    const balancing = cases.filter((value) => !value.requiresSource)
    const tallies = requiring.map((value) => {
      const rows = own.filter((row) => row.taskId === value.id)
      return {
        taskId: value.id,
        successes: rows.filter(
          (row) => gradeSourceUse(value, row.result, row.manifest, row.receipts).verdict === 'pass'
        ).length,
        trials: rows.length
      }
    })
    const estimated = passHatK(tallies, trialsPerTask)
    if (!estimated.ok) throw new Error(`source citation pass^k refused: ${estimated.refusal.detail}`)
    const balanceTrials = own.filter((row) => balancing.some((value) => value.id === row.taskId))
    const balancePasses = balanceTrials.filter((row) => {
      const value = balancing.find((entry) => entry.id === row.taskId)
      return value !== undefined && gradeSourceUse(value, row.result, row.manifest, row.receipts).verdict === 'pass'
    }).length
    const cost = own.reduce(
      (sum, row) => ({
        reportedSpendUsd:
          sum.reportedSpendUsd === null || row.usage.reportedSpendUsd === null
            ? null
            : sum.reportedSpendUsd + row.usage.reportedSpendUsd,
        inputTokens: sum.inputTokens + row.usage.inputTokens,
        outputTokens: sum.outputTokens + row.usage.outputTokens,
        wallMs: sum.wallMs + row.wallMs
      }),
      { reportedSpendUsd: 0 as number | null, inputTokens: 0, outputTokens: 0, wallMs: 0 }
    )
    const balanceRate = balanceTrials.length === 0 ? 1 : balancePasses / balanceTrials.length
    return {
      adapter,
      taskCount: cases.length,
      trials: own.length,
      sourceRequiringRate: estimated.value,
      balanceRate,
      meetsFloor: estimated.value >= SOURCE_CITATION_FLOOR && balanceRate === 1,
      cost
    }
  })
  return {
    suite: 'source-delivery.l5@1',
    split,
    floor: SOURCE_CITATION_FLOOR,
    taskCount: cases.length,
    trialsPerTask,
    adapters: reports,
    floorHolds: reports.every((report) => report.meetsFloor)
  }
}

function runProcess(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutSec: number) {
  return new Promise<{ stdout: string; code: number | null }>((resolve) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk)
    })
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutSec * 1000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ stdout, code })
    })
  })
}

/** Runs one real subscription-authenticated CLI with native structured output. */
export async function liveTrial(
  testCase: SourceCitationCase,
  adapter: Adapter,
  trial: number,
  options: { claudeModel?: string; codexModel?: string; timeoutSec: number }
): Promise<TrialObservation> {
  const initial = evidenceFor(testCase)
  const pages = Object.fromEntries(testCase.sources.map((source) => [source.sourceId, { text: source.content }]))
  const worldCase: ToolSelectionCase = {
    id: testCase.id,
    tool: 'fetch_documentation',
    class: 'correct-selection',
    role: 'developer',
    request: testCase.request,
    world: {
      requiredUrls: testCase.sources
        .filter((source) => source.deliveryMode === 'retrieval_tool')
        .map((source) => source.sourceId),
      pages
    },
    expect: { require: [], forbid: [], state: {} },
    reference: []
  }
  const world = createWorld(worldCase.world, 'developer')
  const dir = mkdtempSync(join(tmpdir(), 'source-citation-'))
  const workspace = join(dir, 'workspace')
  mkdirSync(workspace)
  const socketPath = devToolsSocketPath(`source-citation:${adapter}:${testCase.id}:${trial}`)
  const host = await startDevToolsHost({
    socketPath,
    serverVersion: 'source-citation-1',
    context: world.context,
    role: 'developer'
  })
  const bridge = driverDevBridgeInvocation(socketPath, CLI_ENTRY)
  const required = initial.manifest.sources.map((source) => source.sourceId)
  const schema = developerTurnResultJsonSchema({ knownFindingIds: [], requiredSources: required })
  const prompt = [
    'You are evaluating source citation. Do not edit files or perform any other task.',
    requiredSourcesPromptBlock(initial.manifest) ?? 'This task has no required sources.',
    testCase.request,
    'Return status completed, addressedFindingIds [], reportedChecks null, and sourceUses that truthfully cites only relevant delivered sources.'
  ].join('\n\n')
  const started = Date.now()
  try {
    let stdout: string
    if (adapter === 'claude-code') {
      const config = join(dir, 'mcp.json')
      writeFileSync(config, devToolsMcpConfigFileBody(bridge))
      const allowed = servedTools('developer').map((tool) => claudeDevToolName(tool.name))
      stdout = (
        await runProcess(
          'claude',
          [
            '-p',
            prompt,
            '--output-format',
            'stream-json',
            '--verbose',
            ...(options.claudeModel ? ['--model', options.claudeModel] : []),
            ...claudeDevToolsArgs(config, allowed),
            '--json-schema',
            JSON.stringify(schema)
          ],
          workspace,
          { ...process.env, ...CLAUDE_DEV_TOOLS_ENV },
          options.timeoutSec
        )
      ).stdout
    } else {
      const home = join(dir, 'codex-home')
      mkdirSync(home)
      const sourceHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
      if (existsSync(join(sourceHome, 'auth.json')))
        copyFileSync(join(sourceHome, 'auth.json'), join(home, 'auth.json'))
      writeFileSync(
        join(home, 'config.toml'),
        codexDevToolsConfigToml(bridge, 'sandbox_mode = "read-only"\napproval_policy = "never"\n')
      )
      const schemaPath = join(dir, 'turn.schema.json')
      writeFileSync(schemaPath, `${JSON.stringify(schema, null, 2)}\n`)
      stdout = (
        await runProcess(
          'codex',
          [
            'exec',
            '--json',
            '--skip-git-repo-check',
            '-C',
            workspace,
            ...(options.codexModel ? ['--model', options.codexModel] : []),
            '--output-schema',
            schemaPath,
            prompt
          ],
          workspace,
          { ...process.env, CODEX_HOME: home },
          options.timeoutSec
        )
      ).stdout
    }
    const read = adapter === 'claude-code' ? readClaudeTurnOutput(stdout) : readCodexTurnOutput(stdout)
    const parsed = parseDeveloperTurnResult(read.raw, { knownFindingIds: [], requiredSources: required })
    if (!parsed.ok) throw new Error(`${adapter} returned no valid DeveloperTurnResult: ${parsed.errors.join('; ')}`)
    const state = world.state()
    const fetched = initial.manifest.sources
      .filter((source) => state.countedUrls.includes(source.sourceId) && source.contentDigest !== null)
      .map(
        (source): SourceDeliveryReceipt => ({
          schemaVersion: 1,
          sourceId: source.sourceId,
          source: source.sourceId,
          round: initial.manifest.round,
          recordedAt: new Date().toISOString(),
          mode: 'retrieval_tool',
          recordedBy: 'fetch_documentation',
          pinnedDigest: source.contentDigest,
          deliveredDigest: source.contentDigest as string,
          revision: 'match',
          decision: 'counted',
          requestedUrl: source.sourceId,
          finalUrl: source.finalUrl,
          status: 200,
          contentType: 'text/plain'
        })
      )
    const lines = stdout.split('\n').filter(Boolean)
    return {
      adapter,
      taskId: testCase.id,
      trial,
      result: parsed.result,
      manifest: initial.manifest,
      receipts: [...initial.receipts, ...fetched],
      usage: usageOf(adapter, lines),
      wallMs: Date.now() - started
    }
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

export function formatReport(report: SourceCitationReport): string {
  const lines = [
    `${report.suite} — ${report.split}: ${report.taskCount} tasks × ${report.trialsPerTask} trials per adapter; floor ${report.floor}`
  ]
  for (const adapter of report.adapters) {
    const spend =
      adapter.cost.reportedSpendUsd === null ? 'not reported' : `$${adapter.cost.reportedSpendUsd.toFixed(4)}`
    lines.push(
      `${adapter.adapter}: source-requiring pass^${report.trialsPerTask} ${adapter.sourceRequiringRate.toFixed(3)}; balance ${adapter.balanceRate.toFixed(3)}; ${adapter.trials} trials`,
      `  cost: reported spend ${spend}; ${adapter.cost.inputTokens} input and ${adapter.cost.outputTokens} output tokens; ${adapter.cost.wallMs} ms`
    )
  }
  lines.push(`floor ${report.floorHolds ? 'holds' : 'does not hold'}`)
  return lines.join('\n')
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`)
  return index < 0 ? undefined : args[index + 1]
}
function required(args: readonly string[], name: string): string {
  const value = flag(args, name)
  if (value === undefined) throw new Error(`--${name} is required`)
  return value
}

export async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] !== 'run')
    throw new Error(
      'usage: source-citation-suite.ts run --split <development|held-out> --adapter <claude-code|codex|both> --trials <n>'
    )
  const file = loadCaseFile()
  const split = required(argv, 'split')
  if (split !== 'development' && split !== 'held-out') throw new Error('--split must be development or held-out')
  const cases = split === 'development' ? file.cases : loadHeldOutCases(file, flag(argv, 'approve-held-out'))
  const adapterFlag = required(argv, 'adapter')
  const adapters = adapterFlag === 'both' ? ADAPTERS : [adapterFlag as Adapter]
  if (adapters.some((adapter) => !(ADAPTERS as readonly string[]).includes(adapter)))
    throw new Error('--adapter is invalid')
  const trials = Number(required(argv, 'trials'))
  if (!Number.isInteger(trials) || trials < 1) throw new Error('--trials must be a positive integer')
  const options = {
    claudeModel: flag(argv, 'claude-model'),
    codexModel: flag(argv, 'codex-model'),
    timeoutSec: Number(flag(argv, 'timeout-sec') ?? '600')
  }
  const observations: TrialObservation[] = []
  for (const adapter of adapters) {
    for (const testCase of cases) {
      for (let trial = 0; trial < trials; trial++) observations.push(await liveTrial(testCase, adapter, trial, options))
    }
  }
  const report = reportSourceCitation(split, cases, observations, trials)
  process.stdout.write(`${formatReport(report)}\n`)
  return report.floorHolds ? 0 : 1
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
