#!/usr/bin/env bun
/**
 * This repository's push gate: the tests a push runs are exactly
 * `plannedTests(selectTests(loadSelectionInputs({ caller: 'push' })))` — the one
 * adapter (`repository-selection.ts`) reads the push's base, record, failed
 * tests and earlier passes, the selection package holds every rule — and each
 * runs once under its own native runner, one runner start after another. Every
 * test file a run passes completely is kept as a pass entry the next selection
 * may reuse. This file holds no selection rule and passes no selection option.
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
 *     runs exactly the frozen plan for the current head, leaves after each
 *     runner group the failed record a stop there would need, then records the
 *     head-bound result, the passing or failed record and, on a complete green
 *     run, the receipt of its aggregate native command; exits 0 only on that
 *     run. A failed record lists every planned test the run did not confirm.
 *   bun scripts/test-suites/local-run.ts exact --context <digest> -- <test@configuration>...
 *     the aggregate native command itself: runs exactly those identities and
 *     refuses under any other verification context. It records nothing.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  clearRecordOfKind,
  computeVerificationContext,
  currentBranch,
  currentHead,
  FAILED_TESTS_RECORD,
  type FailedTestsRecord,
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
} from '../../harness/kernel/gates/ring0-hooks/pre-push/pre-push-failed-tests.js'
// The context is read under the same environment the selection read it under, so a plan and its run agree.
import { runEnvironment } from '../../harness/kernel/gates/ring0-hooks/pre-push/junit-store.js'
import {
  defaultTestRunCache,
  recordGreenTestRun
} from '../../harness/processes/vinaya-strict/tools/pr-report/pr-report-engine.js'
import {
  nativeRunCommand,
  parseNativeRunCommand
} from '../../harness/kernel/gates/ring0-hooks/pre-push/pre-push-test-runner.js'
import {
  DEFAULT_CONFIGURATION,
  FAILED_RERUN_OBLIGATION,
  groupNativeTests,
  type InventoryView,
  type NativeGroup,
  type NativeProblem,
  type NativeTestRequest,
  plannedTests,
  type SelectionPlan,
  selectTests,
  type TestIdentity,
  validateExecutedIdentities,
  type WholeSuiteRequest
} from '@attalabs/test-selection'
import { readTestInventory } from './inventory-check.js'

import {
  LOCAL_RUN_EXECUTION,
  loadSelectionInputs,
  nativeContext,
  passEntriesOfRun,
  recordAt,
  type SelectionAccount,
  storePassEntries
} from './repository-selection.js'

export { LOCAL_RUN_EXECUTION, nativeContext }
import { type GroupOutcome, type RunResult, runGroups } from './schedule.js'

/** The most files one local runner start holds, so a push's runner memory is released between chunks. */
export const LOCAL_GROUP_FILE_CAP = 40

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
 * The native groups one push runs: exactly the plan's tests (`plannedTests`), each identity once, grouped by suite
 * and configuration. A suite the plan runs whole is one whole-suite request with its reason; every other test runs
 * exactly its file. A planned test the head inventory does not hold is a problem, never dropped.
 */
export function localNativePlan(input: LocalPlanInput): LocalPlan {
  const { plan, view } = input
  const problems: NativeProblem[] = []
  const removed = new Set(plan.removedTests)
  const byId = new Map(view.tests.map((t) => [t.id, t]))
  const wanted = plannedTests(plan).filter((id) => !removed.has(id))
  const planned: TestIdentity[] = []
  for (const id of wanted) {
    const identity = byId.get(id)
    if (identity) planned.push(identity)
    else problems.push({ code: 'missing', path: id, detail: 'planned but not a test the head inventory holds' })
  }
  const running = new Set(planned.map((t) => t.id))
  const wholeSuites: WholeSuiteRequest[] = plan.wholeSuites.flatMap((whole) => {
    const identities = whole.tests.filter((id) => running.has(id)).map((id) => byId.get(id) as TestIdentity)
    return identities.length > 0 ? [{ suite: whole.suite, reason: whole.reason, identities }] : []
  })
  const inWhole = new Set(wholeSuites.flatMap((w) => w.identities.map((t) => t.id)))
  const tests: NativeTestRequest[] = planned
    .filter((t) => !inWhole.has(t.id))
    .map((t) => ({ ...t, configuration: DEFAULT_CONFIGURATION }))
  const grouping = groupNativeTests({
    tests,
    wholeSuites,
    universe: view.tests,
    maxFilesPerGroup: LOCAL_GROUP_FILE_CAP
  })
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
 * adapter's inputs (`loadSelectionInputs`), the selection's plan of them, and
 * the native groups of exactly its planned tests. Throws, with the reason,
 * when no plan can be made — an unreadable revision or inventory, or a planned
 * test the inventory does not hold — so the push refuses rather than running
 * something else.
 */
export function freezeLocalPlan(repoRoot: string): FrozenPlan {
  const started = performance.now()
  const input = loadSelectionInputs({ repoRoot, caller: 'push' })
  const plan = selectTests(input)
  const { account } = input
  const choice = account.choice as NonNullable<SelectionAccount['choice']>
  const view = input.inventory.head
  const head = input.head
  const context = account.context
  const local = localNativePlan({ plan, view })
  if (local.problems.length > 0)
    throw new Error(
      `the native plan is not runnable: ${local.problems.map((p) => `${p.code} ${p.path}${p.group ? ` (${p.group})` : ''}: ${p.detail}`).join('; ')}`
    )
  const selected = [...new Set(local.groups.flatMap((g) => g.tests))].sort().map((id) => join(repoRoot, id))
  const obligations = plan.obligations.filter((o) => o.obligation === FAILED_RERUN_OBLIGATION).map((o) => o.test)
  const usable = context !== null && account.inputsClean ? context : null
  const native: NativeSelection = {
    version: 1,
    base: choice.base,
    baseKind: choice.kind,
    plan: plan.identity,
    inventory: view.contextIdentity,
    context: context ?? '',
    ...(account.contextParts ? { contextParts: account.contextParts } : {}),
    reused: plan.reused.map((r) => ({ test: r.test, provenAt: r.head })),
    records: {
      commit: plan.records.commit,
      recorded: plan.records.recorded.length,
      fallbacks: plan.records.fallbacks.map((f) => ({ id: f.id, reason: f.reason, tests: f.tests.length }))
    },
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
    ...noteMode(choice.kind, choice.base, selected, choice.obligations, account.fullCount),
    ...(usable ? { context: usable } : {}),
    native
  } as SelectionNote
  const elapsed = performance.now() - started
  const summary = [
    `vinaya pre-push: native plan — ${local.identities.length} test(s) in ${local.groups.length} runner group(s), ` +
      `compared with ${choice.kind} ${choice.base.slice(0, 12)} (${choice.reason}) ` +
      `[${elapsed.toFixed(0)} ms selection, ${plan.profile.programMs.toFixed(0)} ms program]`,
    ...obligations.map((test) => `vinaya pre-push: re-running unresolved failed test ${test}`),
    ...plan.reused.map((r) => `vinaya pre-push: reusing ${r.test}, passed at ${r.head.slice(0, 12)} (${r.source})`),
    plan.records.commit
      ? `vinaya pre-push: ${plan.records.recorded.length} test(s) decided by the read record of ${plan.records.commit.slice(0, 12)}; ${plan.records.fallbacks.map((f) => `${f.tests.length} by static selection (${f.id})`).join(', ') || 'none left to static selection'}`
      : `vinaya pre-push: every test decided by static selection (${account.recordNote})`,
    ...local.expanded.map((e) => `vinaya pre-push: ${e.suite} runs whole: ${e.reason}`),
    ...(choice.branchSide
      ? [
          `vinaya pre-push: the branch-side set (${choice.branchSide.paths.length} path(s) the branch itself changed since the merge of ${choice.branchSide.brought.slice(0, 12)}) left out ${plan.leftOut.length} planned test(s) only default-branch changes reached`
        ]
      : []),
    ...(context === null
      ? ['vinaya pre-push: the verification context is unreadable; the run will be refused even if every runner passes']
      : [])
  ]
  return { note, summary }
}

// ── The run ────────────────────────────────────────────────────────────────

export type LocalRunOutcome = {
  passed: boolean
  completion: NativeCompletion
  /**
   * Repository-relative failing tests and scheduled files no runner reported, or `'all'` when a failure named
   * neither.
   */
  failed: string[] | 'all'
  /** Repository-relative scheduled files no runner reported executed. */
  unreported?: string[]
  /**
   * Repository-relative tests of the plan the run did not confirm as passed (`schedule.ts`'s `GroupOutcome` rule);
   * absent when the runner result carried no group outcomes, so nothing beyond `failed` is known.
   */
  unconfirmed?: string[]
  /** Why the run proves nothing even though every runner passed, or `null`. */
  drift: string | null
  /** Each Bun runner group's JUnit report, as written, with the folder it ran in: the run's complete passes. */
  reports?: { cwd: string; xml: string }[]
  /** Present when the run stopped after a failing runner group: what it left unrun, for the next push to run. */
  stopped?: { tests: number; groups: number }
}

/** Where the run writes the record each finished runner group leaves, and what binds it to this run. */
export type GroupRecordWriter = {
  head: string
  branch: string
  /** This run's start, the binding the driver checks on a deadline stop. */
  runStartedAt: string
  /** Whether the tracked tree held exactly the head when the run started; only then is a record written per group. */
  treeClean: boolean | null
  write: (record: FailedTestsRecord) => void
}

/** The plan's tests, repository-relative, each once, sorted. */
const planTests = (native: NativeSelection): string[] =>
  [...new Set(native.groups.flatMap((g) => g.tests))].sort(compare)

/**
 * The record of a run that confirms nothing — its head, tracked tree or verification context moved, or no runner
 * confirmed a test: every test of its plan, the earlier record's obligations among them, as an incomplete
 * selection, so the next push runs its full selection plus those tests.
 */
function unprovenRecord(input: {
  repoRoot: string
  native: NativeSelection
  head: string
  branch: string
  now: Date
}): FailedTestsRecord {
  return {
    version: 1,
    head: input.head,
    branch: input.branch,
    failed: planTests(input.native).map((id) => join(input.repoRoot, id)),
    recordedAt: input.now.toISOString(),
    selectionCompleted: false,
    ...(input.native.context ? { context: input.native.context } : {}),
    ...(input.native.contextParts ? { contextParts: input.native.contextParts } : {})
  }
}

/**
 * The record of a run whose confirmed tests narrow the next push: `unconfirmed` holds every test of the plan the run
 * did not confirm, and the record says so.
 */
function unconfirmedRecord(input: {
  repoRoot: string
  native: NativeSelection
  head: string
  branch: string
  unconfirmed: readonly string[]
  unreported: readonly string[]
  runStartedAt?: string
  now: Date
}): FailedTestsRecord {
  const absolute = (ids: readonly string[]) => ids.map((id) => join(input.repoRoot, id))
  return {
    version: 1,
    head: input.head,
    branch: input.branch,
    failed: absolute(input.unconfirmed),
    recordedAt: input.now.toISOString(),
    selectionCompleted: true,
    ...(input.native.context ? { context: input.native.context } : {}),
    ...(input.native.contextParts ? { contextParts: input.native.contextParts } : {}),
    confirmed: planTests(input.native).filter((id) => !input.unconfirmed.includes(id)),
    failedHoldsUnconfirmed: true,
    unreported: absolute(input.unreported),
    ...(input.runStartedAt ? { runStartedAt: input.runStartedAt } : {})
  }
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

/**
 * The run's named files: every failing test the reports name (a failed runner's own list when the result carries no
 * group outcomes) and every scheduled file no runner reported — or `'all'` when a run that did not pass named none.
 */
export function failedOf(result: RunResult, completion: NativeCompletion): string[] | 'all' {
  const outcomes = new Map((result.outcomes ?? []).map((o) => [o.group, o]))
  const named = new Set<string>()
  for (const outcome of outcomes.values()) for (const id of [...outcome.failed, ...outcome.unreported]) named.add(id)
  for (const group of result.failedRunners) {
    const tests = result.failedTests[group]
    if (!outcomes.has(group) && Array.isArray(tests)) for (const id of tests) named.add(id)
  }
  if (named.size > 0) return [...named].sort(compare)
  return result.failedRunners.length === 0 && completion.completed ? [] : 'all'
}

/**
 * Runs a frozen native plan: every group, serially, with the git variables of
 * the invoking hook removed, then the check that each runner executed exactly
 * its tests. A green verdict needs every runner to pass and to have executed
 * its tests once, and the head, the tracked tree and the verification context
 * to be what they were when the run started.
 *
 * With `groupRecord`, and a tracked tree that held exactly the head when the
 * run started, each finished group leaves the record a stop at that moment
 * would need, through a temporary file and a rename: after re-reading the
 * tracked state and the verification context, the plan's tests not yet
 * confirmed — the finished groups' obligations and every test of the groups
 * still to run — bound to this run. A moved state or context writes the
 * record of a run that confirms nothing instead, and stops the writes; a
 * group that leaves nothing confirmed so far writes nothing, so an earlier
 * record stays.
 */
/**
 * How the frozen plan's groups run: a push stops after the first failing group and refuses at once; a review
 * round's tests run every group, so the record confirms every group that passed and the next round re-runs only
 * what failed or never ran.
 */
export function frozenPlanRunOptions(input: { allGroups: boolean }): { stopAfterFailedGroup: boolean } {
  return { stopAfterFailedGroup: !input.allGroups }
}

export function runFrozenPlan(
  repoRoot: string,
  native: NativeSelection,
  deps: {
    run?: (groups: readonly NativeGroup[], onGroupEnd: (outcome: GroupOutcome) => void) => RunResult
    state?: () => string | null
    context?: () => string | null
    roots?: readonly string[]
    groupRecord?: GroupRecordWriter
    now?: () => Date
    /** Run every group even after one fails, so each passing group is confirmed; a push stops at the first. */
    allGroups?: boolean
  } = {}
): LocalRunOutcome {
  const state = deps.state ?? (() => trackedState(repoRoot))
  const contextNow =
    deps.context ??
    (() => nativeContext(computeVerificationContext(repoRoot, runEnvironment())?.digest ?? null, native.inventory))
  const now = deps.now ?? (() => new Date())
  const before = state()
  const contextBefore = contextNow()
  const roots = deps.roots ?? [repoRoot, ...(existsSync(repoRoot) ? [realRoot(repoRoot)] : [])]
  const plan = planTests(native)
  const writer = deps.groupRecord
  let writing =
    writer !== undefined &&
    writer.treeClean === true &&
    before !== null &&
    contextBefore !== null &&
    contextBefore === native.context
  const finished: GroupOutcome[] = []
  const onGroupEnd = (outcome: GroupOutcome) => {
    finished.push(outcome)
    if (!writing || writer === undefined) return
    try {
      if (state() !== before || contextNow() !== contextBefore) {
        writing = false
        writer.write(unprovenRecord({ repoRoot, native, head: writer.head, branch: writer.branch, now: now() }))
        return
      }
      const confirmed = new Set(finished.flatMap((o) => o.confirmed))
      if (confirmed.size === 0) return
      writer.write(
        unconfirmedRecord({
          repoRoot,
          native,
          head: writer.head,
          branch: writer.branch,
          unconfirmed: plan.filter((id) => !confirmed.has(id)),
          unreported: [...new Set(finished.flatMap((o) => o.unreported))].sort(compare),
          runStartedAt: writer.runStartedAt,
          now: now()
        })
      )
    } catch {
      // A record a group could not write leaves the one before it: never a narrower answer than the run proved.
      writing = false
    }
  }
  const run =
    deps.run ??
    ((groups: readonly NativeGroup[], onEnd: (outcome: GroupOutcome) => void) =>
      runGroups(repoRoot, groups, {
        env: cleanGitEnv(),
        log: (line) => process.stderr.write(`${line}\n`),
        announce: true,
        onGroupEnd: onEnd,
        onReport: (group, xml) => reports.push({ cwd: group.cwd, xml }),
        ...frozenPlanRunOptions({ allGroups: deps.allGroups === true })
      }))
  const reports: { cwd: string; xml: string }[] = []
  // An empty plan starts nothing.
  const result: RunResult =
    native.groups.length === 0
      ? { failedRunners: [], problems: [], executions: [], failedTests: {}, outcomes: [] }
      : run(native.groups, onGroupEnd)
  // A run that stopped after a failing group never started the rest: those groups are unrun, not missing executions.
  // A group ran when the scheduler heard its end (a signaled or interrupted one included) or recorded its execution.
  const started = new Set([...(result.outcomes ?? []).map((o) => o.group), ...result.executions.map((e) => e.group)])
  const unrunGroups = native.groups.filter((g) => !started.has(g.id))
  const stopped = result.failedRunners.length > 0 && started.size > 0 && unrunGroups.length > 0
  const ranGroups = stopped ? native.groups.filter((g) => started.has(g.id)) : native.groups
  const ranTests = new Set(ranGroups.flatMap((g) => g.tests))
  const base = completionOf(ranGroups, result, roots)
  const completion: NativeCompletion = stopped ? { ...base, completed: false } : base
  const failed = failedOf(result, completion)
  const after = state()
  const contextAfter = contextNow()
  let drift: string | null = null
  if (before === null || after === null || before !== after)
    drift = 'the head or the tracked tree changed during the run'
  else if (contextBefore === null || contextBefore !== contextAfter || contextBefore !== native.context)
    drift = 'the verification context is not the one the plan was frozen under'
  const passed = result.failedRunners.length === 0 && failed !== 'all' && failed.length === 0 && completion.completed
  const outcomes = result.outcomes
  const confirmed = new Set((outcomes ?? []).flatMap((o) => o.confirmed))
  return {
    passed: passed && drift === null,
    completion,
    failed,
    unreported: [...new Set((outcomes ?? []).flatMap((o) => o.unreported))].sort(compare),
    ...(outcomes !== undefined ? { unconfirmed: plan.filter((id) => !confirmed.has(id)) } : {}),
    drift,
    reports,
    ...(stopped
      ? {
          stopped: {
            tests: new Set(unrunGroups.flatMap((g) => g.tests).filter((t) => !ranTests.has(t))).size,
            groups: unrunGroups.length
          }
        }
      : {})
  }
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
  /** This run's start, as its per-group records carry it: the final record replaces or removes any of them. */
  runStartedAt?: string
}): Promise<{ receipt: boolean }> {
  const { repoRoot, note, outcome } = input
  const native = note.native as NativeSelection
  const now = input.now ?? new Date()
  const head = currentHead(repoRoot)
  const branch = currentBranch(repoRoot)
  const absolute = (failed: string[] | 'all') => (failed === 'all' ? 'all' : failed.map((id) => join(repoRoot, id)))
  const unconfirmed = outcome.unconfirmed
  if (outcome.passed) {
    const passing = nativePassingRecord({
      note,
      previous: readPassingRecord(repoRoot),
      completion: outcome.completion,
      head,
      branch,
      context: nativeContext(computeVerificationContext(repoRoot, runEnvironment())?.digest ?? null, native.inventory),
      inputsClean: verificationInputsDirty(repoRoot) === false,
      treeClean: trackedTreeClean(repoRoot),
      now
    })
    const own = readFailedTestsRecord(repoRoot)
    const ownRecord =
      input.runStartedAt !== undefined && own?.head === note.head && own.runStartedAt === input.runStartedAt
    if (passing) writeJsonUnderGit(repoRoot, FAILED_TESTS_RECORD, passing)
    else if (native.identities.length === 0 || ownRecord) clearRecordOfKind(repoRoot, 'failed')
    else clearRecordOfKind(repoRoot, 'passed')
  } else if (outcome.drift !== null && native.groups.length > 0) {
    // What ran is no longer the head under test: it confirms nothing, failures or not.
    writeJsonUnderGit(repoRoot, FAILED_TESTS_RECORD, unprovenRecord({ repoRoot, native, head: note.head, branch, now }))
  } else if (outcome.drift !== null && outcome.failed !== 'all' && outcome.failed.length === 0) {
    // Every runner passed, but what it ran is no longer the head under test: no proof either way.
    clearRecordOfKind(repoRoot, 'passed')
  } else if (unconfirmed !== undefined) {
    // A stopped run always leaves the unconfirmed record: it names its unrun tests as unconfirmed, never as proven.
    const record =
      outcome.stopped === undefined && (unconfirmed.length === 0 || unconfirmed.length === planTests(native).length)
        ? unprovenRecord({ repoRoot, native, head, branch, now })
        : unconfirmedRecord({
            repoRoot,
            native,
            head,
            branch,
            unconfirmed,
            unreported: outcome.unreported ?? [],
            ...(input.runStartedAt ? { runStartedAt: input.runStartedAt } : {}),
            now
          })
    writeJsonUnderGit(repoRoot, FAILED_TESTS_RECORD, record)
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
    native: outcome.completion,
    ...(!outcome.passed && outcome.unreported?.length ? { unreported: absolute(outcome.unreported) as string[] } : {})
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

async function runCommand(repoRoot: string, logPath: string | undefined, allGroups = false): Promise<number> {
  const started = Date.now()
  const head = currentHead(repoRoot)
  const note = parseSelectionNote(readJsonUnderGit(repoRoot, SELECTION_NOTE), head)
  if (!note?.native || note.native.version !== 1) {
    process.stdout.write(`vinaya pre-push: refused — no frozen native test plan for ${head}; nothing ran\n`)
    return 1
  }
  const runStartedAt = new Date(started).toISOString()
  const outcome = runFrozenPlan(repoRoot, note.native, {
    allGroups,
    groupRecord: {
      head: note.head,
      branch: currentBranch(repoRoot),
      runStartedAt,
      treeClean: trackedTreeClean(repoRoot),
      write: (record) => writeJsonUnderGit(repoRoot, FAILED_TESTS_RECORD, record)
    }
  })
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
    await recordLocalRun({ repoRoot, note, outcome, log, elapsedSeconds: elapsed, mode: pushMode(), runStartedAt })
  } catch (error) {
    process.stderr.write(
      `vinaya pre-push: could not record this run (${error instanceof Error ? error.message : String(error)}).\n`
    )
  }
  // Every test file this run passed completely counts as a pass the next selection may reuse.
  if (outcome.drift === null && (outcome.reports ?? []).length > 0)
    try {
      const commit = note.native.records?.commit
      storePassEntries(
        repoRoot,
        passEntriesOfRun({
          repoRoot,
          view: readTestInventory(repoRoot, { head }).head,
          reports: outcome.reports ?? [],
          record: commit ? recordAt(repoRoot, commit) : null,
          source: `push ${head.slice(0, 12)}`
        })
      )
    } catch {}
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
  if (outcome.stopped)
    process.stdout.write(
      `  stopped after the first failing runner group: ${outcome.stopped.tests} test(s) in ${outcome.stopped.groups} runner group(s) not run; the next push runs them\n`
    )
  if (outcome.failed === 'all') process.stdout.write('  a runner failed without naming its failing tests\n')
  else {
    const unreported = new Set(outcome.unreported ?? [])
    for (const test of outcome.failed) if (!unreported.has(test)) process.stdout.write(`  failing: ${test}\n`)
    for (const test of unreported) process.stdout.write(`  not reported by its runner: ${test}\n`)
  }
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
  const context = nativeContext(
    computeVerificationContext(repoRoot, runEnvironment())?.digest ?? null,
    view.contextIdentity
  )
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
  const grouping = groupNativeTests({ tests, universe: view.tests, maxFilesPerGroup: LOCAL_GROUP_FILE_CAP })
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
  if (argv[0] === 'run') return runCommand(repoRoot, argValue(argv, '--log'), argv.includes('--all-groups'))
  if (argv[0] === 'exact') return exactCommand(repoRoot, argv)
  process.stderr.write(
    'usage: local-run.ts select | run [--all-groups] --log <capture> | exact --context <digest> -- <test@configuration>...\n'
  )
  return 2
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2))
