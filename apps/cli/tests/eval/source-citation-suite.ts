/**
 * Source-citation evaluation. The development corpus and its split record live
 * in `source-citation-cases.json`; held-out content is opened only after an
 * explicit digest approval on a run command.
 *
 *   bun apps/cli/tests/eval/source-citation-suite.ts run --split development
 *   bun apps/cli/tests/eval/source-citation-suite.ts run --split held-out \
 *     --approve-held-out <sha256>
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { passHatK } from '../../src/lib/dev-review-eval/estimators'

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

export interface ManifestSource {
  source: string
  sha256: string
  relevant: boolean
}
export interface DeliveryReceipt {
  source: string
  sha256: string
  recorded: boolean
  decision: 'counted' | 'refused'
}
export interface SourceUse {
  source: string
  use: string
}
export interface AcceptedResult {
  status: string
  sourceUses?: SourceUse[] | null
}
export interface SourceCitationCase {
  id: string
  class: CaseClass
  requiresSource: boolean
  request: string
  manifest: ManifestSource[]
  receipts: DeliveryReceipt[]
  acceptedResult: AcceptedResult
  expectedPass: boolean
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
export interface HeldOutFile {
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
  if (!Array.isArray(value.manifest) || !Array.isArray(value.receipts))
    throw new Error(`${path} source evidence is invalid`)
  for (const source of value.manifest) {
    if (!/^[a-f0-9]{64}$/.test(source.sha256) || source.source === '') throw new Error(`${path}.manifest is invalid`)
  }
  for (const receipt of value.receipts) {
    if (!/^[a-f0-9]{64}$/.test(receipt.sha256) || receipt.source === '') throw new Error(`${path}.receipts is invalid`)
  }
}

const defaultRead: ReadText = (path) => readFileSync(path, 'utf8')

/** Loads and validates development data without ever opening the held-out file. */
export function loadCaseFile(read: ReadText = defaultRead): CaseFile {
  const file = JSON.parse(read(CASES_PATH)) as CaseFile
  if (file.schemaVersion !== 1 || !/^[a-f0-9]{40}$/.test(file.repositoryCommit))
    throw new Error('case file header is invalid')
  file.cases.forEach((value, index) => {
    assertCase(value, `cases.${index}`)
  })
  const ids = file.cases.map((value) => value.id)
  if (canonicalJson(ids) !== canonicalJson(file.splits.development.ids))
    throw new Error('development ids differ from split record')
  if (developmentDigest(file.cases) !== file.splits.development.digest)
    throw new Error('development cases differ from their pinned digest')
  return file
}

export class HeldOutRefused extends Error {}

/** Opens held-out content only after the caller approves the digest pinned by the split record. */
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

export interface CitationGrade {
  verdict: 'pass' | 'fail'
  reasons: string[]
}

/**
 * Grades only controller evidence: source identities in the accepted result
 * must have a counted controller receipt at the manifest's current digest.
 */
export function gradeSourceUse(testCase: SourceCitationCase, result = testCase.acceptedResult): CitationGrade {
  const reasons: string[] = []
  const uses = result.sourceUses ?? []
  const manifest = new Map(testCase.manifest.map((source) => [source.source, source]))
  const valid = new Set(
    testCase.receipts
      .filter((receipt) => {
        const source = manifest.get(receipt.source)
        return receipt.recorded && receipt.decision === 'counted' && source?.sha256 === receipt.sha256
      })
      .map((receipt) => receipt.source)
  )
  for (const use of uses) {
    const source = manifest.get(use.source)
    if (source === undefined) reasons.push(`undelivered source: ${use.source}`)
    else if (!valid.has(use.source)) reasons.push(`no current controller receipt: ${use.source}`)
    else if (!source.relevant) reasons.push(`irrelevant source: ${use.source}`)
    if (use.use.trim() === '') reasons.push(`empty use: ${use.source}`)
  }
  if (testCase.requiresSource && !uses.some((use) => valid.has(use.source) && manifest.get(use.source)?.relevant))
    reasons.push('no relevant delivered source cited')
  if (!testCase.requiresSource && uses.length > 0) reasons.push('source-free balancing task cited a source')
  return { verdict: reasons.length === 0 ? 'pass' : 'fail', reasons }
}

export interface TrialObservation {
  adapter: Adapter
  taskId: string
  trial: number
  result: AcceptedResult
  cost: { reportedSpendUsd: number | null; inputTokens: number; outputTokens: number; wallMs: number }
}
export interface AdapterReport {
  adapter: Adapter
  taskCount: number
  trials: number
  sourceRequiringTasks: number
  sourceRequiringRate: number
  balanceRate: number
  meetsFloor: boolean
  cost: TrialObservation['cost']
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

/** Builds the fixed-floor report from controller-accepted results. */
export function reportSourceCitation(
  split: SourceCitationReport['split'],
  cases: readonly SourceCitationCase[],
  observations: readonly TrialObservation[]
): SourceCitationReport {
  const passes = (testCase: SourceCitationCase, result: AcceptedResult) =>
    (gradeSourceUse(testCase, result).verdict === 'pass') === testCase.expectedPass
  const reports = ADAPTERS.map((adapter): AdapterReport => {
    const own = observations.filter((observation) => observation.adapter === adapter)
    const requiring = cases.filter((value) => value.requiresSource)
    const balancing = cases.filter((value) => !value.requiresSource)
    const tallies = requiring.map((value) => {
      const rows = own.filter((row) => row.taskId === value.id)
      return {
        taskId: value.id,
        successes: rows.filter((row) => passes(value, row.result)).length,
        trials: rows.length
      }
    })
    const estimated = passHatK(tallies, TRIALS_PER_TASK)
    if (!estimated.ok) throw new Error(`source citation pass^k refused: ${estimated.refusal.detail}`)
    const balanceTrials = own.filter((row) => balancing.some((value) => value.id === row.taskId))
    const balancePasses = balanceTrials.filter((row) => {
      const value = balancing.find((entry) => entry.id === row.taskId)
      return value !== undefined && passes(value, row.result)
    }).length
    const cost = own.reduce(
      (sum, row) => ({
        reportedSpendUsd:
          sum.reportedSpendUsd === null || row.cost.reportedSpendUsd === null
            ? null
            : sum.reportedSpendUsd + row.cost.reportedSpendUsd,
        inputTokens: sum.inputTokens + row.cost.inputTokens,
        outputTokens: sum.outputTokens + row.cost.outputTokens,
        wallMs: sum.wallMs + row.cost.wallMs
      }),
      { reportedSpendUsd: 0 as number | null, inputTokens: 0, outputTokens: 0, wallMs: 0 }
    )
    const balanceRate = balanceTrials.length === 0 ? 1 : balancePasses / balanceTrials.length
    return {
      adapter,
      taskCount: cases.length,
      trials: own.length,
      sourceRequiringTasks: requiring.length,
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
    trialsPerTask: TRIALS_PER_TASK,
    adapters: reports,
    floorHolds: reports.every((report) => report.meetsFloor)
  }
}

/** Deterministic CI observations replay each planted accepted result on both adapter identities. */
export function replayObservations(cases: readonly SourceCitationCase[]): TrialObservation[] {
  return ADAPTERS.flatMap((adapter) =>
    cases.flatMap((testCase) =>
      Array.from({ length: TRIALS_PER_TASK }, (_, trial) => ({
        adapter,
        taskId: testCase.id,
        trial,
        result: testCase.acceptedResult,
        cost: { reportedSpendUsd: 0, inputTokens: 0, outputTokens: 0, wallMs: 0 }
      }))
    )
  )
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

export function main(argv: readonly string[]): number {
  if (argv[0] !== 'run') throw new Error('usage: source-citation-suite.ts run --split <development|held-out>')
  const file = loadCaseFile()
  const split = flag(argv, 'split')
  if (split !== 'development' && split !== 'held-out') throw new Error('--split must be development or held-out')
  const cases = split === 'development' ? file.cases : loadHeldOutCases(file, flag(argv, 'approve-held-out'))
  const report = reportSourceCitation(split, cases, replayObservations(cases))
  process.stdout.write(`${formatReport(report)}\n`)
  return report.floorHolds ? 0 : 1
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
