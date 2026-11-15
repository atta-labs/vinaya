#!/usr/bin/env bun
/**
 * The selection safety check: the permanent measurement that a test selection kept the tests a change needs.
 *
 * For each of the last N changes merged to the default branch (the first-parent commits of the checked-out branch;
 * the change is the commit against its first parent), the check
 *
 * 1. computes the selection CI made for the change — `ciSelection` from the change's base and head with the nearest
 *    read record, the rule-based selection and not the base guard's run-everything fallback;
 * 2. breaks the change on purpose with `scripts/ci/mutate-changes.ts` in a worktree of its own, installs and builds
 *    there, and runs every test of the inventory (Bun and Vitest alike, every placement) through the scheduler at its
 *    default concurrency — everything except the package-compatibility suite, which selection never skips and which
 *    so can never show a miss;
 * 3. takes every test that failed on the mutated tree and was not in the selection, reruns it alone on the mutated
 *    tree and, when it still fails, alone on a second worktree of the change's own unmutated head — never the job's
 *    main checkout — and applies {@link judgeMisses}: a selection miss is a test that fails alone on the mutated tree
 *    and passes alone on the unmutated head. A test that does not fail again alone was flaky; one that also fails on
 *    the unmutated head was already broken. Neither is a miss.
 *
 * A change whose read record cannot be reached, or whose mutation changed no function, is reported as unmeasured,
 * never as passing. The command exits non-zero when any change has a selection miss, naming each change, each missed
 * test and the mutated line its failure message names (`mutate-changes: <path>:<line> <function>`, read from the
 * runner's own report) or, when the report names none, the mutated functions in the files the test read; and for each
 * change it prints how many tests the selection held against how many the suite holds.
 *
 *   bun scripts/ci/safety-check.ts [--count <n>] [--only <index>] [--summary <file>]
 *
 * `--count` is how many changes back from HEAD (ten by default); `--only` measures one of them, by its position
 * (0 is the newest), which is how the nightly workflow runs one job per change.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { type NativeGroup, plannedTests, type ReadRecord } from '@attalabs/test-selection'
import { readTestInventory, type InventoryView } from '../test-suites/inventory-check.ts'
import { nearestReachableRecord } from '../test-suites/read-records.ts'
import {
  buildTestSchedule,
  ciScheduleInput,
  GROUP_TIME_LIMIT_MS,
  readShardLists,
  runGroups,
  startRunner,
  testConcurrency
} from '../test-suites/schedule.ts'
import { ciSelection } from './impact-plan.ts'
import type { MutationReport } from './mutate-changes.ts'

/** The suite kind selection never skips: it has no miss to show. */
const SKIPPED_KIND = 'compatibility'

/** How many changes back from HEAD a run measures when `--count` is absent. */
export const DEFAULT_CHANGE_COUNT = 10

// ── The miss rules ─────────────────────────────────────────────────────────

export type TreeName = 'mutated' | 'head'

/** Why a failure outside the selection is, or is not, a selection miss. */
export type Verdict = 'miss' | 'not-reproduced' | 'already-failing'

export type Judgement = { test: string; verdict: Verdict }

/**
 * The miss rules. Of the tests that failed on the mutated tree, those the selection did not hold are rerun alone on
 * the mutated tree; one that does not fail again was flaky (`not-reproduced`). The ones that do are rerun alone on the
 * unmutated head; one that fails there too was already broken (`already-failing`). Only a test that fails alone on
 * the mutated tree and passes alone on the unmutated head is a `miss`. A failure inside the selection is never judged:
 * the selection kept that test. `failAlone` runs the given tests each alone on a tree and returns those that fail.
 */
export async function judgeMisses(input: {
  failed: readonly string[]
  selected: ReadonlySet<string>
  failAlone: (tree: TreeName, tests: string[]) => Promise<ReadonlySet<string>>
}): Promise<Judgement[]> {
  const outside = [...new Set(input.failed)].filter((test) => !input.selected.has(test)).sort()
  if (outside.length === 0) return []
  const reproduced = await input.failAlone('mutated', outside)
  const candidates = outside.filter((test) => reproduced.has(test))
  const brokenOnHead = candidates.length > 0 ? await input.failAlone('head', candidates) : new Set<string>()
  return outside.map((test) => ({
    test,
    verdict: !reproduced.has(test) ? 'not-reproduced' : brokenOnHead.has(test) ? 'already-failing' : 'miss'
  }))
}

/** A change that could not be measured, and why — reported, never counted as passing. */
export function unmeasuredReason(input: {
  record: ReadRecord | null
  recordNote: string
  mutated: number
}): string | null {
  if (input.record === null) return `no read record is reachable (${input.recordNote})`
  if (input.mutated === 0)
    return 'the mutation tool changed no function (nothing in the change is TypeScript code a test can run)'
  return null
}

const MUTATION_TEXT = /mutate-changes: (\S+?):(\d+) ([^\n"]*)/g

function xmlText(text: string): string {
  return text
    .replace(/&#10;/g, '\n')
    .replace(/&#13;/g, '\r')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/** The mutation texts (`<path>:<line> <function>`) a runner's report text carries, in order, each once. */
export function mutationTexts(report: string): string[] {
  const found: string[] = []
  for (const match of xmlText(report).matchAll(MUTATION_TEXT)) {
    const text = `${match[1]}:${match[2]} ${(match[3] as string).trim()}`
    if (!found.includes(text)) found.push(text)
  }
  return found
}

/**
 * What a miss names: the mutation lines its failure message carries, otherwise the mutated functions in the files
 * the test read (every mutated function when no record of the test says what it read).
 */
export function missEvidence(input: {
  messages: string | undefined
  reads: readonly string[] | undefined
  mutation: Pick<MutationReport, 'mutated'>
}): string {
  const lines = input.messages ? mutationTexts(input.messages) : []
  if (lines.length > 0) return lines.join('; ')
  const read = new Set(input.reads ?? [])
  const files = input.mutation.mutated.filter((m) => input.reads === undefined || read.has(m.file))
  const named = files.flatMap((m) => m.functions.map((f) => `${m.file}:${f.line} ${f.name}`))
  return named.length > 0
    ? `no mutation line in its report; mutated functions in files it read: ${named.join('; ')}`
    : 'no mutation line in its report, and it read no mutated file'
}

// ── Reports ────────────────────────────────────────────────────────────────

/**
 * The part of a Bun JUnit report that belongs to one test file: each top-level `<testsuite>` whose opening tag names
 * the file. A report with no such suite gives the whole text only when `alone` (the group holds just that file),
 * otherwise nothing, so another test's failure text is never attributed to this one.
 */
export function junitSuiteOf(xml: string, test: string, alone: boolean): string {
  const suites = xml.split(/(?=<testsuite\b)/).filter((chunk) => chunk.startsWith('<testsuite'))
  const own = suites.filter((chunk) => {
    const tag = chunk.slice(0, chunk.indexOf('>') + 1)
    return tag.includes(`"${test}"`) || tag.includes(`/${test}"`) || tag.includes(`${test}"`)
  })
  if (own.length > 0) return own.join('\n')
  return alone ? xml : ''
}

/** The failure text each file's Vitest JSON report carries, by file path relative to `root`. */
export function vitestFailureTexts(json: string, root: string): Map<string, string> {
  const out = new Map<string, string>()
  try {
    const report = JSON.parse(json) as {
      testResults?: { name?: string; message?: string; assertionResults?: { failureMessages?: string[] }[] }[]
    }
    for (const file of report.testResults ?? []) {
      if (typeof file.name !== 'string') continue
      const text = [file.message ?? '', ...(file.assertionResults ?? []).flatMap((a) => a.failureMessages ?? [])].join(
        '\n'
      )
      if (text.trim()) out.set(relative(root, file.name), text)
    }
  } catch {}
  return out
}

// ── The change ─────────────────────────────────────────────────────────────

export type ChangeResult = {
  head: string
  subject: string
  selected: number
  total: number
  /** `null` when measured. */
  unmeasured: string | null
  misses: { test: string; evidence: string }[]
  /** Failures outside the selection that were not misses, with why. */
  notMisses: Judgement[]
  /** Set when the check itself failed (checkout, install, build, runner): nothing was measured, and the run fails. */
  crashed?: boolean
}

function cleanEnv(): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(out)) if (key.startsWith('GIT_')) delete out[key]
  return out
}

function run(cwd: string, command: string, args: string[]): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: cleanEnv(), maxBuffer: 1 << 30 })
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').slice(-600)}`
    )
  return result.stdout
}

const say = (line: string) => process.stderr.write(`safety-check: ${line}\n`)

/** The tree's schedule groups for `tests` (every test of the view that is not skipped when absent). */
function groupsFor(root: string, view: InventoryView, tests?: readonly string[]): NativeGroup[] {
  const pool = view.tests.filter((t) => t.kind !== SKIPPED_KIND && (tests === undefined || tests.includes(t.id)))
  const input = ciScheduleInput(
    { ...view, tests: pool } as InventoryView,
    tests === undefined
      ? { scope: 'all', reason: 'the safety check runs every test' }
      : { scope: 'selected', selected: [...tests], changed: [], native: [], wholeSuites: [] }
  )
  const schedule = buildTestSchedule({ view, shardLists: readShardLists(root, view), ...input })
  if (schedule.problems.length > 0)
    throw new Error(`the schedule is not sound: ${schedule.problems.map((p) => `${p.code} ${p.path}`).join('; ')}`)
  return Object.values(schedule.placements).flatMap((groups) => groups ?? [])
}

type Failures = { failed: string[]; messages: Map<string, string> }

/** Runs `groups` in `root`, keeping each failing test and the report text that names why. */
async function runAndCollect(root: string, groups: NativeGroup[], concurrency: number): Promise<Failures> {
  const messages = new Map<string, string>()
  const result = await runGroups(root, groups, {
    env: cleanEnv(),
    log: () => {},
    groupTimeLimitMs: GROUP_TIME_LIMIT_MS,
    concurrency,
    onReport: (group, xml) => {
      for (const test of group.tests) {
        const own = junitSuiteOf(xml, test, group.tests.length === 1)
        if (own) messages.set(test, `${messages.get(test) ?? ''}\n${own}`)
      }
    },
    // A Vitest report is JSON in a file the command names; it is read when the runner has exited, before the
    // scheduler removes it.
    spawn: async (command, options) => {
      const exit = await startRunner(command, options)
      const out = command.find((arg) => arg.startsWith('--outputFile.json='))
      if (out) {
        try {
          for (const [file, text] of vitestFailureTexts(
            readFileSync(out.slice('--outputFile.json='.length), 'utf8'),
            root
          ))
            messages.set(file, `${messages.get(file) ?? ''}\n${text}`)
        } catch {}
      }
      return exit
    }
  })
  const byId = new Map(groups.map((g) => [g.id, g]))
  const failed = result.failedRunners.flatMap((id) => {
    const named = result.failedTests[id]
    return named === 'all' || named === undefined ? (byId.get(id)?.tests ?? []) : named
  })
  return { failed: [...new Set(failed)].sort(), messages }
}

/** Adds a detached worktree of `commit` at `dir`. */
function checkout(repoRoot: string, dir: string, commit: string): void {
  run(repoRoot, 'git', ['worktree', 'add', '--detach', dir, commit])
}

/** Installs the worktree's dependencies and builds the CLI, as the CI build job does for the `build`-placement tests. */
function installAndBuild(dir: string): void {
  run(dir, 'bun', ['install', '--frozen-lockfile'])
  run(dir, 'bun', ['run', '--cwd', 'apps/cli', 'build'])
}

/** Measures one change. Never throws: a change that cannot be measured is returned as unmeasured with why. */
export async function measureChange(repoRoot: string, head: string): Promise<ChangeResult> {
  const subject = run(repoRoot, 'git', ['log', '-1', '--format=%s', head]).trim()
  const result: ChangeResult = { head, subject, selected: 0, total: 0, unmeasured: null, misses: [], notMisses: [] }
  const scratch = mkdtempSync(join(tmpdir(), 'selection-safety-'))
  const trees: string[] = []
  try {
    const base = run(repoRoot, 'git', ['rev-parse', '--verify', `${head}^1`]).trim()
    const selection = ciSelection(repoRoot, base, head, (root, commit) => nearestReachableRecord(root, commit))
    const selected = new Set(plannedTests(selection.plan))
    const total = selection.view.tests.filter((t) => t.kind !== SKIPPED_KIND)
    result.selected = total.filter((t) => selected.has(t.id)).length
    result.total = total.length
    const record = selection.records?.record ?? null

    // The mutation runs on the fresh checkout, before the install: the tool refuses a worktree that differs from the
    // head, and installing and building change no tracked file, but this keeps the order its contract states.
    const mutatedDir = join(scratch, 'mutated')
    say(`${head.slice(0, 12)}: mutating`)
    checkout(repoRoot, mutatedDir, head)
    trees.push(mutatedDir)
    const mutation = JSON.parse(
      run(repoRoot, 'bun', ['scripts/ci/mutate-changes.ts', '--base', base, '--head', head, '--worktree', mutatedDir])
    ) as MutationReport
    result.unmeasured = unmeasuredReason({
      record,
      recordNote: selection.recordNote,
      mutated: mutation.mutated.reduce((n, m) => n + m.functions.length, 0)
    })
    if (result.unmeasured !== null) return result

    installAndBuild(mutatedDir)
    const view = readTestInventory(mutatedDir).head
    say(`${head.slice(0, 12)}: running ${result.total} test(s) on the mutated tree (${result.selected} selected)`)
    const full = await runAndCollect(mutatedDir, groupsFor(mutatedDir, view), testConcurrency())
    say(`${head.slice(0, 12)}: ${full.failed.length} test(s) failed on the mutated tree`)

    let headDir: string | null = null
    const failAlone = async (tree: TreeName, tests: string[]): Promise<ReadonlySet<string>> => {
      let root = mutatedDir
      if (tree === 'head') {
        if (headDir === null) {
          headDir = join(scratch, 'head')
          checkout(repoRoot, headDir, head)
          trees.push(headDir)
          installAndBuild(headDir)
        }
        root = headDir
      }
      const failing = new Set<string>()
      // One test per runner start, one runner at a time: each is alone.
      for (const test of tests) {
        const alone = await runAndCollect(root, groupsFor(root, view, [test]), 1)
        if (alone.failed.includes(test)) failing.add(test)
      }
      return failing
    }
    const judged = await judgeMisses({ failed: full.failed, selected, failAlone })
    for (const { test, verdict } of judged) {
      if (verdict !== 'miss') {
        result.notMisses.push({ test, verdict })
        continue
      }
      result.misses.push({
        test,
        evidence: missEvidence({
          messages: full.messages.get(test),
          reads: record?.tests[test]?.reads,
          mutation
        })
      })
    }
    return result
  } catch (error) {
    result.crashed = true
    result.unmeasured = `the check itself failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`
    return result
  } finally {
    for (const tree of trees) spawnSync('git', ['worktree', 'remove', '--force', tree], { cwd: repoRoot })
    spawnSync('git', ['worktree', 'prune'], { cwd: repoRoot })
    rmSync(scratch, { recursive: true, force: true })
  }
}

// ── The report ─────────────────────────────────────────────────────────────

/** The report lines of one measured or unmeasured change. */
export function reportLines(result: ChangeResult): string[] {
  const name = `${result.head.slice(0, 12)} ${result.subject}`
  const counts = `selected ${result.selected} of ${result.total} tests`
  if (result.unmeasured !== null) return [`UNMEASURED ${name} — ${counts}; ${result.unmeasured}`]
  if (result.misses.length === 0)
    return [
      `ok ${name} — ${counts}; no selection miss` +
        (result.notMisses.length > 0 ? ` (${result.notMisses.length} failure(s) outside it were not misses)` : '')
    ]
  return [
    `MISS ${name} — ${counts}; ${result.misses.length} test(s) the selection left out fail on the mutated change`,
    ...result.misses.map((m) => `  ${m.test}: ${m.evidence}`)
  ]
}

function parseArgs(argv: readonly string[]): { count: number; only: number | null; summary: string | null } | null {
  const value = (flag: string) => {
    const at = argv.indexOf(flag)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const count = value('--count') === undefined ? DEFAULT_CHANGE_COUNT : Number(value('--count'))
  const only = value('--only') === undefined ? null : Number(value('--only'))
  if (!Number.isInteger(count) || count < 1) return null
  if (only !== null && (!Number.isInteger(only) || only < 0 || only >= count)) return null
  return { count, only, summary: value('--summary') ?? null }
}

async function main(argv: readonly string[]): Promise<number> {
  const options = parseArgs(argv)
  if (options === null) {
    process.stderr.write('usage: safety-check.ts [--count <n>] [--only <index>] [--summary <file>]\n')
    return 2
  }
  const repoRoot = run(process.cwd(), 'git', ['rev-parse', '--show-toplevel']).trim()
  const commits = run(repoRoot, 'git', ['rev-list', '--first-parent', `--max-count=${options.count}`, 'HEAD'])
    .split('\n')
    .filter(Boolean)
  const chosen = options.only === null ? commits : commits.slice(options.only, options.only + 1)
  let missed = false
  for (const head of chosen) {
    const result = await measureChange(repoRoot, head)
    const lines = reportLines(result)
    for (const line of lines) process.stdout.write(`${line}\n`)
    if (options.summary) appendFileSync(options.summary, `${lines.map((l) => `- ${l}`).join('\n')}\n`)
    if (result.misses.length > 0 || result.crashed === true) missed = true
  }
  return missed ? 1 : 0
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
