/**
 * What a phase typically takes in THIS repository — read off the pull
 * requests of its own recently merged tasks, never predicted.
 *
 * One bounded read per process: the most recent merged task branches
 * (`MERGED_TASK_PR_READ_CAP` of them), each pull request's comments fetched
 * once, every interval extracted by the pure reader in `@attalabs/aeg-core`
 * (`phaseSamplesFromPrComments`) from PRINCIPAL-AUTHORED comments only — the
 * same trust boundary every other forge read in this loop applies, so a
 * non-principal commenter cannot post a round-marker- or verdict-shaped
 * comment and move what this repository reports as typical.
 *
 * Cached for the lifetime of the process, INCLUDING a failed read: a status
 * read that could not reach the forge reports no typical time and does not try
 * again row by row. A forge failure is never an error here — `task status` and
 * `task_status` still answer, with the typical-time column empty.
 *
 * Nothing here is a forecast. The figures are medians of work that already
 * merged, and the fields carrying them say so (`typicalPhaseMinutes`,
 * `typicalPhaseSamples`).
 */

import { execFileSync } from 'node:child_process'
import {
  emptyPhaseSamples,
  phaseHistoryClassFor,
  phaseSamplesFromPrComments,
  summarizePhaseSamples,
  type HistoryComment,
  type PhaseSamples,
  type TaskPhaseHistory
} from '@attalabs/aeg-core'
import { loadTrustAnchorConfig, resolvePrincipalAllowlist } from './config.js'

/** How many merged task pull requests the history read may open. Bounded on purpose: a status read is a glance, and the newest few merged tasks are what "typical in this repository, lately" means. */
export const MERGED_TASK_PR_READ_CAP = 5

/** How deep the merged-pull-request LIST goes before the task branches in it are capped — merges of non-task branches (a release, a hand-made fix) are filtered out, so the list has to be a little longer than the cap. */
const MERGED_PR_LIST_LIMIT = 30

/** Same ceiling every other `gh` comment read in this codebase raises for itself: a task's comment history can pass `execFileSync`'s own 1 MiB default. */
const MAX_GH_OUTPUT_BYTES = 64 * 1024 * 1024

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_GH_OUTPUT_BYTES
  }).trim()
}

type MergedPr = { number: number; headRefName: string; mergedAt: string }

/** The newest merged TASK pull requests, newest first, capped — a merge on any other branch shape carries no round markers and is not a task's history. */
export function mergedTaskPrNumbers(raw: string, cap: number = MERGED_TASK_PR_READ_CAP): number[] {
  const parsed = JSON.parse(raw) as MergedPr[]
  return parsed
    .filter((pr) => typeof pr.headRefName === 'string' && pr.headRefName.startsWith('task/'))
    .sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt))
    .slice(0, cap)
    .map((pr) => pr.number)
}

function parseComments(raw: string): HistoryComment[] {
  const parsed = JSON.parse(raw) as {
    comments: { body: string; author?: { login?: string } | null; createdAt?: string }[]
  }
  return parsed.comments
    .filter((c) => typeof c.createdAt === 'string')
    .map((c) => ({ body: c.body, author: c.author?.login ?? null, createdAt: c.createdAt as string }))
}

/** Every interval the given pull requests' comments record, pooled — one entry per interval, so a phase's sample count is the real number of past intervals behind its median. */
export function phaseSamplesFromMergedPrs(
  prComments: readonly (readonly HistoryComment[])[],
  allowlist: readonly string[]
): PhaseSamples {
  const pooled = emptyPhaseSamples()
  for (const comments of prComments) {
    const samples = phaseSamplesFromPrComments(comments, allowlist)
    pooled.developing.push(...samples.developing)
    pooled.reviewing.push(...samples.reviewing)
  }
  return pooled
}

/** The typical time for the phase a run is recorded in, or `null` — no history class for that phase, or too few past intervals to answer. */
export type PhaseHistoryLookup = (recordedPhase: string) => TaskPhaseHistory | null

export function phaseHistoryLookupFor(samples: PhaseSamples): PhaseHistoryLookup {
  return (recordedPhase: string) => {
    const phaseClass = phaseHistoryClassFor(recordedPhase)
    if (phaseClass === null) return null
    return summarizePhaseSamples(samples[phaseClass])
  }
}

/** Every `gh` read this module makes, so a test can hand it fixtures instead of a forge. */
export type HistoryReadDeps = {
  listMergedPrs: () => string
  fetchPrComments: (pr: number) => string
  allowlist: () => string[]
}

export const defaultHistoryReadDeps: HistoryReadDeps = {
  listMergedPrs: () =>
    sh('gh', [
      'pr',
      'list',
      '--state',
      'merged',
      '--json',
      'number,headRefName,mergedAt',
      '--limit',
      String(MERGED_PR_LIST_LIMIT)
    ]),
  fetchPrComments: (pr: number) => sh('gh', ['pr', 'view', String(pr), '--json', 'comments']),
  allowlist: () => resolvePrincipalAllowlist(loadTrustAnchorConfig())
}

/**
 * The whole read, bounded at `1 + MERGED_TASK_PR_READ_CAP` forge calls. A
 * failure anywhere — the list read, one pull request's comments, malformed
 * JSON — costs that source's samples and nothing else: the surviving samples
 * still answer, and a total failure answers "no typical time" rather than
 * raising.
 */
export function readPhaseSamples(deps: HistoryReadDeps = defaultHistoryReadDeps): PhaseSamples {
  let numbers: number[]
  try {
    numbers = mergedTaskPrNumbers(deps.listMergedPrs())
  } catch {
    return emptyPhaseSamples()
  }
  const allowlist = deps.allowlist()
  const perPr: HistoryComment[][] = []
  for (const pr of numbers) {
    try {
      perPr.push(parseComments(deps.fetchPrComments(pr)))
    } catch {
      // This pull request contributes no interval; the others still do.
    }
  }
  return phaseSamplesFromMergedPrs(perPr, allowlist)
}

let cachedSamples: PhaseSamples | null = null

/**
 * The process-wide lookup every status row shares. The forge read happens at
 * most once per process — a `task status` listing ten tasks pays for it once,
 * and so does one `task_status` call over the same ten.
 */
export function phaseHistoryLookup(): PhaseHistoryLookup {
  if (cachedSamples === null) cachedSamples = readPhaseSamples()
  return phaseHistoryLookupFor(cachedSamples)
}

/** Drops the per-process cache — for a test that reads history twice with different fixtures; production never calls it. */
export function resetPhaseHistoryCache(): void {
  cachedSamples = null
}
