#!/usr/bin/env bun
/**
 * This repository's local push adapter: the tests a push runs come from the
 * shared selection library, through the same adapter CI uses
 * (`repository-selection.ts`, its `local` consumer), and run once each under
 * their own native runner, one runner start after another.
 *
 * The adapter chooses only what is the push's own:
 *
 * - the base the selector compares the head with — the merge base with the
 *   push's remote base, or a verified incremental base: the head of the last
 *   passing run, or of the last refused one, on this branch, under this very
 *   verification context (`chooseNativeBase`);
 * - the unresolved failed tests of the last refused push, added on top of the
 *   selection as obligations, never handed to the selector;
 * - the suites a runner cannot narrow to files, run whole and said so before
 *   anything starts (the schedule's own whole-suite reasons).
 *
 * Grouping, each runner's command and the check of what each runner executed
 * are the scheduler's (`schedule.ts`'s `runGroups`, over the library's
 * `groupNativeTests` and `validateExecutedIdentities`), independent of where
 * CI places a group. The library is imported only through its public
 * entrypoint.
 *
 * Three subcommands, the first two the generated pre-push hook's:
 *
 *   bun scripts/test-suites/local-run.ts select
 *     freezes the push's plan into the selection note under the worktree's git
 *     directory and prints one absolute test path per line (none: nothing
 *     selected). Exits 1, with the reason, when no plan can be made.
 *   bun scripts/test-suites/local-run.ts run --log <capture>
 *     runs exactly the frozen plan for the current head, records the head-bound
 *     result, the passing or failed record and, on a complete green run, the
 *     receipt of its aggregate native command; exits 0 only on that run.
 *   bun scripts/test-suites/local-run.ts exact --context <digest> -- <test@configuration>...
 *     the aggregate native command itself: runs exactly those identities and
 *     refuses under any other verification context. It records nothing.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  changedBetween,
  chooseNativeBase,
  clearRecordOfKind,
  computeVerificationContext,
  currentBranch,
  currentHead,
  FAILED_TESTS_RECORD,
  type FailedTestsRecord,
  isAncestor,
  LAST_PUSH_RESULT,
  type LastPushResult,
  type NativeCompletion,
  type NativeSelection,
  nativePassingRecord,
  parseSelectionNote,
  readFailedTestsRecord,
  readJsonUnderGit,
  readPassingRecord,
  SELECTION_NOTE,
  type SelectionNote,
  verificationInputsDirty,
  writeJsonUnderGit
} from '../../apps/cli/src/lib/pre-push-failed-tests.js'
import { defaultTestRunCache, recordGreenTestRun } from '../../apps/cli/src/lib/pr-report-engine.js'
import { nativeRunCommand, parseNativeRunCommand } from '../../apps/cli/src/lib/pre-push-test-runner.js'
import { resolveRemoteBase } from '../../apps/cli/src/lib/remote-base.js'
import {
  DEFAULT_CONFIGURATION,
  groupNativeTests,
  type InventoryView,
  type NativeGroup,
  type NativeProblem,
  type NativeTestRequest,
  plannedTests,
  SELECTION_ENGINE,
  type SelectionPlan,
  selectTests,
  stableHash,
  type TestIdentity,
  validateExecutedIdentities,
  type WholeSuiteRequest
} from '../../apps/cli/src/lib/verification/index.js'
import { readTestInventory } from './inventory-check.js'
import { repositorySelectionInput } from './repository-selection.js'
import { type RunResult, runGroups, WHOLE_ON_CHANGE_OWNERS, WHOLE_SUITE_OWNERS } from './schedule.js'

/** The version of how this adapter executes a plan; part of every verification context it names. */
export const LOCAL_RUN_EXECUTION = 'native-local-run@1'

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function cleanGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) if (key.startsWith('GIT_')) delete out[key]
  return out
}

function git(repoRoot: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: cleanGitEnv(),
      maxBuffer: 256 * 1024 * 1024
    }).trim()
  } catch {
    return null
  }
}

/**
 * The verification context a plan executes under: the push's own context
 * digest (selection policy, input declarations, lockfiles, runner
 * configuration, environment), the head inventory's runner facts, the
 * selection engine and this adapter's execution version. `null` when the
 * digest cannot be read — an unreadable context refuses every reuse.
 */
export function nativeContext(verification: string | null, inventory: string): string | null {
  if (verification === null) return null
  return stableHash({ verification, inventory, engine: SELECTION_ENGINE, execution: LOCAL_RUN_EXECUTION })
}

/** The head, the tracked index and working-tree differences: what a run must leave as it found to prove anything. */
export function trackedState(repoRoot: string): string | null {
  const head = git(repoRoot, ['rev-parse', 'HEAD'])
  const status = git(repoRoot, ['status', '--porcelain=v1', '-uno', '-z'])
  const diff = git(repoRoot, ['diff', 'HEAD'])
  if (!head || status === null || diff === null) return null
  return createHash('sha256')
    .update(JSON.stringify([head, status, diff]))
    .digest('hex')
}

// ── The plan ───────────────────────────────────────────────────────────────

export type LocalPlanInput = {
  plan: SelectionPlan
  /** The head commit's inventory view. */
  view: InventoryView
  /** Repository-relative unresolved failed tests the push adds on top of the selection. */
  obligations: readonly string[]
}

export type LocalPlan = {
  groups: NativeGroup[]
  /** Every expected `<test>@<configuration>`, sorted. */
  identities: string[]
  /** Suites run whole, with why. */
  expanded: { suite: string; reason: string }[]
  problems: NativeProblem[]
}

/**
 * The native groups one push runs: the plan's tests and the push's
 * obligations, each identity once, grouped by suite and configuration. A
 * suite whose owner the schedule runs whole — its tests read inputs the
 * selection does not model, or its folder changed and its inputs are not
 * modeled — expands to every test it holds before anything runs, with its
 * reason; any other request runs exactly its file. A test the head inventory
 * does not hold is a problem, never dropped.
 */
export function localNativePlan(input: LocalPlanInput): LocalPlan {
  const { plan, view } = input
  const problems: NativeProblem[] = []
  const removed = new Set(plan.removedTests)
  const byId = new Map(view.tests.map((t) => [t.id, t]))
  const wanted = [...new Set([...plannedTests(plan), ...input.obligations])].filter((id) => !removed.has(id)).sort()
  const known: TestIdentity[] = []
  for (const id of wanted) {
    const identity = byId.get(id)
    if (identity) known.push(identity)
    else problems.push({ code: 'missing', path: id, detail: 'planned but not a test the head inventory holds' })
  }
  const changed = plan.changes.flatMap((c) => (c.from ? [c.path, c.from] : [c.path]))
  const wholeSuites: WholeSuiteRequest[] = []
  for (const suite of view.suites) {
    const prefix = suite.dir === '.' ? '' : `${suite.dir}/`
    const selected = known.some((t) => t.suite === suite.id)
    const reason =
      selected && suite.runner === 'vitest' && WHOLE_SUITE_OWNERS[suite.owner] !== undefined
        ? WHOLE_SUITE_OWNERS[suite.owner]
        : WHOLE_ON_CHANGE_OWNERS[suite.owner] !== undefined && changed.some((path) => path.startsWith(prefix))
          ? WHOLE_ON_CHANGE_OWNERS[suite.owner]
          : undefined
    if (reason === undefined) continue
    wholeSuites.push({ suite: suite.id, reason, identities: view.tests.filter((t) => t.suite === suite.id) })
  }
  const whole = new Set(wholeSuites.map((w) => w.suite))
  const tests: NativeTestRequest[] = known
    .filter((t) => !whole.has(t.suite))
    .map((t) => ({ ...t, configuration: DEFAULT_CONFIGURATION }))
  const grouping = groupNativeTests({ tests, wholeSuites, universe: view.tests })
  problems.push(...grouping.problems)
  const identities = grouping.groups.flatMap((g) => g.tests.map((t) => `${t}@${g.configuration}`)).sort(compare)
  return {
    groups: grouping.groups,
    identities,
    expanded: wholeSuites.map((w) => ({ suite: w.suite, reason: w.reason })),
    problems
  }
}

/** The selection note's mode fields for the base a push chose. */
function noteMode(
  kind: NativeSelection['baseKind'],
  base: string,
  selected: string[],
  obligations: string[],
  fullCount: () => number
): Pick<SelectionNote, 'mode'> & Record<string, unknown> {
  if (kind === 'since-green')
    return { mode: 'since-green', recordedHead: base, affectedSince: selected, fullCount: null }
  if (kind === 'rerun')
    return {
      mode: 'rerun',
      rerunOf: base,
      recordedHead: base,
      rerunFailed: obligations,
      affectedSince: selected.filter((file) => !obligations.includes(file)),
      fullCount: fullCount()
    }
  return { mode: 'full', fullCount: selected.length }
}

export type FrozenPlan = { note: SelectionNote; summary: string[] }

/**
 * The push's plan for the current head, frozen into a selection note: the
 * base the push chose, the shared selector's plan from it, the obligations
 * and the native groups. Throws, with the reason, when no plan can be made —
 * an unreadable revision or inventory, or a planned test the inventory does
 * not hold — so the push refuses rather than running something else.
 */
export function freezeLocalPlan(repoRoot: string): FrozenPlan {
  const started = performance.now()
  const head = currentHead(repoRoot)
  if (!head) throw new Error('the head commit could not be read')
  const branch = currentBranch(repoRoot)
  const remoteBase = resolveRemoteBase(repoRoot)
  const mergeBase = git(repoRoot, ['merge-base', remoteBase, head])
  if (!mergeBase) throw new Error(`no merge base between ${remoteBase} and ${head}`)
  const headView = readTestInventory(repoRoot, { head }).head
  const inputsClean = verificationInputsDirty(repoRoot) === false
  const context = nativeContext(computeVerificationContext(repoRoot)?.digest ?? null, headView.contextIdentity)
  const choice = chooseNativeBase({
    repoRoot,
    head,
    branch,
    mergeBase,
    failed: readFailedTestsRecord(repoRoot),
    passing: readPassingRecord(repoRoot),
    context,
    inputsClean,
    isAncestor: (ancestor) => isAncestor(repoRoot, ancestor, head),
    exists: existsSync,
    changedBetween: (from) => changedBetween(repoRoot, from, head)
  })
  const relative = (path: string) => path.slice(repoRoot.length + 1)
  const obligations = choice.obligations.map(relative)
  const planFrom = (base: string) => {
    const input = repositorySelectionInput(repoRoot, { base, head, consumer: 'local' })
    return { plan: selectTests(input), view: input.inventory.head }
  }
  const { plan, view } = planFrom(choice.base)
  const local = localNativePlan({ plan, view, obligations })
  if (local.problems.length > 0)
    throw new Error(
      `the native plan is not runnable: ${local.problems.map((p) => `${p.code} ${p.path}${p.group ? ` (${p.group})` : ''}: ${p.detail}`).join('; ')}`
    )
  const selected = [...new Set(local.groups.flatMap((g) => g.tests))].sort().map((id) => join(repoRoot, id))
  const usable = context !== null && inputsClean ? context : null
  const native: NativeSelection = {
    version: 1,
    base: choice.base,
    baseKind: choice.kind,
    plan: plan.identity,
    inventory: view.contextIdentity,
    context: context ?? '',
    identities: local.identities,
    obligations,
    groups: local.groups,
    expanded: local.expanded,
    command: local.identities.length > 0 && context !== null ? nativeRunCommand(context, local.identities) : null
  }
  const note = {
    version: 1,
    head,
    selected,
    ...noteMode(
      choice.kind,
      choice.base,
      selected,
      choice.obligations,
      () => localNativePlan({ ...planFrom(mergeBase), obligations }).identities.length
    ),
    ...(usable ? { context: usable } : {}),
    native
  } as SelectionNote
  const elapsed = performance.now() - started
  const summary = [
    `vinaya pre-push: native plan — ${local.identities.length} test(s) in ${local.groups.length} runner group(s), ` +
      `compared with ${choice.kind} ${choice.base.slice(0, 12)} (${choice.reason}) ` +
      `[${elapsed.toFixed(0)} ms selection, ${plan.profile.programMs.toFixed(0)} ms program]`,
    ...obligations.map((test) => `vinaya pre-push: re-running unresolved failed test ${test}`),
    ...local.expanded.map((e) => `vinaya pre-push: ${e.suite} runs whole: ${e.reason}`),
    ...(context === null
      ? ['vinaya pre-push: the verification context is unreadable; this run proves nothing for reuse']
      : [])
  ]
  return { note, summary }
}

// ── The run ────────────────────────────────────────────────────────────────

export type LocalRunOutcome = {
  passed: boolean
  completion: NativeCompletion
  /** Repository-relative failing tests, or `'all'` when a failure named none. */
  failed: string[] | 'all'
  /** Why the run proves nothing even though every runner passed, or `null`. */
  drift: string | null
}

/**
 * What a run of `groups` completed, as the structured result records it. The executions are checked against the
 * groups here, whatever the runner itself reported: a missing, extra, duplicate, unreadable or interrupted report is
 * a problem of the completion, never only of the run that produced it.
 */
export function completionOf(
  groups: readonly NativeGroup[],
  result: RunResult,
  roots: readonly string[]
): NativeCompletion {
  const validation = validateExecutedIdentities(groups, result.executions, { roots })
  const problems = new Map<string, NativeProblem>()
  for (const p of [...validation.problems, ...result.problems])
    problems.set(`${p.code}\u0000${p.path}\u0000${p.group ?? ''}\u0000${p.detail}`, p)
  return {
    version: 1,
    completed: problems.size === 0 && result.executions.every((e) => e.outcome === 'completed'),
    executed: validation.executed,
    failedRunners: [...result.failedRunners],
    problems: [...problems.values()].map((p) => ({
      code: p.code,
      path: p.path,
      ...(p.group ? { group: p.group } : {}),
      detail: p.detail
    }))
  }
}

/** The run's failing tests: every failed runner's named tests, or `'all'` when any failure named none. */
export function failedOf(result: RunResult, completion: NativeCompletion): string[] | 'all' {
  if (result.failedRunners.length === 0) return completion.completed ? [] : 'all'
  const named: string[] = []
  for (const group of result.failedRunners) {
    const tests = result.failedTests[group]
    if (tests === undefined || tests === 'all') return 'all'
    named.push(...tests)
  }
  return completion.completed ? [...new Set(named)].sort() : 'all'
}

/**
 * Runs a frozen native plan: every group, serially, with the git variables of
 * the invoking hook removed, then the check that each runner executed exactly
 * its tests. A green verdict needs every runner to pass and to have executed
 * its tests once, and the head, the tracked tree and the verification context
 * to be what they were when the run started.
 */
export function runFrozenPlan(
  repoRoot: string,
  native: NativeSelection,
  deps: {
    run?: (groups: readonly NativeGroup[]) => RunResult
    state?: () => string | null
    context?: () => string | null
    roots?: readonly string[]
  } = {}
): LocalRunOutcome {
  const state = deps.state ?? (() => trackedState(repoRoot))
  const contextNow =
    deps.context ?? (() => nativeContext(computeVerificationContext(repoRoot)?.digest ?? null, native.inventory))
  const before = state()
  const contextBefore = contextNow()
  const roots = deps.roots ?? [repoRoot, ...(existsSync(repoRoot) ? [realRoot(repoRoot)] : [])]
  const run =
    deps.run ??
    ((groups: readonly NativeGroup[]) =>
      runGroups(repoRoot, groups, { env: cleanGitEnv(), log: (line) => process.stderr.write(`${line}\n`) }))
  // An empty plan starts nothing.
  const result: RunResult =
    native.groups.length === 0
      ? { failedRunners: [], problems: [], executions: [], failedTests: {} }
      : run(native.groups)
  const completion = completionOf(native.groups, result, roots)
  const failed = failedOf(result, completion)
  const after = state()
  const contextAfter = contextNow()
  let drift: string | null = null
  if (before === null || after === null || before !== after)
    drift = 'the head or the tracked tree changed during the run'
  else if (contextBefore === null || contextBefore !== contextAfter || contextBefore !== native.context)
    drift = 'the verification context is not the one the plan was frozen under'
  const passed = failed !== 'all' && failed.length === 0 && completion.completed && drift === null
  return { passed, completion, failed, drift }
}

function realRoot(repoRoot: string): string {
  try {
    return realpathSync(repoRoot)
  } catch {
    return repoRoot
  }
}

/**
 * Records a native run: the head-bound last-push result (the loop's
 * structured authority), the failed record a refusal leaves or the passing
 * record a verified run leaves, and — on a complete green run only — the
 * receipt of its aggregate native command under its own verification context.
 */
export async function recordLocalRun(input: {
  repoRoot: string
  note: SelectionNote
  outcome: LocalRunOutcome
  log: string
  elapsedSeconds: number
  mode: LastPushResult['mode']
  now?: Date
  cache?: Parameters<typeof recordGreenTestRun>[4]
}): Promise<{ receipt: boolean }> {
  const { repoRoot, note, outcome } = input
  const native = note.native as NativeSelection
  const now = input.now ?? new Date()
  const head = currentHead(repoRoot)
  const branch = currentBranch(repoRoot)
  const absolute = (failed: string[] | 'all') => (failed === 'all' ? 'all' : failed.map((id) => join(repoRoot, id)))
  if (outcome.passed) {
    const passing = nativePassingRecord({
      note,
      completion: outcome.completion,
      head,
      branch,
      context: nativeContext(computeVerificationContext(repoRoot)?.digest ?? null, native.inventory),
      inputsClean: verificationInputsDirty(repoRoot) === false,
      treeClean: trackedTreeClean(repoRoot),
      now
    })
    if (passing) writeJsonUnderGit(repoRoot, FAILED_TESTS_RECORD, passing)
    else if (native.identities.length === 0) clearRecordOfKind(repoRoot, 'failed')
    else clearRecordOfKind(repoRoot, 'passed')
  } else if (outcome.drift !== null && outcome.failed !== 'all' && outcome.failed.length === 0) {
    // Every runner passed, but what it ran is no longer the head under test: no proof either way.
    clearRecordOfKind(repoRoot, 'passed')
  } else {
    const record: FailedTestsRecord = {
      version: 1,
      head,
      branch,
      failed: absolute(outcome.failed),
      recordedAt: now.toISOString(),
      selectionCompleted: outcome.failed !== 'all' && outcome.completion.completed,
      ...(native.context ? { context: native.context } : {})
    }
    writeJsonUnderGit(repoRoot, FAILED_TESTS_RECORD, record)
  }
  const result: LastPushResult = {
    version: 1,
    head,
    branch,
    mode: input.mode,
    outcome: outcome.passed ? 'passed' : 'failed',
    selectionCompleted: outcome.completion.completed && outcome.drift === null,
    selection: note,
    failed: outcome.passed ? [] : absolute(outcome.failed),
    elapsedSeconds: Number.isFinite(input.elapsedSeconds) ? input.elapsedSeconds : null,
    recordedAt: now.toISOString(),
    native: outcome.completion
  }
  writeJsonUnderGit(repoRoot, LAST_PUSH_RESULT, result)
  if (!outcome.passed || native.command === null) return { receipt: false }
  try {
    const receipt = await recordGreenTestRun(
      native.command,
      input.log,
      repoRoot,
      'pre-push',
      input.cache ?? defaultTestRunCache(),
      { context: native.context }
    )
    return { receipt }
  } catch (error) {
    // Best-effort: the run already proved green; a lost receipt costs a refused Evidence line, never a false one.
    process.stderr.write(
      `vinaya pre-push: the receipt of this run was not recorded (${error instanceof Error ? error.message : String(error)}).\n`
    )
    return { receipt: false }
  }
}

/** Whether the tracked tree holds exactly the head; `null` when git could not say. */
export function trackedTreeClean(repoRoot: string): boolean | null {
  const status = git(repoRoot, ['status', '--porcelain=v1', '-uno'])
  return status === null ? null : status === ''
}

// ── Command line ───────────────────────────────────────────────────────────

function repositoryRoot(): string {
  return git(process.cwd(), ['rev-parse', '--show-toplevel']) ?? process.cwd()
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

function pushMode(): LastPushResult['mode'] {
  const mode = process.env.VINAYA_PUSH_MODE
  return mode === 'storage' || mode === 'ready' ? mode : 'default'
}

function selectCommand(repoRoot: string): number {
  let frozen: FrozenPlan
  try {
    frozen = freezeLocalPlan(repoRoot)
  } catch (error) {
    process.stderr.write(
      `vinaya pre-push: refused — no native test plan: ${error instanceof Error ? error.message : String(error)}\n`
    )
    return 1
  }
  writeJsonUnderGit(repoRoot, SELECTION_NOTE, frozen.note)
  for (const file of frozen.note.selected) process.stdout.write(`${file}\n`)
  for (const line of frozen.summary) process.stderr.write(`${line}\n`)
  return 0
}

async function runCommand(repoRoot: string, logPath: string | undefined): Promise<number> {
  const started = Date.now()
  const head = currentHead(repoRoot)
  const note = parseSelectionNote(readJsonUnderGit(repoRoot, SELECTION_NOTE), head)
  if (!note?.native || note.native.version !== 1) {
    process.stdout.write(`vinaya pre-push: refused — no frozen native test plan for ${head}; nothing ran\n`)
    return 1
  }
  const outcome = runFrozenPlan(repoRoot, note.native)
  const elapsed = Math.round((Date.now() - started) / 1000)
  let log = ''
  if (logPath) {
    try {
      log = readFileSync(logPath, 'utf8')
    } catch {
      log = ''
    }
  }
  try {
    await recordLocalRun({ repoRoot, note, outcome, log, elapsedSeconds: elapsed, mode: pushMode() })
  } catch (error) {
    process.stderr.write(
      `vinaya pre-push: could not record this run (${error instanceof Error ? error.message : String(error)}).\n`
    )
  }
  const count = note.native.identities.length
  if (outcome.passed) {
    process.stdout.write(
      count === 0
        ? 'vinaya pre-push: selected 0 test(s) — no runner started\n'
        : `vinaya pre-push: selected ${count} test(s) in ${note.native.groups.length} native group(s), ${elapsed}s — all green\n`
    )
    return 0
  }
  process.stdout.write(`\nvinaya pre-push: refused — selected ${count} test(s), ${elapsed}s:\n`)
  if (outcome.failed === 'all') process.stdout.write('  a runner failed without naming its failing tests\n')
  else for (const test of outcome.failed) process.stdout.write(`  failing: ${test}\n`)
  for (const p of outcome.completion.problems)
    process.stdout.write(`  ${p.code} ${p.path}${p.group ? ` (${p.group})` : ''}: ${p.detail}\n`)
  if (outcome.drift) process.stdout.write(`  ${outcome.drift}\n`)
  return 1
}

function exactCommand(repoRoot: string, argv: readonly string[]): number {
  const parsed = parseNativeRunCommand(`bun scripts/test-suites/local-run.ts ${argv.join(' ')}`)
  if (!parsed) {
    process.stderr.write('usage: local-run.ts exact --context <digest> -- <test@configuration>...\n')
    return 2
  }
  const head = currentHead(repoRoot)
  const view = readTestInventory(repoRoot, { head }).head
  const context = nativeContext(computeVerificationContext(repoRoot)?.digest ?? null, view.contextIdentity)
  if (context !== parsed.context) {
    process.stderr.write(
      `vinaya local-run: refused — this command names verification context ${parsed.context}, and this checkout runs under ${context ?? 'an unreadable context'}\n`
    )
    return 1
  }
  const byId = new Map(view.tests.map((t) => [t.id, t]))
  const problems: string[] = []
  const tests: NativeTestRequest[] = []
  for (const identity of parsed.identities) {
    const at = identity.lastIndexOf('@')
    const test = byId.get(identity.slice(0, at))
    if (!test) problems.push(`${identity.slice(0, at)} is not a test the inventory holds`)
    else tests.push({ ...test, configuration: identity.slice(at + 1) })
  }
  const grouping = groupNativeTests({ tests, universe: view.tests })
  problems.push(...grouping.problems.map((p) => `${p.code} ${p.path}: ${p.detail}`))
  if (problems.length > 0) {
    process.stderr.write(`vinaya local-run: refused — ${problems.join('; ')}\n`)
    return 1
  }
  const result = runGroups(repoRoot, grouping.groups, { env: cleanGitEnv() })
  for (const p of result.problems)
    process.stderr.write(`vinaya local-run: ${p.code} ${p.path}${p.group ? ` (${p.group})` : ''}: ${p.detail}\n`)
  return result.failedRunners.length > 0 || result.problems.length > 0 ? 1 : 0
}

async function main(argv: readonly string[]): Promise<number> {
  const repoRoot = repositoryRoot()
  if (argv[0] === 'select') return selectCommand(repoRoot)
  if (argv[0] === 'run') return runCommand(repoRoot, argValue(argv, '--log'))
  if (argv[0] === 'exact') return exactCommand(repoRoot, argv)
  process.stderr.write(
    'usage: local-run.ts select | run --log <capture> | exact --context <digest> -- <test@configuration>...\n'
  )
  return 2
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
