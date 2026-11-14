#!/usr/bin/env bun
/**
 * The test independence check: does any test file's result depend on what else is running beside it?
 *
 *   bun scripts/test-suites/independence-check.ts --placement <build|shared|shard-N> [--summary <file>]
 *
 * It builds one CI placement's full schedule with the scheduler's own exports ({@link ciScheduleInput},
 * {@link buildTestSchedule}), exactly as a push to the default branch runs it, and runs every file of it twice
 * through {@link runGroups} on the same commit and checkout: once one file at a time ({@link ALONE}), then eight at a
 * time ({@link TOGETHER}, twice the default the CI runs use under load). Each pass is a run of its own, with its own
 * test-temp root and its own reports, so the second never reuses anything of the first; neither reads nor writes the
 * pre-push failed record or any pass entry. The build placement runs the repository suite only: the
 * package-compatibility suite has its own CI step and is left out, as `schedule.ts --run` leaves it out.
 *
 * Each file's outcome in a pass is `passed` when its runner's report confirms it, `failed` when the report names it
 * failing, and `not proven` otherwise (a crash, a stop at the per-file limit, no readable report). A file that
 * passes in one pass and does not in the other depends on what runs beside it: the command names every such file
 * with both outcomes and exits 1. A file that does not pass in either pass is a failing file, not a dependent one: it
 * is listed as failing and does not by itself make the command fail. With `--summary` (the workflow passes
 * `$GITHUB_STEP_SUMMARY`) the findings are appended to that file as Markdown.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { DEFAULT_CONFIGURATION, type NativeGroup } from '@attalabs/test-selection'
import { CI_SHARD_COUNT } from '../../harness/processes/vinaya-strict/checks/ci-shard-membership.js'
import { TEST_TEMP_ROOT_ENV } from '../../harness/kernel/conformance/unit/test-temp.js'
import { readTestInventory } from './inventory-check.js'
import {
  buildTestSchedule,
  checkSchedule,
  ciScheduleInput,
  GROUP_TIME_LIMIT_MS,
  type Placement,
  type RunResult,
  readShardLists,
  runGroups,
  TEST_CONCURRENCY_ENV
} from './schedule.js'

/** The first pass: one file at a time, so no file runs beside another. */
export const ALONE = 1
/** The second pass: eight files at a time, twice the default a CI run uses. */
export const TOGETHER = 8

/** Every CI placement the nightly workflow checks, one job each. */
export const INDEPENDENCE_PLACEMENTS: readonly Placement[] = [
  'build',
  'shared',
  ...Array.from({ length: CI_SHARD_COUNT }, (_, i): Placement => `shard-${i + 1}`)
]

export type FileOutcome = 'passed' | 'failed' | 'not proven'

/** One file's outcome in each pass. */
export type FileFinding = { file: string; alone: FileOutcome; together: FileOutcome }

export type IndependenceReport = {
  /** Files that passed in one pass and not in the other: their result depends on what else is running. */
  dependent: FileFinding[]
  /** Files that passed in neither pass: failing whatever runs beside them, so not an independence finding. */
  failing: FileFinding[]
  /** How many files passed in both passes. */
  passedBoth: number
}

/** How a file is named in the report: its path, and its configuration when it is not the default one. */
function fileLabel(test: string, configuration: string): string {
  return configuration === DEFAULT_CONFIGURATION ? test : `${test} (${configuration})`
}

/**
 * Each scheduled file's outcome in one pass, read from what each group's runner proved: confirmed is `passed`, named
 * failing is `failed`, anything else — a group that never ended, an untrusted runner, a file its report misses — is
 * `not proven`.
 */
export function fileOutcomes(
  groups: readonly NativeGroup[],
  result: Pick<RunResult, 'outcomes'>
): Map<string, FileOutcome> {
  const byGroup = new Map((result.outcomes ?? []).map((outcome) => [outcome.group, outcome]))
  const outcomes = new Map<string, FileOutcome>()
  for (const group of groups) {
    const ended = byGroup.get(group.id)
    for (const test of group.tests) {
      const outcome: FileOutcome = ended?.confirmed.includes(test)
        ? 'passed'
        : ended?.failed.includes(test)
          ? 'failed'
          : 'not proven'
      outcomes.set(fileLabel(test, group.configuration), outcome)
    }
  }
  return outcomes
}

/**
 * Compares each file's outcome alone with its outcome together. A file one pass does not hold counts as `not proven`
 * there. Findings are sorted by file.
 */
export function compareOutcomes(
  alone: ReadonlyMap<string, FileOutcome>,
  together: ReadonlyMap<string, FileOutcome>
): IndependenceReport {
  const files = [...new Set([...alone.keys(), ...together.keys()])].sort()
  const report: IndependenceReport = { dependent: [], failing: [], passedBoth: 0 }
  for (const file of files) {
    const finding: FileFinding = {
      file,
      alone: alone.get(file) ?? 'not proven',
      together: together.get(file) ?? 'not proven'
    }
    const passedAlone = finding.alone === 'passed'
    const passedTogether = finding.together === 'passed'
    if (passedAlone && passedTogether) report.passedBoth += 1
    else if (passedAlone !== passedTogether) report.dependent.push(finding)
    else report.failing.push(finding)
  }
  return report
}

/** The command's exit status for a report: 1 when any file's result depends on what else is running, else 0. */
export function exitStatusOf(report: IndependenceReport): number {
  return report.dependent.length > 0 ? 1 : 0
}

/** The report as Markdown lines, for the job summary and the log alike. */
export function reportLines(placement: string, report: IndependenceReport): string[] {
  const row = (f: FileFinding) =>
    `- \`${f.file}\` — ${ALONE} at a time: ${f.alone}; ${TOGETHER} at a time: ${f.together}`
  const total = report.passedBoth + report.dependent.length + report.failing.length
  return [
    `### Test independence: ${placement}`,
    `${total} file(s) run ${ALONE} at a time and ${TOGETHER} at a time: ${report.passedBoth} passed both times, ` +
      `${report.dependent.length} changed result, ${report.failing.length} failed both times.`,
    ...(report.dependent.length > 0
      ? [
          '',
          `**Files whose result depends on what else is running (${report.dependent.length}):**`,
          ...report.dependent.map(row)
        ]
      : ['', 'No file changed result between the two passes.']),
    ...(report.failing.length > 0
      ? [
          '',
          `**Failing in both passes (${report.failing.length}) — failing files, not independence findings:**`,
          ...report.failing.map(row)
        ]
      : [])
  ]
}

// ── Command line ───────────────────────────────────────────────────────────

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

function git(args: readonly string[]): string {
  return spawnSync('git', [...args], { encoding: 'utf8' }).stdout.trim()
}

async function main(argv: readonly string[]): Promise<number> {
  const placement = argValue(argv, '--placement') as Placement | undefined
  if (!placement || !INDEPENDENCE_PLACEMENTS.includes(placement)) {
    process.stderr.write(
      `usage: independence-check.ts --placement <${INDEPENDENCE_PLACEMENTS.join('|')}> [--summary <file>]\n`
    )
    return 2
  }
  const summaryFile = argValue(argv, '--summary')
  const repoRoot = git(['rev-parse', '--show-toplevel'])
  const head = git(['rev-parse', 'HEAD'])

  // The full schedule, as a push to the default branch runs it.
  const view = readTestInventory(repoRoot).head
  const input = ciScheduleInput(view, { scope: 'all', reason: 'the independence check runs every test' })
  const schedule = buildTestSchedule({ view, shardLists: readShardLists(repoRoot, view), ...input })
  const expected = [
    ...input.selected,
    ...input.wholeSuites.flatMap((w) => w.identities.map((t) => ({ ...t, configuration: w.configuration })))
  ]
  const problems = checkSchedule(schedule, expected)
  for (const p of problems) process.stderr.write(`vinaya independence: ${p.code} ${p.path}: ${p.detail}\n`)
  if (problems.length > 0) return 2
  const repository = new Set(view.tests.filter((t) => t.kind === 'repository').map((t) => t.id))
  const groups =
    placement === 'build'
      ? (schedule.placements.build ?? []).filter((g) => g.tests.every((test) => repository.has(test)))
      : (schedule.placements[placement] ?? [])

  // Each pass is its own run: neither inherits a test-temp root nor a concurrency setting from the environment.
  const env: NodeJS.ProcessEnv = { ...process.env }
  delete env[TEST_TEMP_ROOT_ENV]
  delete env[TEST_CONCURRENCY_ENV]
  const pass = async (concurrency: number) => {
    process.stderr.write(`vinaya independence: ${placement} — ${groups.length} file(s), ${concurrency} at a time\n`)
    const result = await runGroups(repoRoot, groups, { env, concurrency, groupTimeLimitMs: GROUP_TIME_LIMIT_MS })
    return fileOutcomes(groups, result)
  }
  const alone = await pass(ALONE)
  const together = await pass(TOGETHER)
  if (git(['rev-parse', 'HEAD']) !== head) {
    process.stderr.write('vinaya independence: refused — the checkout moved off its commit between the two passes\n')
    return 2
  }

  const report = compareOutcomes(alone, together)
  const lines = reportLines(placement, report)
  process.stdout.write(`${lines.join('\n')}\n`)
  if (summaryFile) appendFileSync(summaryFile, `${lines.join('\n')}\n`)
  return exitStatusOf(report)
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
