#!/usr/bin/env bun
/**
 * The CI plan's offline replay: real plans for committed fixture changes,
 * judged against expectations written by hand, and real plans for recent
 * merged changes from local history.
 *
 * Case mode reads a fixture bundle (`apps/cli/tests/fixtures/ci-impact/replay.json`).
 * Each case is a change applied to a pinned base commit, committed into the
 * object store as a commit no branch names (the checkout and its index are
 * never touched), and planned exactly as CI plans it — the base guard
 * included unless the case says otherwise. Its expectations — which jobs,
 * which packages typechecked, which files linted, which tests run, which
 * duties stay — are a table written by hand in the bundle, never produced by
 * the planner, the guard, the selection or the schedule. Every case also
 * names omission mutants: the plan with one required duty taken out. The
 * replay fails when a plan misses an expectation, or when a mutant is not
 * caught.
 *
 * History mode plans the last N first-parent changes of a local branch, each
 * against its parent, and prints each plan's jobs, tests and reasons. Given
 * observations of what failed on a default-branch run (`--observations
 * <file>`, keyed by tested tree), a failure outside the plan for the same
 * tree is flagged for investigation; a tree with no observation is
 * inconclusive. A correlation is a lead, never proof the selection missed
 * anything.
 *
 *   bun scripts/ci/replay.ts --cases apps/cli/tests/fixtures/ci-impact/replay.json
 *   bun scripts/ci/replay.ts --history 20 [--ref HEAD] [--observations <file>]
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { guardRepository } from './base-guard.ts'
import { buildCiPlan, type CiPlan, type GuardInput } from './impact-plan.ts'

/** One file change of a case: new content, an appended line, one text replaced, a deletion, or a move. */
export type FileChange =
  | { content: string }
  | { append: string }
  | { replace: [string, string] }
  | { delete: true }
  | { renameTo: string }

/** Hand-written expectations: what the plan for the case must contain. */
export type CaseExpectation = {
  scope?: 'selected' | 'full'
  /** Jobs that must be required (`true`) or must not be (`false`). */
  jobs?: Record<string, boolean>
  /** Packages that must be typechecked, or `skip` when none may be. */
  typecheck?: string[] | 'skip'
  /** Files that must be linted, or `skip` when none may be. */
  lint?: string[] | 'skip'
  /** Tests that must run. */
  tests?: string[]
  /** Duties — governance or obligation ids — the plan must keep. */
  obligations?: string[]
}

export type ReplayCase = {
  id: string
  category: string
  /** Why this case exists, in words. */
  about: string
  changes: Record<string, FileChange>
  /** `run`: the base guard decides, as in CI. `plan`: the guard is bypassed, to judge the narrowed plan itself. */
  guard?: 'run' | 'plan'
  expect: CaseExpectation
  /** Duties to remove, one mutant each: `job:<id>`, `typecheck:<package>`, `lint:<file>`, `test:<id>`, `obligation:<id>`. */
  mutants: string[]
}

export type ReplayBundle = { schema: 'vinaya.ci-replay'; schemaVersion: 1; base: string; cases: ReplayCase[] }

function git(repoRoot: string, args: string[], env?: Record<string, string>, input?: string): string {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
    ...(input !== undefined ? { input } : {})
  }).trim()
}

/**
 * A commit holding `base` plus `changes`, written into the object store
 * through a temporary index: no branch, no checkout and no working-tree file
 * is touched. The same base and changes always give the same tree; the
 * commit's identity also carries a fixed author and date, so it repeats too.
 */
export function syntheticCommit(repoRoot: string, base: string, changes: Readonly<Record<string, FileChange>>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-replay-index-'))
  const env = {
    GIT_INDEX_FILE: join(dir, 'index'),
    GIT_AUTHOR_NAME: 'replay',
    GIT_AUTHOR_EMAIL: 'replay@vinaya.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'replay',
    GIT_COMMITTER_EMAIL: 'replay@vinaya.invalid',
    GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z'
  }
  try {
    git(repoRoot, ['read-tree', base], env)
    const put = (path: string, text: string) => {
      const blob = git(repoRoot, ['hash-object', '-w', '--stdin'], env, text)
      git(repoRoot, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`], env)
    }
    const read = (path: string) => git(repoRoot, ['show', `${base}:${path}`])
    for (const [path, change] of Object.entries(changes)) {
      if ('content' in change) put(path, change.content)
      else if ('append' in change) put(path, `${read(path)}\n${change.append}`)
      else if ('replace' in change) {
        const [from, to] = change.replace
        const text = read(path)
        if (!text.includes(from)) throw new Error(`${path} at ${base} holds no ${from}`)
        put(path, `${text.replace(from, to)}\n`)
      } else if ('delete' in change) git(repoRoot, ['update-index', '--force-remove', path], env)
      else {
        put(change.renameTo, `${read(path)}\n`)
        git(repoRoot, ['update-index', '--force-remove', path], env)
      }
    }
    const tree = git(repoRoot, ['write-tree'], env)
    return git(repoRoot, ['commit-tree', tree, '-p', base, '-m', 'replay'], env)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** What a plan runs, as the oracle reads it: required jobs, typechecked packages, linted files, tests. */
function planFacts(plan: CiPlan) {
  const full = plan.scope === 'full'
  return {
    full,
    jobs: new Set(
      Object.entries(plan.jobs)
        .filter(([, j]) => j.required)
        .map(([job]) => job)
    ),
    typecheck: plan.steps.typecheck,
    lint: plan.steps.lint,
    tests: new Set(plan.tests.map((t) => t.test)),
    obligations: new Set([
      ...plan.obligations.map((o) => o.id),
      ...plan.tests.flatMap((t) =>
        t.why.filter((w) => w.startsWith('obligation ')).map((w) => (w.split(' ')[1] as string).replace(/:$/, ''))
      )
    ])
  }
}

/**
 * Every way `plan` falls short of `expect`, in words; empty when it meets
 * every expectation. A full plan runs every test, lints and typechecks
 * everything.
 */
export function judgePlan(plan: CiPlan, expect: CaseExpectation): string[] {
  const facts = planFacts(plan)
  const misses: string[] = []
  if (!plan.valid) misses.push(`the plan is invalid: ${plan.problems.join('; ')}`)
  if (expect.scope && plan.scope !== expect.scope) misses.push(`scope ${plan.scope}, expected ${expect.scope}`)
  for (const [job, wanted] of Object.entries(expect.jobs ?? {})) {
    if (wanted && !facts.jobs.has(job)) misses.push(`job ${job} is not required`)
    if (!wanted && facts.jobs.has(job)) misses.push(`job ${job} is required, but nothing the change touches needs it`)
  }
  if (expect.typecheck === 'skip') {
    if (facts.typecheck.scope !== 'skip') misses.push(`typecheck runs (${facts.typecheck.scope}), expected none`)
  } else
    for (const pkg of expect.typecheck ?? [])
      if (facts.typecheck.scope !== 'all' && !facts.typecheck.items.includes(pkg))
        misses.push(`typecheck misses ${pkg}`)
  if (expect.lint === 'skip') {
    if (facts.lint.scope !== 'skip') misses.push(`lint runs (${facts.lint.scope}), expected none`)
  } else
    for (const file of expect.lint ?? [])
      if (facts.lint.scope !== 'all' && !facts.lint.items.includes(file)) misses.push(`lint misses ${file}`)
  if (!facts.full)
    for (const test of expect.tests ?? []) if (!facts.tests.has(test)) misses.push(`test ${test} does not run`)
  for (const id of expect.obligations ?? []) if (!facts.obligations.has(id)) misses.push(`duty ${id} is dropped`)
  return misses
}

/** The plan with one required duty removed — an omission the oracle must catch. */
export function mutatePlan(plan: CiPlan, mutant: string): CiPlan {
  const [kind, ...rest] = mutant.split(':')
  const target = rest.join(':')
  const copy = structuredClone(plan) as CiPlan
  if (kind === 'job') {
    const job = copy.jobs[target as keyof CiPlan['jobs']]
    if (!job) throw new Error(`mutant ${mutant}: no such job`)
    job.required = false
  } else if (kind === 'typecheck') {
    copy.steps.typecheck = {
      scope: 'some',
      items: copy.steps.typecheck.items.filter((p) => p !== target),
      reason: 'mutant'
    }
  } else if (kind === 'lint') {
    copy.steps.lint = { scope: 'some', items: copy.steps.lint.items.filter((f) => f !== target), reason: 'mutant' }
  } else if (kind === 'test') {
    copy.scope = 'selected'
    copy.tests = copy.tests.filter((t) => t.test !== target)
  } else if (kind === 'obligation') {
    copy.obligations = copy.obligations.filter((o) => o.id !== target)
    copy.tests = copy.tests.map((t) => ({ ...t, why: t.why.filter((w) => !w.startsWith(`obligation ${target}:`)) }))
  } else throw new Error(`mutant ${mutant}: unknown kind ${kind}`)
  return copy
}

/** The plan CI would make for one case. */
export function planCase(repoRoot: string, base: string, replayCase: ReplayCase): CiPlan {
  const head = syntheticCommit(repoRoot, base, replayCase.changes)
  const guard: GuardInput =
    replayCase.guard === 'plan'
      ? { verdict: 'plan', reason: 'bypassed by the case, to judge the narrowed plan itself', guarded: [] }
      : guardRepository(repoRoot, base, head)
  return buildCiPlan({ repoRoot, event: 'pull_request', base, approvedHead: head, testedTree: head, guard })
}

export type CaseResult = { id: string; misses: string[]; uncaught: string[]; plan: CiPlan }

/** One case: the plan's misses against the case, and each mutant the judgment failed to catch. */
export function replayCase(repoRoot: string, base: string, replay: ReplayCase): CaseResult {
  const plan = planCase(repoRoot, base, replay)
  const misses = judgePlan(plan, replay.expect)
  const uncaught = replay.mutants.filter((mutant) => judgePlan(mutatePlan(plan, mutant), replay.expect).length === 0)
  return { id: replay.id, misses, uncaught, plan }
}

export function readBundle(path: string): ReplayBundle {
  const bundle = JSON.parse(readFileSync(path, 'utf8')) as ReplayBundle
  if (bundle.schema !== 'vinaya.ci-replay' || !Array.isArray(bundle.cases))
    throw new Error(`${path} is not a replay bundle`)
  return bundle
}

/** Observations of a default-branch run, by tested tree: the jobs and tests that failed there. */
export type Observations = Record<string, { failedJobs?: string[]; failedTests?: string[] }>

export type HistoryEntry = {
  commit: string
  parent: string
  plan: CiPlan
  verdict: 'no-failure-observed' | 'failures-inside-plan' | 'investigate' | 'inconclusive'
  outside: string[]
}

/** Plans for the last `count` first-parent changes of `ref`, each judged against its observation when one exists. */
export function replayHistory(
  repoRoot: string,
  ref: string,
  count: number,
  observations: Observations = {}
): HistoryEntry[] {
  const commits = git(repoRoot, ['rev-list', '--first-parent', `--max-count=${count}`, ref])
    .split('\n')
    .filter(Boolean)
  return commits.map((commit) => {
    const parent = git(repoRoot, ['rev-parse', `${commit}^1`])
    const guard = guardRepository(repoRoot, parent, commit)
    const plan = buildCiPlan({
      repoRoot,
      event: 'pull_request',
      base: parent,
      approvedHead: commit,
      testedTree: commit,
      guard
    })
    const tree = git(repoRoot, ['rev-parse', `${commit}^{tree}`])
    const seen = observations[commit] ?? observations[tree]
    if (!seen) return { commit, parent, plan, verdict: 'inconclusive' as const, outside: [] }
    const jobs = new Set(
      Object.entries(plan.jobs)
        .filter(([, j]) => j.required)
        .map(([job]) => job)
    )
    const tests = new Set(plan.tests.map((t) => t.test))
    const outside =
      plan.scope === 'full'
        ? []
        : [
            ...(seen.failedJobs ?? []).filter((job) => !jobs.has(job)).map((job) => `job ${job}`),
            ...(seen.failedTests ?? []).filter((test) => !tests.has(test)).map((test) => `test ${test}`)
          ]
    const failed = (seen.failedJobs?.length ?? 0) + (seen.failedTests?.length ?? 0)
    const verdict = outside.length > 0 ? 'investigate' : failed > 0 ? 'failures-inside-plan' : 'no-failure-observed'
    return { commit, parent, plan, verdict, outside }
  })
}

function argValue(argv: readonly string[], flag: string): string | undefined {
  const at = argv.indexOf(flag)
  return at >= 0 ? argv[at + 1] : undefined
}

function main(argv: readonly string[]): number {
  const repoRoot = git(process.cwd(), ['rev-parse', '--show-toplevel'])
  const casesPath = argValue(argv, '--cases')
  const history = argValue(argv, '--history')
  if (casesPath) {
    const bundle = readBundle(casesPath)
    let failed = 0
    for (const c of bundle.cases) {
      const result = replayCase(repoRoot, bundle.base, c)
      const ok = result.misses.length === 0 && result.uncaught.length === 0
      if (!ok) failed++
      process.stdout.write(
        `${ok ? 'ok  ' : 'FAIL'} ${c.id} [${c.category}] ${result.plan.scope}${result.plan.reason ? ` (${result.plan.reason})` : ''}; ` +
          `${result.plan.tests.length} test(s); typecheck ${result.plan.steps.typecheck.scope}; ${c.mutants.length} mutant(s) caught ${c.mutants.length - result.uncaught.length}\n`
      )
      for (const miss of result.misses) process.stdout.write(`       miss: ${miss}\n`)
      for (const mutant of result.uncaught) process.stdout.write(`       mutant not caught: ${mutant}\n`)
    }
    process.stdout.write(
      `${bundle.cases.length - failed} of ${bundle.cases.length} case(s) met their expectations and caught every mutant\n`
    )
    return failed === 0 ? 0 : 1
  }
  if (history) {
    const count = Number(history)
    if (!Number.isInteger(count) || count < 1) {
      process.stderr.write('replay.ts --history needs a positive count\n')
      return 2
    }
    const observationsPath = argValue(argv, '--observations')
    const observations = observationsPath ? (JSON.parse(readFileSync(observationsPath, 'utf8')) as Observations) : {}
    const entries = replayHistory(repoRoot, argValue(argv, '--ref') ?? 'HEAD', count, observations)
    for (const e of entries) {
      const p = e.plan
      const jobs = Object.entries(p.jobs)
        .filter(([, j]) => j.required)
        .map(([job]) => job)
      // Why the tests run, by reason kind — the first word of each reason.
      const reasons: Record<string, number> = {}
      for (const t of p.tests)
        for (const kind of new Set(t.why.map((w) => w.split(/[: ]/)[0] as string)))
          reasons[kind] = (reasons[kind] ?? 0) + 1
      process.stdout.write(
        `${e.commit.slice(0, 12)} ${p.scope}${p.reason ? ` — ${p.reason}` : ''}\n` +
          `  ${p.changed.length} changed path(s); ${p.tests.length} test(s); jobs ${jobs.join(', ')}; lint ${p.steps.lint.scope}; typecheck ${p.steps.typecheck.scope}${p.steps.typecheck.items.length ? ` (${p.steps.typecheck.items.join(', ')})` : ''}\n` +
          (p.tests.length > 0
            ? `  reasons: ${Object.entries(reasons)
                .map(([k, n]) => `${k} ${n}`)
                .join(', ')}\n`
            : '') +
          (p.selection?.fallbacks ?? []).map((f) => `  fallback ${f.id}: ${f.reason}\n`).join('') +
          p.problems.map((problem) => `  not a valid CI plan for that tree: ${problem}\n`).join('') +
          `  observation: ${e.verdict}${e.outside.length ? ` — outside the plan: ${e.outside.join(', ')}` : ''}\n`
      )
    }
    const counts: Record<string, number> = {}
    for (const e of entries) counts[e.verdict] = (counts[e.verdict] ?? 0) + 1
    const narrowed = entries.filter((e) => e.plan.scope === 'selected').length
    process.stdout.write(
      `${entries.length} change(s) planned, ${narrowed} narrowed, ${entries.length - narrowed} everything: ${Object.entries(
        counts
      )
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')}\n`
    )
    // A diagnostic: a tree older than the planner's inputs is reported, never a failure of the replay.
    return 0
  }
  process.stderr.write(
    'usage: replay.ts (--cases <bundle.json> | --history <n> [--ref <rev>] [--observations <file>])\n'
  )
  return 2
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2))
