#!/usr/bin/env bun
/**
 * A pull request's CI plan: one plan, computed in the build job of
 * `.github/workflows/ci.yml`, that decides what every other job runs and what
 * the `Vinaya CI` aggregate must see succeed.
 *
 * The tests come from the shared selection library through this
 * repository's adapter (`scripts/test-suites/repository-selection.ts`, its
 * `ci` consumer): the same immutable `selectTests` a local push uses, over the
 * same canonical inventory, so for the same commits, inventory and policy the
 * two require the same tests. This plan adds only CI's own policy, each
 * addition stated with its reason:
 *
 * - the inventory's always-run list (`prePush.alwaysRun`) as a CI obligation,
 *   because its inputs are not modeled — kept until they are declared in the
 *   inventory and a paired local/CI regression proves the narrower answer;
 * - the mandatory duties of `governance-obligations.ts`;
 * - the task prerequisites of the build job's own steps: which packages to
 *   typecheck, from the manifests' workspace dependencies and every relative
 *   import that crosses a package's folder, and which files to lint;
 * - which conditional jobs run: the root-configuration probe when the root
 *   configuration changes, the Linux sandbox suite when the change reaches
 *   it. The macOS sandbox suite is advisory and outside the plan.
 *
 * Where the selected tests run is the schedule's
 * (`scripts/test-suites/schedule.ts`): the plan hands it the selection as a
 * decision, and checks here, whole, that every planned test is placed exactly
 * once — a lost or doubled group makes the plan invalid.
 *
 * It runs everything, with the reason, when the base guard
 * (`scripts/ci/base-guard.ts`, the base commit's own copy) says the change
 * touches a planning input or gives no verdict, on every push to the default
 * branch, and when the revisions or the selection cannot be read.
 *
 *   bun scripts/ci/impact-plan.ts --event pull_request --base <sha> --head <approved sha> --tested <sha>
 *     [--guard <file>] [--out-dir <dir>] [--github-output <file>] [--summary <file>]
 *   bun scripts/ci/impact-plan.ts --event push --base <before sha> --head <sha> --tested <sha> [--shadow] ...
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { CI_SHARD_COUNT, CI_SHARD_LIST_OWNER, shardFileRelPath } from '../../apps/cli/src/lib/ci-shard-membership.ts'
import type { CiDecision } from '../../apps/cli/src/lib/ci-test-selection.ts'
import {
  DEFAULT_CONFIGURATION,
  type NativeProblem,
  type SelectionObligation,
  type SelectionPlan,
  selectTests,
  stableHash
} from '../../apps/cli/src/lib/verification/index.ts'
import {
  type InventoryView,
  readTestInventory,
  revisionReader,
  type TreeReader
} from '../test-suites/inventory-check.ts'
import { alwaysRunObligations, repositorySelectionInput, resolveCommit } from '../test-suites/repository-selection.ts'
import { buildTestSchedule, checkSchedule, ciScheduleInput } from '../test-suites/schedule.ts'
import { ADVISORY_JOBS, type CiJob, GOVERNANCE_OBLIGATIONS } from './governance-obligations.ts'

export type CiEvent = 'pull_request' | 'push'

/** The base guard's answer, as `base-guard.ts` prints it. */
export type GuardInput = { verdict: 'plan' | 'full'; reason: string; guarded: string[] }

/** The one test the Linux sandbox job runs (`ci.yml`, "Run the suite under both sandboxes"). */
export const SANDBOX_SUITE_TEST = 'apps/cli/tests/sandbox-conformance/sandbox-conformance.test.ts'
/** The root configuration the probe job proves (`scripts/ci/config-probe.ts`). */
export const ROOT_CONFIG = 'vinaya.config.json'

/** Files Biome checks (`biome.json`'s `files.includes`); a compiler configuration it excludes is never linted. */
const LINTED = /\.(ts|tsx|js|jsx|json)$/
/** Root files every lint run reads: its configuration and the installed Biome. */
const LINT_ROOT_INPUTS = ['biome.json', 'package.json', 'bun.lock']
/** Files a type checker reads: code, JSON a module imports, and compiler configuration. */
const TYPED = /\.(c|m)?(j|t)sx?$|\.json$/
/** Root files every package's typecheck resolves through. */
const TYPE_ROOT_INPUT = /^(package\.json|bun\.lock|turbo\.json|tsconfig(\..+)?\.json)$/

export type StepScope = { scope: 'skip' | 'some' | 'all'; items: string[]; reason: string }
export type JobDecision = { required: boolean; reason: string }
export type PlannedRun = { test: string; suite: string; why: string[] }

export type ShadowPlan =
  | { state: 'available'; base: string; identity: string; jobs: CiJob[]; tests: string[] }
  | { state: 'inconclusive'; reason: string }

export type CiPlan = {
  schema: 'vinaya.ci-plan'
  schemaVersion: 1
  /** Hash of every field but `identity`, `shadow` and `profile`. */
  identity: string
  event: CiEvent
  /** The comparison base. */
  base: string
  /** The pull request head the plan approves — on a push, the pushed commit. */
  approvedHead: string
  /** The tree the jobs check out and test: a pull request's merge commit. */
  testedTree: string
  guard: GuardInput
  scope: 'selected' | 'full'
  /** Why everything runs, or `null`. */
  reason: string | null
  inventory: { head: { contextIdentity: string; graphIdentity: string }; base: { contextIdentity: string } | null }
  /** Hash of every suite's runner, working directory, preload and environment at the tested tree. */
  runners: string
  selection: {
    identity: string
    required: number
    fallbacks: { id: string; reason: string; tests: number }[]
    policies: { id: string; kind: string; duty: string }[]
  } | null
  changed: string[]
  /** Every planned test, with why. Empty when everything runs. */
  tests: PlannedRun[]
  /** Each suite with tests the plan does not run, and why. */
  unselected: { suite: string; tests: number; reason: string }[]
  /** The schedule's input, as `schedule.ts --decision` reads it. */
  decision: CiDecision
  jobs: Record<CiJob, JobDecision>
  steps: { lint: StepScope; typecheck: StepScope }
  obligations: { id: string; kind: string; job: CiJob; step?: string; duty: string }[]
  schedule: { counts: Record<string, number>; problems: NativeProblem[] }
  problems: string[]
  valid: boolean
  shadow: ShadowPlan | null
  profile: { totalMs: number }
}

export type CiPlanInput = {
  repoRoot: string
  event: CiEvent
  base: string
  approvedHead: string
  testedTree: string
  /** The base guard's verdict; absent means none was given, so everything runs. */
  guard?: GuardInput | null
  /** On a push, also plan the change as a pull request would have, for diagnosis only. */
  shadow?: boolean
  /** Fetches a commit the checkout lacks; the default asks `origin`, and a failure leaves it missing. */
  fetch?: (sha: string) => void
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function git(repoRoot: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024
  })
}

/**
 * The caller's preparation: each revision resolved to its commit, fetched
 * first when the checkout lacks it — before any selection reads it.
 */
export function prepareRevisions(
  repoRoot: string,
  revisions: readonly string[],
  fetch: (sha: string) => void = (sha) => {
    git(repoRoot, ['fetch', '--no-tags', '--quiet', 'origin', sha])
  }
): string[] {
  return revisions.map((revision) => {
    try {
      return resolveCommit(repoRoot, revision)
    } catch {
      fetch(revision)
      return resolveCommit(repoRoot, revision)
    }
  })
}

/** Every path that differs between two commits, both sides of a rename included. */
export function changedPaths(repoRoot: string, base: string, head: string): string[] {
  return git(repoRoot, ['diff', '--name-only', '--no-renames', '-z', base, head]).split('\0').filter(Boolean).sort()
}

// ── Task prerequisites: lint and typecheck ─────────────────────────────────

/** Workspace member folders the tree's root manifest names, each holding a manifest. */
export function workspaceDirs(tree: TreeReader): { dir: string; name: string; manifest: Record<string, unknown> }[] {
  const root = JSON.parse(tree.read('package.json') ?? '{}') as { workspaces?: string[] | { packages?: string[] } }
  const globs = Array.isArray(root.workspaces) ? root.workspaces : (root.workspaces?.packages ?? [])
  const matchers = globs.map(
    (glob) =>
      new RegExp(
        `^${glob
          .split('*')
          .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
          .join('[^/]+')}/package\\.json$`
      )
  )
  return tree
    .list()
    .filter((path) => matchers.some((m) => m.test(path)))
    .map((path) => {
      const manifest = JSON.parse(tree.read(path) ?? '{}') as Record<string, unknown>
      return { dir: posix.dirname(path), name: String(manifest.name ?? posix.dirname(path)), manifest }
    })
    .sort((a, b) => compare(a.dir, b.dir))
}

/** The relative module specifiers of every source file in the tree, by file — one `git grep` over the commit. */
function relativeImports(repoRoot: string, revision: string): Map<string, string[]> {
  let out = ''
  try {
    out = git(repoRoot, [
      'grep',
      '-I',
      '-E',
      '-e',
      `(from|import|require)[[:space:]]*\\(?[[:space:]]*['"]\\.\\.?/`,
      revision,
      '--',
      '*.ts',
      '*.tsx',
      '*.mts',
      '*.cts',
      '*.js',
      '*.jsx',
      '*.mjs',
      '*.cjs'
    ])
  } catch (err) {
    // `git grep` exits 1 when nothing matches; anything else is a real failure.
    if ((err as { status?: number }).status !== 1) throw err
  }
  const imports = new Map<string, string[]>()
  const prefix = `${revision}:`
  for (const line of out.split('\n')) {
    if (!line.startsWith(prefix)) continue
    const rest = line.slice(prefix.length)
    const colon = rest.indexOf(':')
    const file = rest.slice(0, colon)
    for (const m of rest.slice(colon + 1).matchAll(/(?:from|import|require)\s*\(?\s*(['"])(\.\.?\/[^'"]+)\1/g))
      imports.set(file, [...(imports.get(file) ?? []), m[2] as string])
  }
  return imports
}

function resolveRelative(from: string, specifier: string, exists: (path: string) => boolean): string | null {
  const target = posix.normalize(posix.join(posix.dirname(from), specifier))
  const stem = target.replace(/\.(m|c)?js$/, '')
  const tries = [
    target,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}.mts`,
    `${stem}/index.ts`,
    `${target}.ts`,
    `${target}/index.ts`
  ]
  return tries.find(exists) ?? null
}

/**
 * Which packages to typecheck: each package whose type program can see a
 * changed file — inside it, inside a workspace package it depends on by its
 * manifest, or reached through a relative import that crosses its folder,
 * followed transitively. `turbo` then adds each one's own `^typecheck`
 * prerequisites. A root manifest, lockfile, task graph or compiler
 * configuration change typechecks everything; a change no package's program
 * can see typechecks nothing.
 */
export function typecheckScope(repoRoot: string, tree: TreeReader, changed: readonly string[]): StepScope {
  const typed = changed.filter((path) => TYPED.test(path) || /(^|\/)tsconfig(\..+)?\.json$/.test(path))
  const root = typed.filter((path) => !path.includes('/') && TYPE_ROOT_INPUT.test(path))
  if (root.length > 0)
    return { scope: 'all', items: [], reason: `a root input every typecheck reads changed: ${root.join(', ')}` }
  if (typed.length === 0) return { scope: 'skip', items: [], reason: 'no changed file is one a type checker reads' }

  const members = workspaceDirs(tree)
  const byName = new Map(members.map((m) => [m.name, m.dir]))
  const nodeOf = (path: string): string => {
    let best: string | null = null
    for (const m of members) if (path.startsWith(`${m.dir}/`) && (!best || m.dir.length > best.length)) best = m.dir
    return best ?? path
  }
  const listed = new Set(tree.list())
  const changedSet = new Set(changed)
  const exists = (path: string) => listed.has(path) || changedSet.has(path)
  const edges = new Map<string, Set<string>>()
  const link = (from: string, to: string) => {
    if (from !== to) edges.set(from, new Set([...(edges.get(from) ?? []), to]))
  }
  for (const [file, specifiers] of relativeImports(repoRoot, tree.revision))
    for (const specifier of specifiers) {
      const target = resolveRelative(file, specifier, exists)
      if (target) link(nodeOf(file), nodeOf(target))
    }
  for (const m of members)
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = (m.manifest[field] ?? {}) as Record<string, string>
      for (const name of Object.keys(deps)) {
        const dir = byName.get(name)
        if (dir) link(m.dir, dir)
      }
    }
  const touched = new Set(typed.map(nodeOf))
  const affected = members.filter((m) => {
    const seen = new Set<string>()
    const queue = [m.dir]
    while (queue.length > 0) {
      const node = queue.shift() as string
      if (seen.has(node)) continue
      seen.add(node)
      if (touched.has(node)) return true
      queue.push(...(edges.get(node) ?? []))
    }
    return false
  })
  const withScript = affected.filter(
    (m) => typeof (m.manifest.scripts as Record<string, unknown> | undefined)?.typecheck === 'string'
  )
  if (withScript.length === 0)
    return { scope: 'skip', items: [], reason: 'no package with a typecheck task can see a changed file' }
  return {
    scope: 'some',
    items: withScript.map((m) => m.name).sort(),
    reason: `${withScript.length} package(s) whose type program can see a changed file, through a manifest dependency or a relative import`
  }
}

/** Which files to lint: the changed files Biome checks; everything when its configuration or installation changed. */
export function lintScope(tree: TreeReader, changed: readonly string[]): StepScope {
  const root = changed.filter((path) => LINT_ROOT_INPUTS.includes(path))
  if (root.length > 0)
    return { scope: 'all', items: [], reason: `a root input every lint reads changed: ${root.join(', ')}` }
  const listed = new Set(tree.list())
  const files = changed.filter(
    (path) => LINTED.test(path) && !/(^|\/)tsconfig[^/]*\.json$/.test(path) && listed.has(path)
  )
  if (files.length === 0) return { scope: 'skip', items: [], reason: 'no changed file is one Biome checks' }
  return {
    scope: 'some',
    items: files,
    reason: `${files.length} changed file(s) Biome checks; its rules read one file at a time`
  }
}

// ── The schedule check ─────────────────────────────────────────────────────

/** The shard lists as the tested tree holds them. */
function shardListsAt(tree: TreeReader, view: InventoryView): string[][] {
  const suite = view.suites.find((s) => s.owner === CI_SHARD_LIST_OWNER)
  return Array.from({ length: CI_SHARD_COUNT }, (_, i) =>
    (suite ? (tree.read(posix.join(suite.cwd, shardFileRelPath(i + 1))) ?? '') : '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  )
}

/** Places the decision's tests with the real scheduler and checks the result whole. */
export function scheduleCheck(
  tree: TreeReader,
  view: InventoryView,
  decision: CiDecision
): { counts: Record<string, number>; problems: NativeProblem[]; scheduled: string[] } {
  const input = ciScheduleInput(view, decision)
  const schedule = buildTestSchedule({ view, shardLists: shardListsAt(tree, view), ...input })
  const expected = [
    ...input.selected,
    ...input.wholeSuites.flatMap((w) =>
      w.identities.map((t) => ({ ...t, configuration: w.configuration ?? DEFAULT_CONFIGURATION }))
    )
  ]
  const counts: Record<string, number> = {}
  for (const entry of schedule.accounting) counts[entry.placement] = (counts[entry.placement] ?? 0) + 1
  return {
    counts,
    problems: checkSchedule(schedule, expected),
    scheduled: [...new Set(schedule.accounting.map((e) => e.test))].sort()
  }
}

// ── The plan ───────────────────────────────────────────────────────────────

/** The always-run list as CI keeps it: an obligation whose reason is that its inputs are not modeled. */
function legacyObligations(repoRoot: string, head: string, view: InventoryView): SelectionObligation[] {
  return alwaysRunObligations(repoRoot, head, view).map((obligation) => ({
    ...obligation,
    reason: `unmodeled input: ${obligation.reason}; CI keeps this list until its tests' real inputs are declared in the inventory and a paired local and CI regression proves the narrower answer`
  }))
}

/** The CI consumer's selection, with the always-run list added as its own stated obligation. */
export function ciSelection(
  repoRoot: string,
  base: string,
  head: string
): { plan: SelectionPlan; view: InventoryView } {
  const input = repositorySelectionInput(repoRoot, { base, head, consumer: 'ci' })
  const policy = {
    ...input.policy,
    obligations: [...(input.policy.obligations ?? []), ...legacyObligations(repoRoot, input.head, input.inventory.head)]
  }
  return { plan: selectTests({ ...input, policy }), view: input.inventory.head }
}

function plannedRuns(selection: SelectionPlan): PlannedRun[] {
  const runs = new Map<string, PlannedRun>()
  const add = (test: string, suite: string, why: string) => {
    const run = runs.get(test) ?? { test, suite, why: [] }
    if (!run.why.includes(why)) run.why.push(why)
    runs.set(test, run)
  }
  for (const t of selection.required) for (const r of t.reasons) add(t.test, t.suite, `${r.kind}: ${r.detail}`)
  for (const f of selection.fallbacks)
    for (const test of f.tests) add(test, '', `conservative-fallback ${f.id}: ${f.reason}`)
  for (const o of selection.obligations) add(o.test, o.suite, `obligation ${o.obligation}: ${o.reason}`)
  return [...runs.values()].sort((a, b) => compare(a.test, b.test))
}

/** The jobs a plan decides: each with whether the aggregate requires it and why. */
export function planJobs(input: {
  event: CiEvent
  full: boolean
  changed: readonly string[]
  tests: readonly string[]
}): Record<CiJob, JobDecision> {
  const configChanged = input.event === 'pull_request' && input.changed.includes(ROOT_CONFIG)
  const sandbox = input.full || input.tests.includes(SANDBOX_SUITE_TEST)
  const each = input.full
    ? 'every scheduled test of its place runs'
    : 'the selected tests its place holds run; a place with none selected passes having run none'
  return {
    build: {
      required: true,
      reason: 'every run: the plan, lint, typecheck, the CLI doctor runs, doctor, the ratchet and the inventory gate'
    },
    'test-cli': { required: true, reason: each },
    'test-shared-packages': { required: true, reason: each },
    'test-cli-config-anchor': {
      required: configChanged,
      reason: configChanged
        ? `the pull request changes ${ROOT_CONFIG}: the committed-config probe proves it and the CLI suite runs under it`
        : input.event === 'push'
          ? 'a push has no candidate configuration apart from its base; the full run covers the merged one'
          : `the pull request does not change ${ROOT_CONFIG}`
    },
    'sandbox-conformance': {
      required: sandbox,
      reason: input.full
        ? 'everything runs'
        : sandbox
          ? 'the change reaches the sandbox suite, through its imports or the paths its SUITE_INPUTS provider names'
          : 'the change reaches neither the sandbox suite nor any path its SUITE_INPUTS provider names'
    },
    'sandbox-conformance-macos': {
      required: false,
      reason: ADVISORY_JOBS['sandbox-conformance-macos'] as string
    },
    aggregate: { required: true, reason: 'the one required check: it judges this plan and every job it requires' }
  }
}

/** Each suite whose tests the plan does not all run, with why. */
function unselectedSuites(
  view: InventoryView,
  planned: ReadonlySet<string>,
  decision: CiDecision
): CiPlan['unselected'] {
  if (decision.scope === 'all') return []
  return view.suites.flatMap((suite) => {
    const own = view.tests.filter((t) => t.suite === suite.id)
    const left = own.filter((t) => !planned.has(t.id)).length
    if (left === 0) return []
    return [
      {
        suite: suite.id,
        tests: left,
        reason:
          left === own.length
            ? 'no changed path reaches a test of this suite through an import, a declared input, a scan, a spawned program or a policy'
            : 'no changed path reaches these tests through an import, a declared input, a scan, a spawned program or a policy'
      }
    ]
  })
}

function suiteRunners(view: InventoryView): string {
  return stableHash(
    view.suites.map((s) => ({
      id: s.id,
      runner: s.runner,
      cwd: s.cwd,
      preload: s.preload,
      environment: s.environment,
      configFiles: s.configFiles
    }))
  )
}

/** The narrowed part of a plan: the selection, its tests and what it decides. */
function narrowed(repoRoot: string, event: CiEvent, base: string, tested: string) {
  const { plan: selection, view } = ciSelection(repoRoot, base, tested)
  const tests = plannedRuns(selection)
  const byId = new Map(view.tests.map((t) => [t.id, t]))
  const unknown = tests.filter((t) => !byId.has(t.test)).map((t) => t.test)
  const changed = [...new Set(selection.changes.flatMap((c) => (c.from ? [c.path, c.from] : [c.path])))].sort()
  const decision: CiDecision = {
    scope: 'selected',
    selected: tests.filter((t) => byId.get(t.test)?.runner !== 'vitest').map((t) => t.test),
    native: tests.filter((t) => byId.get(t.test)?.runner === 'vitest').map((t) => t.test),
    changed
  }
  return {
    selection,
    view,
    tests,
    unknown,
    changed,
    decision,
    jobs: planJobs({ event, full: false, changed, tests: tests.map((t) => t.test) })
  }
}

function shadowOf(repoRoot: string, base: string, tested: string): ShadowPlan {
  try {
    const [b, t] = prepareRevisions(repoRoot, [base, tested], () => {
      throw new Error(`${base} is not in the checkout`)
    }) as [string, string]
    const n = narrowed(repoRoot, 'pull_request', b, t)
    return {
      state: 'available',
      base: b,
      identity: n.selection.identity,
      jobs: (Object.entries(n.jobs) as [CiJob, JobDecision][]).filter(([, j]) => j.required).map(([job]) => job),
      tests: n.tests.map((r) => r.test)
    }
  } catch (err) {
    return { state: 'inconclusive', reason: `no shadow plan: ${(err as Error).message.split('\n')[0]}` }
  }
}

/** One CI plan. Never throws for a readable repository: what cannot be planned runs everything, with its reason. */
export function buildCiPlan(input: CiPlanInput): CiPlan {
  const started = performance.now()
  const { repoRoot, event } = input
  const guard: GuardInput = input.guard ?? { verdict: 'full', reason: 'no base guard verdict was given', guarded: [] }
  let base = input.base
  let approvedHead = input.approvedHead
  let testedTree = input.testedTree
  let fullReason: string | null = null
  try {
    ;[base, approvedHead, testedTree] = prepareRevisions(
      repoRoot,
      [input.base, input.approvedHead, input.testedTree],
      input.fetch
    ) as [string, string, string]
  } catch (err) {
    fullReason = `the comparison revisions could not be resolved: ${(err as Error).message.split('\n')[0]}`
  }
  if (!fullReason && event === 'push') fullReason = 'a push to the default branch runs every job and every test'
  if (!fullReason && guard.verdict !== 'plan') fullReason = `the base guard: ${guard.reason}`

  const tree = revisionReader(repoRoot, testedTree)
  const problems: string[] = []
  let narrow: ReturnType<typeof narrowed> | null = null
  if (!fullReason) {
    try {
      narrow = narrowed(repoRoot, event, base, testedTree)
      if (narrow.unknown.length > 0) {
        fullReason = `the selection names ${narrow.unknown[0]}, which the inventory does not hold`
        narrow = null
      }
    } catch (err) {
      fullReason = `the selection failed: ${(err as Error).message.split('\n')[0]}`
    }
  }

  let view: InventoryView
  try {
    view = narrow?.view ?? readTestInventory(repoRoot, { head: testedTree }).head
  } catch (err) {
    view = { suites: [], tests: [], contextIdentity: '', graphIdentity: '' } as unknown as InventoryView
    problems.push(`the tested tree's inventory cannot be read: ${(err as Error).message.split('\n')[0]}`)
  }
  let changed: string[] = narrow?.changed ?? []
  if (!narrow)
    try {
      changed = changedPaths(repoRoot, base, testedTree)
    } catch {
      changed = []
    }

  const decision: CiDecision = narrow ? narrow.decision : { scope: 'all', reason: fullReason as string }
  const jobs = narrow ? narrow.jobs : planJobs({ event, full: true, changed, tests: [] })
  const steps = narrow
    ? { lint: lintScope(tree, changed), typecheck: typecheckScope(repoRoot, tree, changed) }
    : {
        lint: { scope: 'all' as const, items: [], reason: `everything runs: ${fullReason}` },
        typecheck: { scope: 'all' as const, items: [], reason: `everything runs: ${fullReason}` }
      }
  const checked =
    problems.length > 0 ? { counts: {}, problems: [], scheduled: [] } : scheduleCheck(tree, view, decision)
  const schedule = { counts: checked.counts, problems: checked.problems }
  for (const p of schedule.problems) problems.push(`schedule ${p.code} ${p.path}: ${p.detail}`)
  const tests = narrow?.tests ?? []
  const obligations = GOVERNANCE_OBLIGATIONS.filter((o) => o.when === 'every-run' || event === 'push').map((o) => ({
    id: o.id,
    kind: o.kind,
    job: o.job,
    ...(o.step ? { step: o.step } : {}),
    duty: o.duty
  }))

  const body: Omit<CiPlan, 'identity' | 'shadow' | 'profile'> = {
    schema: 'vinaya.ci-plan',
    schemaVersion: 1,
    event,
    base,
    approvedHead,
    testedTree,
    guard,
    scope: narrow ? 'selected' : 'full',
    reason: fullReason,
    inventory: {
      head: { contextIdentity: view.contextIdentity, graphIdentity: view.graphIdentity },
      base: narrow?.selection.context.inventory.base
        ? { contextIdentity: narrow.selection.context.inventory.base.contextIdentity }
        : null
    },
    runners: suiteRunners(view),
    selection: narrow
      ? {
          identity: narrow.selection.identity,
          required: narrow.selection.required.length,
          fallbacks: narrow.selection.fallbacks.map((f) => ({ id: f.id, reason: f.reason, tests: f.tests.length })),
          policies: narrow.selection.policies.map((p) => ({ id: p.id, kind: p.kind, duty: p.duty }))
        }
      : null,
    changed,
    tests,
    unselected: unselectedSuites(view, new Set(checked.scheduled), decision),
    decision,
    jobs,
    steps,
    obligations,
    schedule,
    problems,
    valid: problems.length === 0
  }
  return {
    ...body,
    identity: stableHash(body),
    shadow: event === 'push' && input.shadow ? shadowOf(repoRoot, input.base, input.testedTree) : null,
    profile: { totalMs: Math.round(performance.now() - started) }
  }
}

/** The jobs a plan requires, in workflow order. */
export function requiredJobs(plan: Pick<CiPlan, 'jobs'>): CiJob[] {
  return (Object.entries(plan.jobs) as [CiJob, JobDecision][]).filter(([, j]) => j.required).map(([job]) => job)
}

/** The step outputs the workflow reads, one `key<<delimiter` block each. */
export function githubOutputs(plan: CiPlan): string {
  const values: Record<string, string> = {
    plan_identity: plan.identity,
    plan_valid: String(plan.valid),
    plan_scope: plan.scope,
    plan_base: plan.base,
    plan_head: plan.approvedHead,
    plan_tested: plan.testedTree,
    guard_verdict: plan.guard.verdict,
    lint_scope: plan.steps.lint.scope,
    typecheck_scope: plan.steps.typecheck.scope,
    config_changed: String(plan.jobs['test-cli-config-anchor'].required),
    sandbox: String(plan.jobs['sandbox-conformance'].required),
    sandbox_reason: plan.jobs['sandbox-conformance'].reason,
    required_jobs: requiredJobs(plan).join(' '),
    decision: JSON.stringify(plan.decision),
    shadow_state: plan.shadow?.state ?? 'none',
    shadow_jobs: plan.shadow?.state === 'available' ? plan.shadow.jobs.join(' ') : ''
  }
  return Object.entries(values)
    .map(([key, value]) => `${key}<<VINAYA_CI_PLAN_EOF\n${value}\nVINAYA_CI_PLAN_EOF\n`)
    .join('')
}

/** The plan as a step summary. */
export function planSummary(plan: CiPlan): string {
  const lines = [
    `### CI plan ${plan.identity.slice(0, 12)} — ${plan.scope === 'full' ? `everything: ${plan.reason}` : 'selected'}`,
    `base \`${plan.base.slice(0, 12)}\`, approved head \`${plan.approvedHead.slice(0, 12)}\`, tested tree \`${plan.testedTree.slice(0, 12)}\`; base guard: ${plan.guard.verdict} (${plan.guard.reason})`,
    '',
    '| job | runs | why |',
    '| --- | --- | --- |',
    ...(Object.entries(plan.jobs) as [CiJob, JobDecision][]).map(
      ([job, j]) =>
        `| ${job} | ${job === 'sandbox-conformance-macos' ? 'advisory' : j.required ? 'required' : 'skipped'} | ${j.reason} |`
    ),
    `| lint | ${plan.steps.lint.scope} | ${plan.steps.lint.reason} |`,
    `| typecheck | ${plan.steps.typecheck.scope}${plan.steps.typecheck.items.length ? ` (${plan.steps.typecheck.items.join(', ')})` : ''} | ${plan.steps.typecheck.reason} |`,
    ''
  ]
  if (plan.scope === 'selected') {
    lines.push(
      `${plan.tests.length} test(s) planned for ${plan.changed.length} changed path(s); placed: ${
        Object.entries(plan.schedule.counts)
          .map(([p, n]) => `${p} ${n}`)
          .join(', ') || 'none'
      }.`
    )
    for (const f of plan.selection?.fallbacks ?? []) lines.push(`- fallback ${f.id}: ${f.tests} test(s) — ${f.reason}`)
    for (const u of plan.unselected) lines.push(`- not run: ${u.suite}, ${u.tests} test(s) — ${u.reason}`)
  }
  if (plan.shadow)
    lines.push(
      plan.shadow.state === 'available'
        ? `Shadow pull-request plan: ${plan.shadow.jobs.join(', ')}; ${plan.shadow.tests.length} test(s).`
        : `Shadow pull-request plan: ${plan.shadow.reason}.`
    )
  for (const p of plan.problems) lines.push(`- **invalid**: ${p}`)
  return `${lines.join('\n')}\n`
}

/** Reads a guard verdict file; an absent, unreadable or malformed one is no verdict. */
export function readGuard(path: string | undefined): GuardInput | null {
  if (!path) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<GuardInput>
    if ((parsed.verdict === 'plan' || parsed.verdict === 'full') && typeof parsed.reason === 'string')
      return {
        verdict: parsed.verdict,
        reason: parsed.reason,
        guarded: Array.isArray(parsed.guarded) ? parsed.guarded : []
      }
  } catch {}
  return null
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

function main(argv: readonly string[]): number {
  const event = argValue(argv, '--event') as CiEvent | undefined
  const base = argValue(argv, '--base')
  const head = argValue(argv, '--head')
  const tested = argValue(argv, '--tested') ?? 'HEAD'
  if ((event !== 'pull_request' && event !== 'push') || !base || !head) {
    process.stderr.write(
      'usage: impact-plan.ts --event pull_request|push --base <sha> --head <sha> [--tested <sha>] [--guard <file>] [--shadow] [--out-dir <dir>] [--github-output <file>] [--summary <file>]\n'
    )
    return 2
  }
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim()
  const guardPath = argValue(argv, '--guard')
  const guard = readGuard(guardPath) ?? {
    verdict: 'full' as const,
    reason: guardPath
      ? `the base guard verdict ${guardPath} is absent or unreadable`
      : 'no base guard verdict was given',
    guarded: []
  }
  const plan = buildCiPlan({
    repoRoot,
    event,
    base,
    approvedHead: head,
    testedTree: tested,
    guard,
    shadow: argv.includes('--shadow')
  })
  const outDir = argValue(argv, '--out-dir')
  if (outDir) {
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`)
    writeFileSync(join(outDir, 'lint-files.txt'), plan.steps.lint.items.map((f) => `${f}\n`).join(''))
    writeFileSync(join(outDir, 'typecheck-packages.txt'), plan.steps.typecheck.items.map((p) => `${p}\n`).join(''))
  } else process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  const outputs = argValue(argv, '--github-output')
  if (outputs) writeFileSync(outputs, githubOutputs(plan), { flag: 'a' })
  const summary = argValue(argv, '--summary')
  if (summary) writeFileSync(summary, planSummary(plan), { flag: 'a' })
  process.stderr.write(
    `vinaya ci-plan: ${plan.identity.slice(0, 12)} ${plan.scope}${plan.reason ? ` — ${plan.reason}` : ''}; jobs ${requiredJobs(plan).join(', ')}; ${plan.tests.length} test(s) [${plan.profile.totalMs} ms]\n`
  )
  for (const p of plan.problems) process.stderr.write(`vinaya ci-plan: invalid — ${p}\n`)
  return plan.valid ? 0 : 1
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
