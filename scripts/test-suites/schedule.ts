#!/usr/bin/env bun
/**
 * This repository's CI test schedule: where each selected test runs, and the
 * run of one place's groups with a check of what each runner executed.
 *
 * {@link buildTestSchedule} takes the validated inventory view
 * (`readTestInventory` in `inventory-check.ts`) and an explicit set of
 * selected test identities, groups them with the selection library's
 * `groupNativeTests` — one group per suite and configuration, with that
 * suite's own runner, working directory, preload and environment — and
 * places each group in one of the workflow's existing jobs
 * (`.github/workflows/ci.yml`):
 *
 * - `build` — a repository-owned test. The build job's unconditional
 *   inventory step runs every one of them, so no later job runs them again;
 *   they stay in the schedule's accounting all the same.
 * - `shard-<n>` — a Bun test of an owner the shard jobs run
 *   ({@link SHARD_OWNERS}). A CLI
 *   test keeps the shard its list (`apps/cli/tests/ci-shards/shard-<n>.txt`)
 *   names; every other one, sorted by identity, goes to the least-populated
 *   shard, ties to the lowest number. The count is files, never a duration.
 * - `shared` — a Vitest suite, or a Bun suite of any other owner: the
 *   shared-packages job.
 *
 * Location is decided by owner and runner, never by folder, so a suite moved
 * to another folder keeps its place. Nothing here selects: the CI adapter's
 * selection (`apps/cli/src/lib/ci-test-selection.ts --decision`) decides
 * which tests a pull request needs, and a push to the default branch passes
 * `--full`. A suite this schedule cannot narrow — `@attalabs/aeg-core`, whose
 * tests read the whole repository — runs whole, with its reason stated.
 *
 *   bun scripts/test-suites/schedule.ts --dry-run --full
 *     prints every scheduled test once, with its place, runner and working directory.
 *   bun scripts/test-suites/schedule.ts --run --placement <shard-N|shared> (--full [--reason <text>] | --decision <file>)
 *     runs that place's groups one after another, each under its own runner,
 *     and fails when a runner fails, is interrupted, leaves no readable report,
 *     or reports a file it was not given or misses one it was.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CI_SHARD_COUNT, CI_SHARD_LIST_OWNER, shardFileRelPath } from '../../apps/cli/src/lib/ci-shard-membership.ts'
import type { CiDecision } from '../../apps/cli/src/lib/ci-test-selection.ts'
import {
  DEFAULT_CONFIGURATION,
  type ExecutionFacts,
  groupNativeTests,
  type NativeGroup,
  type NativeProblem,
  type NativeTestRequest,
  validateExecutedIdentities,
  type WholeSuiteRequest
} from '../../apps/cli/src/lib/verification/index.ts'
import { type InventoryView, readTestInventory, type TestIdentity } from './inventory-check.ts'

export type Placement = 'build' | 'shared' | `shard-${number}`

/**
 * The owners whose Bun tests the shard jobs run, by package name — so a
 * suite moved to another folder keeps its place: the CLI, whose files the
 * shard lists name (`CI_SHARD_LIST_OWNER`), the kernel and the process.
 */
export const SHARD_OWNERS: readonly string[] = [CI_SHARD_LIST_OWNER, '@attalabs/harness', '@attalabs/process-vinaya']

/** Suites that run whole on every pull request, by owner, and why. */
export const WHOLE_SUITE_OWNERS: Readonly<Record<string, string>> = {
  '@attalabs/aeg-core':
    'its tests read files across the whole repository, which the selection does not model, so it runs whole'
}

/**
 * Suites that run whole on a pull request that changes any path under their
 * folder, by owner, and why: the selection narrows every portal path without
 * modeling the portal's non-TypeScript inputs (its JSON fixtures, styles,
 * manifest and configuration), so a portal change runs the portal's whole
 * suite, as `turbo --affected` did before this schedule.
 */
export const WHOLE_ON_CHANGE_OWNERS: Readonly<Record<string, string>> = {
  '@vinaya/portal':
    'the pull request changes a path under its folder, and the selection does not model the portal inputs, so it runs whole'
}

export type ScheduleEntry = { test: string; configuration: string; placement: Placement }

export type TestSchedule = {
  schema: 'vinaya.test-schedule'
  schemaVersion: 1
  /** Why this schedule runs everything, or `null` for a selected run. */
  reason: string | null
  shardCount: number
  /** Each place's groups, in the order they run. */
  placements: Partial<Record<Placement, NativeGroup[]>>
  /** Every scheduled test under every configuration, once each, with its place. */
  accounting: ScheduleEntry[]
  /** The shard every shard-run test of the inventory belongs to — selected or not, so a selection never moves one. */
  assignments: Record<string, number>
  problems: NativeProblem[]
}

export type BuildTestScheduleInput = {
  view: InventoryView
  /** The selected tests: explicit identities, each with an optional configuration name. */
  selected: readonly NativeTestRequest[]
  /** Suites to run whole, each with its reason; their identities are expected executions. */
  wholeSuites?: readonly WholeSuiteRequest[]
  /** The shard lists, 1..n, each a list of paths relative to the listed owner's working directory. */
  shardLists: readonly (readonly string[])[]
  reason?: string | null
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function isShardRun(identity: Pick<TestIdentity, 'owner' | 'runner' | 'kind'>): boolean {
  return identity.kind === 'workspace' && identity.runner === 'bun' && SHARD_OWNERS.includes(identity.owner)
}

/**
 * The shard of every shard-run test in the view: a listed CLI test keeps its
 * listed shard; every other one, sorted by identity, joins the shard with the
 * fewest files so far, the lowest number on a tie. A listed path that is not
 * a test of the listed owner, or one listed twice, is a problem.
 */
export function assignShards(
  view: InventoryView,
  shardLists: readonly (readonly string[])[]
): { assignments: Record<string, number>; problems: NativeProblem[] } {
  const problems: NativeProblem[] = []
  const listedSuite = view.suites.find((s) => s.owner === CI_SHARD_LIST_OWNER)
  const shardRun = view.tests.filter(isShardRun)
  const known = new Set(shardRun.map((t) => t.id))
  const assignments: Record<string, number> = {}
  const counts = shardLists.map(() => 0)
  shardLists.forEach((list, index) => {
    for (const entry of list) {
      const id = listedSuite && listedSuite.cwd !== '.' ? `${listedSuite.cwd}/${entry}` : entry
      if (!known.has(id) || view.tests.find((t) => t.id === id)?.owner !== CI_SHARD_LIST_OWNER) {
        problems.push({
          code: 'extra',
          path: id,
          detail: `listed in shard ${index + 1} but not a test of ${CI_SHARD_LIST_OWNER}`
        })
        continue
      }
      if (assignments[id] !== undefined) {
        problems.push({ code: 'duplicate', path: id, detail: `listed in shards ${assignments[id]} and ${index + 1}` })
        continue
      }
      assignments[id] = index + 1
      counts[index] = (counts[index] as number) + 1
    }
  })
  for (const identity of [...shardRun].sort((a, b) => compare(a.id, b.id))) {
    if (assignments[identity.id] !== undefined) continue
    let best = 0
    for (let i = 1; i < counts.length; i++) if ((counts[i] as number) < (counts[best] as number)) best = i
    assignments[identity.id] = best + 1
    counts[best] = (counts[best] as number) + 1
  }
  return { assignments, problems }
}

/**
 * The CI schedule for an explicit set of selected tests: grouped by the
 * selection library, each group placed once — a repository-owned group in
 * `build`, a shard-run group split across the shards by
 * {@link assignShards}, everything else in `shared`. Grouping never drops a
 * test; placement only says where it runs.
 */
export function buildTestSchedule(input: BuildTestScheduleInput): TestSchedule {
  const { view } = input
  const { assignments, problems } = assignShards(view, input.shardLists)
  const known = new Set(view.tests.map((t) => t.id))
  // A test the view does not hold has no owner-decided place: reported, never defaulted to a shard.
  const held = (identity: TestIdentity): boolean => {
    if (known.has(identity.id)) return true
    problems.push({ code: 'extra', path: identity.id, detail: 'selected but not a test the inventory holds' })
    return false
  }
  const placeOf = (identity: TestIdentity): Placement => {
    if (identity.kind === 'repository') return 'build'
    if (isShardRun(identity)) return `shard-${assignments[identity.id] as number}`
    return 'shared'
  }
  const requests = new Map<Placement, NativeTestRequest[]>()
  const wholes = new Map<Placement, WholeSuiteRequest[]>()
  const push = <T>(map: Map<Placement, T[]>, place: Placement, value: T) =>
    map.set(place, [...(map.get(place) ?? []), value])
  for (const request of input.selected) if (held(request)) push(requests, placeOf(request), request)
  for (const whole of input.wholeSuites ?? []) {
    const shardRun = whole.identities.filter((identity) => isShardRun(identity) && held(identity))
    // Bun takes exact file arguments, so a shard-run suite is never run whole: it is split like any selection.
    for (const identity of shardRun)
      push(requests, placeOf(identity), { ...identity, configuration: whole.configuration ?? DEFAULT_CONFIGURATION })
    const rest = whole.identities.filter((identity) => !isShardRun(identity) && held(identity))
    if (rest.length > 0) push(wholes, placeOf(rest[0] as TestIdentity), { ...whole, identities: rest })
  }

  const order = (place: Placement) =>
    place === 'build' ? 0 : place === 'shared' ? CI_SHARD_COUNT + 1 : Number(place.slice('shard-'.length))
  const places = [...new Set<Placement>([...requests.keys(), ...wholes.keys()])].sort((a, b) => order(a) - order(b))
  const placements: Partial<Record<Placement, NativeGroup[]>> = {}
  const accounting: ScheduleEntry[] = []
  for (const place of places) {
    const grouping = groupNativeTests({
      tests: requests.get(place) ?? [],
      wholeSuites: wholes.get(place) ?? [],
      universe: view.tests
    })
    problems.push(...grouping.problems)
    if (grouping.groups.length === 0) continue
    placements[place] = grouping.groups
    for (const group of grouping.groups)
      for (const test of group.tests) accounting.push({ test, configuration: group.configuration, placement: place })
  }
  accounting.sort((a, b) => compare(a.test, b.test) || compare(a.configuration, b.configuration))
  return {
    schema: 'vinaya.test-schedule',
    schemaVersion: 1,
    reason: input.reason ?? null,
    shardCount: input.shardLists.length,
    placements,
    accounting,
    assignments,
    problems
  }
}

/**
 * The schedule check: every expected test under every expected configuration
 * is placed exactly once, and nothing else is.
 */
export function checkSchedule(schedule: TestSchedule, expected: readonly NativeTestRequest[]): NativeProblem[] {
  const problems: NativeProblem[] = [...schedule.problems]
  const key = (test: string, configuration: string) => `${test}@${configuration}`
  const placed = new Map<string, number>()
  for (const entry of schedule.accounting)
    placed.set(key(entry.test, entry.configuration), (placed.get(key(entry.test, entry.configuration)) ?? 0) + 1)
  const wanted = new Set<string>()
  for (const r of expected) {
    const k = key(r.id, r.configuration ?? DEFAULT_CONFIGURATION)
    if (wanted.has(k)) problems.push({ code: 'duplicate', path: k, detail: 'expected twice' })
    wanted.add(k)
  }
  for (const [k, count] of placed) {
    if (!wanted.has(k)) problems.push({ code: 'extra', path: k, detail: 'scheduled but not expected' })
    else if (count > 1) problems.push({ code: 'duplicate', path: k, detail: `scheduled ${count} times` })
  }
  for (const k of [...wanted].sort())
    if (!placed.has(k)) problems.push({ code: 'missing', path: k, detail: 'expected but not scheduled' })
  return problems
}

// ── This repository's inputs ───────────────────────────────────────────────

/** The shard lists as committed, read from the listed owner's working directory. */
export function readShardLists(repoRoot: string, view: InventoryView): string[][] {
  const suite = view.suites.find((s) => s.owner === CI_SHARD_LIST_OWNER)
  if (!suite) return Array.from({ length: CI_SHARD_COUNT }, () => [])
  return Array.from({ length: CI_SHARD_COUNT }, (_, i) =>
    readFileSync(join(repoRoot, suite.cwd, shardFileRelPath(i + 1)), 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  )
}

/**
 * What a CI run schedules: every test under a run-everything decision, the
 * selected ones otherwise — with every repository-owned test, which the build
 * job runs on every run, and every whole-run suite. A selected path the
 * inventory does not know runs everything, with that reason.
 */
export function ciScheduleInput(
  view: InventoryView,
  decision: CiDecision
): { selected: NativeTestRequest[]; wholeSuites: WholeSuiteRequest[]; reason: string | null } {
  const wholeSuites = (reason: (owner: string) => string | undefined): WholeSuiteRequest[] =>
    view.suites.flatMap((suite) => {
      const why = reason(suite.owner)
      if (why === undefined || suite.runner !== 'vitest') return []
      return [{ suite: suite.id, reason: why, identities: view.tests.filter((t) => t.suite === suite.id) }]
    })
  const everything = (reason: string) => {
    const whole = wholeSuites((owner) => WHOLE_SUITE_OWNERS[owner] ?? `every test runs: ${reason}`)
    const wholeIds = new Set(whole.flatMap((w) => w.identities.map((t) => t.id)))
    return { selected: view.tests.filter((t) => !wholeIds.has(t.id)), wholeSuites: whole, reason }
  }
  if (decision.scope === 'all') return everything(decision.reason)
  const byId = new Map(view.tests.map((t) => [t.id, t]))
  const ids = [...new Set([...decision.selected, ...(decision.native ?? [])])].sort()
  const unknown = ids.find((id) => !byId.has(id))
  if (unknown) return everything(`the selection names ${unknown}, which the test inventory does not hold`)
  const changed = decision.changed ?? []
  const whole = [
    ...wholeSuites((owner) => WHOLE_SUITE_OWNERS[owner]),
    ...view.suites.flatMap((suite) => {
      const why = WHOLE_ON_CHANGE_OWNERS[suite.owner]
      const prefix = suite.dir === '.' ? '' : `${suite.dir}/`
      if (why === undefined || !changed.some((path) => path.startsWith(prefix))) return []
      return [{ suite: suite.id, reason: why, identities: view.tests.filter((t) => t.suite === suite.id) }]
    })
  ]
  const wholeIds = new Set(whole.flatMap((w) => w.identities.map((t) => t.id)))
  const roots = view.tests.filter((t) => t.kind === 'repository')
  const selected = [...new Set([...ids.map((id) => byId.get(id) as TestIdentity), ...roots])].filter(
    (t) => !wholeIds.has(t.id)
  )
  return { selected, wholeSuites: whole, reason: null }
}

// ── Running one place ──────────────────────────────────────────────────────

/** Decodes the five XML entities Bun's JUnit writer escapes. */
function xmlText(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * The files a Bun JUnit report says executed: the `file` of each top-level
 * `<testsuite>` — one per test file — as written, repeats kept. `null` when
 * the text is not a Bun JUnit report.
 */
export function bunJunitFiles(xml: string): string[] | null {
  if (!/<testsuites\b/.test(xml)) return null
  const files: string[] = []
  let depth = 0
  for (const tag of xml.matchAll(/<(\/?)(testsuites|testsuite)\b([^>]*?)(\/?)>/g)) {
    const [, closing, name, attrs, selfClosing] = tag as unknown as [string, string, string, string, string]
    if (name === 'testsuites') continue
    if (closing) {
      depth--
      continue
    }
    if (depth === 0) {
      const file = /\bfile="([^"]*)"/.exec(attrs)?.[1]
      if (file !== undefined) files.push(xmlText(file))
    }
    if (!selfClosing) depth++
  }
  return depth === 0 ? files : null
}

/** The files a Vitest JSON report says executed, as written; `null` when the text is not one. */
export function vitestJsonFiles(text: string): string[] | null {
  try {
    const report = JSON.parse(text) as { testResults?: { name?: unknown }[] }
    if (!Array.isArray(report.testResults)) return null
    const names = report.testResults.map((r) => r.name)
    return names.every((n): n is string => typeof n === 'string') ? names : null
  } catch {
    return null
  }
}

/** The command that starts one group's runner, with its own report written to `report`. */
export function runnerCommand(group: NativeGroup, report: string): string[] {
  if (group.runner === 'bun') {
    const timeout = group.environment.timeoutMs
    return [
      'bun',
      'test',
      ...(typeof timeout === 'number' ? [`--timeout=${timeout}`] : []),
      '--reporter=junit',
      `--reporter-outfile=${report}`,
      ...group.args
    ]
  }
  return [
    // The installed, lockfile-pinned Vitest only: a folder that cannot resolve one fails, never downloads one.
    'bunx',
    '--no-install',
    'vitest',
    'run',
    '--reporter=default',
    '--reporter=json',
    `--outputFile.json=${report}`,
    ...group.exclude.flatMap((path) => ['--exclude', path]),
    ...group.args
  ]
}

export type RunResult = { failedRunners: string[]; problems: NativeProblem[]; executions: ExecutionFacts[] }

/**
 * Runs `groups` one after another, each in its own working directory under
 * its own runner, and checks every runner executed exactly its files. The
 * environment is this process's; nothing runs in parallel.
 */
export function runGroups(
  repoRoot: string,
  groups: readonly NativeGroup[],
  options: { log?: (line: string) => void; spawn?: typeof spawnSync } = {}
): RunResult {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const spawn = options.spawn ?? spawnSync
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-schedule-'))
  const executions: ExecutionFacts[] = []
  const failedRunners: string[] = []
  try {
    groups.forEach((group, index) => {
      const report = join(dir, `${index}.${group.runner === 'bun' ? 'xml' : 'json'}`)
      const command = runnerCommand(group, report)
      log(
        `vinaya schedule: ${group.id} — ${group.owner}, ${group.runner} in ${group.cwd}, ${group.tests.length} file(s)`
      )
      const run = spawn(command[0] as string, command.slice(1), { cwd: join(repoRoot, group.cwd), stdio: 'inherit' })
      if (run.signal) {
        executions.push({ group: group.id, outcome: 'signaled', detail: run.signal, files: [] })
        failedRunners.push(group.id)
        return
      }
      if (run.status !== 0) failedRunners.push(group.id)
      let text: string | null = null
      try {
        text = readFileSync(report, 'utf8')
      } catch {
        text = null
      }
      const files = text === null ? null : group.runner === 'bun' ? bunJunitFiles(text) : vitestJsonFiles(text)
      executions.push(
        files === null
          ? { group: group.id, outcome: 'unreadable', detail: `no readable ${group.runner} report`, files: [] }
          : { group: group.id, outcome: 'completed', files }
      )
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  const roots = [...new Set([repoRoot, realpathSync(repoRoot)])]
  const { problems } = validateExecutedIdentities(groups, executions, { roots })
  return { failedRunners, problems, executions }
}

// ── Command line ───────────────────────────────────────────────────────────

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

function repositoryRoot(): string {
  return spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim()
}

function main(argv: readonly string[]): number {
  // The step summary file the workflow names (`--summary "$GITHUB_STEP_SUMMARY"`); none outside CI.
  const summaryFile = argValue(argv, '--summary')
  const summary = (lines: readonly string[]): void => {
    if (summaryFile) writeFileSync(summaryFile, `${lines.join('\n')}\n`, { flag: 'a' })
  }
  const repoRoot = repositoryRoot()
  const full = argv.includes('--full')
  const decisionPath = argValue(argv, '--decision')
  if (!full && !decisionPath) {
    process.stderr.write(
      'usage: schedule.ts (--dry-run | --json | --run --placement <shard-N|shared> [--summary <file>]) (--full [--reason <text>] | --decision <file>)\n'
    )
    return 2
  }
  const view = readTestInventory(repoRoot).head
  const decision: CiDecision = full
    ? { scope: 'all', reason: argValue(argv, '--reason') ?? 'every test was asked for' }
    : (JSON.parse(readFileSync(decisionPath as string, 'utf8')) as CiDecision)
  const input = ciScheduleInput(view, decision)
  const schedule = buildTestSchedule({ view, shardLists: readShardLists(repoRoot, view), ...input })
  const expected = [
    ...input.selected,
    ...input.wholeSuites.flatMap((w) => w.identities.map((t) => ({ ...t, configuration: w.configuration })))
  ]
  const problems = checkSchedule(schedule, expected)
  for (const p of problems) process.stderr.write(`vinaya schedule: ${p.code} ${p.path}: ${p.detail}\n`)
  if (problems.length > 0) return 1

  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(schedule, null, 2)}\n`)
    return 0
  }
  if (argv.includes('--dry-run')) {
    for (const [place, groups] of Object.entries(schedule.placements))
      for (const group of groups ?? [])
        for (const test of group.tests)
          process.stdout.write(`${place}\t${group.runner}\t${group.cwd}\t${group.configuration}\t${test}\n`)
    const counts = Object.entries(schedule.placements).map(
      ([place, groups]) => `${place} ${(groups ?? []).reduce((n, g) => n + g.tests.length, 0)}`
    )
    process.stderr.write(
      `vinaya schedule: ${schedule.accounting.length} test(s) scheduled once each — ${counts.join(', ')}` +
        `${schedule.reason ? `; everything: ${schedule.reason}` : ''}\n`
    )
    return 0
  }

  const placement = argValue(argv, '--placement') as Placement | undefined
  if (!argv.includes('--run') || !placement || placement === 'build') {
    process.stderr.write('schedule.ts --run needs --placement shard-<n> or shared; the build job runs its own step\n')
    return 2
  }
  const groups = schedule.placements[placement] ?? []
  const why = schedule.reason ? `everything: ${schedule.reason}` : 'the tests the selection picked'
  process.stderr.write(`vinaya schedule: ${placement} runs ${why}\n`)
  if (groups.length === 0) {
    const line = `No test in ${placement} is selected for this pull request; no test ran.`
    process.stdout.write(`${line}\n`)
    summary([line])
    return 0
  }
  summary([
    `### ${placement}: ${why}`,
    ...groups.map(
      (g) =>
        `- ${g.owner} (${g.runner}, in \`${g.cwd}\`): ${g.tests.length} file(s)${g.scope === 'suite' ? ` — whole suite: ${g.reason}` : ''}`
    )
  ])
  const result = runGroups(repoRoot, groups)
  for (const p of result.problems)
    process.stderr.write(`vinaya schedule: ${p.code} ${p.path}${p.group ? ` (${p.group})` : ''}: ${p.detail}\n`)
  if (result.failedRunners.length > 0)
    process.stderr.write(`vinaya schedule: the runner failed for ${result.failedRunners.join(', ')}\n`)
  if (result.problems.length > 0)
    summary([`The runners did not execute exactly the scheduled files: ${result.problems.length} problem(s).`])
  return result.failedRunners.length > 0 || result.problems.length > 0 ? 1 : 0
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
