import { execFileSync } from 'node:child_process'
import type { CheckError } from '../../../../kernel/gates/checks/contract'
import { parseRationaleFields } from './brief-render'
import {
  boundaryPinnedFiles,
  decidePinnedFileImporters,
  parseIssueSurface,
  type PinnedFileImporters
} from './issue-validation'

export type UnchangedRename = { from: string; to: string }
export type PlanRepair = { body: string; reasons: string[] }

/** Only git's R100 records qualify, and the destination must still have that exact blob at HEAD. */
export function readUnchangedRenames(root: string, pins?: readonly string[]): UnchangedRename[] {
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024
    }).trim()
  const blob = (revision: string): string | null => {
    try {
      return git('rev-parse', '--verify', revision)
    } catch {
      return null
    }
  }
  const renames: UnchangedRename[] = []
  let commit = ''
  for (const line of git(
    'log',
    '--format=commit:%H',
    '--name-status',
    '--find-renames=100%',
    '--diff-filter=R',
    'HEAD'
  ).split('\n')) {
    if (line.startsWith('commit:')) {
      commit = line.slice(7)
      continue
    }
    const [status, from, to, extra] = line.split('\t')
    if (status !== 'R100' || !from || !to || extra !== undefined || !commit) continue
    if (pins && !pins.includes(from)) continue
    const current = blob(`HEAD:${to}`)
    if (blob(`HEAD:${from}`) === null && current !== null && current === blob(`${commit}:${to}`))
      renames.push({ from, to })
  }
  return renames
}

function objectives(body: string): string {
  return JSON.stringify(
    [...body.matchAll(/^##[ \t]+Objectives[^\n]*\n[\s\S]*?(?=^##[ \t]|$(?![\s\S]))/gim)].map((m) => m[0])
  )
}

/** Defence at the write boundary, including when a caller supplies a proposed repair. */
export function repairPreservesScope(before: string, after: string): boolean {
  const oldSurface = parseIssueSurface(before)
  const newSurface = parseIssueSurface(after)
  return (
    objectives(before) === objectives(after) &&
    oldSurface.ok &&
    newSurface.ok &&
    JSON.stringify([...oldSurface.value.in].sort()) === JSON.stringify([...newSurface.value.in].sort())
  )
}

/**
 * Proposes only factual path repairs; never classifies findings by their prose.
 * The caller keeps nothing unless the SAME Issue write gate accepts the entire candidate.
 */
export async function repairPlan(input: {
  body: string
  findings: readonly CheckError[]
  importers: (body: string) => PinnedFileImporters[]
  renames: readonly UnchangedRename[]
  validate: (body: string) => Promise<readonly CheckError[]>
}): Promise<PlanRepair | null> {
  if (!input.findings.some((f) => f.severity !== 'warning')) return null
  let body = input.body
  const reasons: string[] = []
  for (const pin of boundaryPinnedFiles(body)) {
    const matches = input.renames.filter((r) => r.from === pin)
    const destinations = [...new Set(matches.map((r) => r.to))]
    if (destinations.length !== 1) continue
    const to = destinations[0] as string
    const escaped = pin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    body = body.replace(new RegExp(`(?<![\\w./-])${escaped}(?![\\w./-])`, 'g'), () => to)
    reasons.push(
      `Replaced renamed pin \`${pin}\` with \`${to}\`: git reports an unchanged-content rename and the destination still has that blob.`
    )
  }
  const intendedPins = boundaryPinnedFiles(body).sort()
  const undecided = decidePinnedFileImporters(body, input.importers(body))
  const uncovered = [
    ...new Set(
      (undecided ?? []).flatMap((f) => f.importers.filter((d) => d.state === 'uncovered').map((d) => d.importer))
    )
  ].sort()
  if (uncovered.length > 0) {
    const boundary = parseRationaleFields(body).boundary
    if (!boundary) return null
    const suffix = `${/\bOut\s*:/i.test(boundary) ? '' : 'Out: '}Importers outside this task: ${uncovered.map((p) => `\`${p}\``).join(', ')}.`
    body = body.replace(boundary, () => `${boundary}\n${suffix}`)
    reasons.push(
      ...uncovered.map((p) => `Declared uncovered importer \`${p}\` out of scope without adding a Surface in: glob.`)
    )
  }
  if (
    reasons.length === 0 ||
    !repairPreservesScope(input.body, body) ||
    JSON.stringify(boundaryPinnedFiles(body).sort()) !== JSON.stringify(intendedPins)
  )
    return null
  const findings = await input.validate(body)
  if (findings.some((f) => f.severity !== 'warning')) return null
  return { body, reasons }
}

export const DEPENDENCY_WAIT_INTERVAL_MS = 30_000
export const DEPENDENCY_WAIT_BOUND_MS = 30 * 60_000
export type DependencyWaitClock = { now: () => number; sleep: (ms: number) => Promise<void> }
const realClock: DependencyWaitClock = { now: Date.now, sleep: (ms) => new Promise((done) => setTimeout(done, ms)) }

/** Recheck only dependency-only failures, at a fixed cadence and within one total deadline. */
export async function waitForDependencies<T>(
  check: () => T | Promise<T>,
  dependencyOnly: (result: T) => boolean,
  clock: DependencyWaitClock = realClock
): Promise<T> {
  const deadline = clock.now() + DEPENDENCY_WAIT_BOUND_MS
  let result = await check()
  while (dependencyOnly(result) && clock.now() < deadline) {
    await clock.sleep(Math.min(DEPENDENCY_WAIT_INTERVAL_MS, deadline - clock.now()))
    result = await check()
  }
  return result
}
