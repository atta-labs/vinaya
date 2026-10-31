/**
 * Native test groups: an explicit set of test identities, grouped by how
 * their own runner must be started, and the check that a runner executed
 * exactly the files its group scheduled.
 *
 * Neither function selects, places or launches anything. The caller states
 * which tests it requires — a selection's answer, a policy's additions, a
 * whole suite it cannot narrow — and which configuration each runs under; the
 * caller parses each runner's own report into {@link ExecutionFacts}. No
 * identity is dropped here for where it is owned or where it will run: a
 * repository-owned test keeps its group like any other.
 */
import { posix } from 'node:path'
import type { NativeRunner, SuiteFacts, TestIdentity } from './types.js'

/** The configuration a test runs under when the caller names none: its suite's own. */
export const DEFAULT_CONFIGURATION = 'default'

/** One test the caller requires, under one named configuration. */
export type NativeTestRequest = TestIdentity & {
  /**
   * A required configuration beyond the suite's own, by name —
   * {@link DEFAULT_CONFIGURATION} when absent. The same file under two
   * configurations is two obligations, each run once.
   */
  configuration?: string
}

/**
 * A suite the caller cannot narrow to files: every identity it lists is
 * expected, and its runner is started with no file filter.
 */
export type WholeSuiteRequest = {
  suite: string
  configuration?: string
  /** Why this suite runs whole — reported with the group. */
  reason: string
  /** Every test of the suite, as the inventory knows them. */
  identities: readonly TestIdentity[]
}

/** One runner start: one suite under one configuration, and the files it must execute. */
export type NativeGroup = {
  /** `<suite>@<configuration>` — what an execution report names. */
  id: string
  suite: string
  owner: string
  kind: SuiteFacts['kind']
  runner: NativeRunner
  cwd: string
  preload: string | null
  environment: SuiteFacts['environment']
  configuration: string
  /** `files`: the runner is given exactly {@link args}; `suite`: it runs its own collection. */
  scope: 'files' | 'suite'
  /** Why a `suite`-scope group runs whole, otherwise `null`. */
  reason: string | null
  /** Repository-relative identities the runner must execute, sorted. */
  tests: string[]
  /** The runner's file arguments, relative to {@link cwd}; empty for a `suite`-scope group. */
  args: string[]
  /**
   * Files of the same suite the runner must be told to leave out, relative to
   * {@link cwd}: Vitest matches a file argument as a substring of a path, so a
   * sibling whose path contains an argument would run too.
   */
  exclude: string[]
}

export type NativeProblem = {
  code:
    | 'duplicate'
    | 'configuration-mismatch'
    | 'outside-root'
    | 'outside-cwd'
    | 'missing'
    | 'extra'
    | 'interrupted'
    | 'unreadable'
  /** The test, or the group a group-level problem is about. */
  path: string
  group?: string
  detail: string
}

export type NativeGrouping = { groups: NativeGroup[]; problems: NativeProblem[] }

export type GroupNativeTestsInput = {
  tests: readonly NativeTestRequest[]
  wholeSuites?: readonly WholeSuiteRequest[]
  /**
   * Every test the caller's inventory knows. Used only to find an unselected
   * sibling a Vitest file argument would also match; without it no
   * exclusion is computed and only the execution check catches one.
   */
  universe?: readonly TestIdentity[]
}

/**
 * A repository-relative, `/`-separated path: platform separators normalized,
 * `.` segments dropped, `..` resolved — or `null` when it leaves the
 * repository or is absolute.
 */
function repositoryPath(path: string): string | null {
  const slashed = path.replace(/\\/g, '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) return null
  const normal = posix.normalize(slashed)
  if (normal === '..' || normal.startsWith('../')) return null
  return normal === '.' ? '' : normal.replace(/\/$/, '')
}

function relativeToCwd(cwd: string, id: string): string | null {
  if (cwd === '' || cwd === '.') return id
  return id.startsWith(`${cwd}/`) ? id.slice(cwd.length + 1) : null
}

/** The facts that decide how a runner starts, compared between members of one group. */
function startFacts(t: TestIdentity): string {
  return JSON.stringify([
    t.suite,
    t.owner,
    t.kind,
    t.runner,
    t.cwd,
    t.preload,
    Object.entries(t.environment).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  ])
}

/**
 * Groups an explicit set of tests by suite and configuration — the unit one
 * runner start serves. Every request is kept, repository-owned ones included;
 * an exact repeat of a test under the same configuration, a member whose
 * runner facts differ from its group's, or a path outside the repository or
 * its suite's working directory is a problem, never silently merged. A
 * whole-suite request expands to every identity it lists before grouping.
 * A group with no test is never produced, so no runner starts for nothing.
 */
export function groupNativeTests(input: GroupNativeTestsInput): NativeGrouping {
  const problems: NativeProblem[] = []
  type Building = { first: TestIdentity; configuration: string; tests: Set<string>; whole: string | null }
  const building = new Map<string, Building>()
  const seen = new Set<string>()

  const add = (request: NativeTestRequest, origin: 'request' | 'whole', reason?: string) => {
    const configuration = request.configuration ?? DEFAULT_CONFIGURATION
    const id = repositoryPath(request.id)
    const cwd = repositoryPath(request.cwd)
    if (id === null || id === '' || cwd === null) {
      problems.push({ code: 'outside-root', path: request.id, detail: 'the path leaves the repository' })
      return
    }
    if (relativeToCwd(cwd, id) === null) {
      problems.push({
        code: 'outside-cwd',
        path: id,
        detail: `the test is not under its suite's working directory ${cwd}`
      })
      return
    }
    const key = `${id}\0${configuration}`
    // A repeat is a problem wherever it came from: a request, a whole suite, or one overlapping the other.
    if (seen.has(key)) {
      problems.push({
        code: 'duplicate',
        path: id,
        detail: `${origin === 'whole' ? 'a whole suite repeats a test' : 'requested twice'} under configuration ${configuration}`
      })
      return
    }
    const groupId = `${request.suite}@${configuration}`
    const identity: TestIdentity = { ...request, id, cwd: cwd || '.' }
    const group = building.get(groupId)
    if (!group) {
      seen.add(key)
      building.set(groupId, { first: identity, configuration, tests: new Set([id]), whole: reason ?? null })
      return
    }
    if (startFacts(group.first) !== startFacts(identity)) {
      problems.push({
        code: 'configuration-mismatch',
        path: id,
        group: groupId,
        detail: 'its runner, working directory, preload or environment differs from its group'
      })
      return
    }
    seen.add(key)
    group.tests.add(id)
    if (reason && group.whole === null) group.whole = reason
  }

  for (const request of input.tests) add(request, 'request')
  for (const whole of input.wholeSuites ?? []) {
    const configuration = whole.configuration ?? DEFAULT_CONFIGURATION
    for (const identity of whole.identities) {
      if (identity.suite !== whole.suite) {
        problems.push({
          code: 'configuration-mismatch',
          path: identity.id,
          group: `${whole.suite}@${configuration}`,
          detail: `listed for suite ${whole.suite} but owned by ${identity.suite}`
        })
        continue
      }
      add({ ...identity, configuration }, 'whole', whole.reason)
    }
  }

  const universe = new Map<string, string[]>()
  for (const identity of input.universe ?? []) {
    const id = repositoryPath(identity.id)
    if (id === null) continue
    const list = universe.get(identity.suite) ?? []
    list.push(id)
    universe.set(identity.suite, list)
  }

  const groups: NativeGroup[] = []
  for (const [id, group] of [...building.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const f = group.first
    const tests = [...group.tests].sort()
    const scope = group.whole === null ? 'files' : 'suite'
    const relative = tests.map((t) => relativeToCwd(f.cwd, t) as string)
    const args = scope === 'suite' ? [] : f.runner === 'bun' ? relative.map((r) => `./${r}`) : relative
    const exclude =
      scope === 'files' && f.runner === 'vitest'
        ? (universe.get(f.suite) ?? [])
            .filter((other) => !group.tests.has(other))
            .map((other) => relativeToCwd(f.cwd, other))
            .filter((other): other is string => other !== null && relative.some((arg) => other.includes(arg)))
            .sort()
        : []
    groups.push({
      id,
      suite: f.suite,
      owner: f.owner,
      kind: f.kind,
      runner: f.runner,
      cwd: f.cwd,
      preload: f.preload,
      environment: f.environment,
      configuration: group.configuration,
      scope,
      reason: group.whole,
      tests,
      args,
      exclude
    })
  }
  return { groups, problems }
}

/** What one runner start reported, as the caller parsed it from the runner's own report. */
export type ExecutionFacts = {
  /** The {@link NativeGroup.id} this start served. */
  group: string
  /** `completed` when the runner exited and its report was read, whatever the tests' result. */
  outcome: 'completed' | 'interrupted' | 'signaled' | 'unreadable'
  /** Why it was not `completed`. */
  detail?: string
  /**
   * One entry per file the report says executed, as the runner wrote it:
   * absolute, or relative to the group's working directory.
   */
  files: readonly string[]
}

export type ExecutedValidation = {
  /** `<test>@<configuration>` for every scheduled test the reports confirm, sorted. */
  executed: string[]
  problems: NativeProblem[]
}

/**
 * Whether the runners executed exactly what the groups scheduled: one
 * readable, uninterrupted report per group, naming each of its tests once and
 * nothing else. A report for a group that was not scheduled, a group with no
 * report or two, a missing, extra or repeated file, and an absolute path
 * outside every one of `roots` — the repository root and the platform aliases
 * of it the caller resolved — all fail. A test passing or failing is the
 * runner's exit status, not this.
 */
export function validateExecutedIdentities(
  groups: readonly NativeGroup[],
  executions: readonly ExecutionFacts[],
  options: { roots: readonly string[] }
): ExecutedValidation {
  const problems: NativeProblem[] = []
  const executed: string[] = []
  const roots = options.roots.map((root) => `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`)
  const byGroup = new Map<string, ExecutionFacts[]>()
  const known = new Set(groups.map((g) => g.id))
  for (const execution of executions) {
    if (!known.has(execution.group)) {
      problems.push({
        code: 'configuration-mismatch',
        path: execution.group,
        group: execution.group,
        detail: 'a report names a group that was not scheduled'
      })
      continue
    }
    byGroup.set(execution.group, [...(byGroup.get(execution.group) ?? []), execution])
  }

  for (const group of groups) {
    const reports = byGroup.get(group.id) ?? []
    if (reports.length !== 1) {
      problems.push({
        code: reports.length === 0 ? 'missing' : 'duplicate',
        path: group.id,
        group: group.id,
        detail: reports.length === 0 ? 'no execution report' : `${reports.length} execution reports`
      })
      continue
    }
    const report = reports[0] as ExecutionFacts
    if (report.outcome !== 'completed') {
      problems.push({
        code: report.outcome === 'unreadable' ? 'unreadable' : 'interrupted',
        path: group.id,
        group: group.id,
        detail: `the runner ${report.outcome === 'unreadable' ? 'left no readable report' : `was ${report.outcome}`}${report.detail ? `: ${report.detail}` : ''}`
      })
      continue
    }
    const counts = new Map<string, number>()
    for (const written of report.files) {
      const slashed = written.replace(/\\/g, '/')
      let id: string | null
      if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) {
        const root = roots.find((r) => slashed.startsWith(r))
        id = root ? repositoryPath(slashed.slice(root.length)) : null
      } else {
        id = repositoryPath(group.cwd === '.' ? slashed : `${group.cwd}/${slashed}`)
      }
      if (id === null || id === '') {
        problems.push({
          code: 'outside-root',
          path: written,
          group: group.id,
          detail: 'reported outside the repository'
        })
        continue
      }
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    const expected = new Set(group.tests)
    for (const [id, count] of [...counts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (!expected.has(id))
        problems.push({ code: 'extra', path: id, group: group.id, detail: 'executed but not scheduled in this group' })
      else if (count > 1)
        problems.push({ code: 'duplicate', path: id, group: group.id, detail: `executed ${count} times` })
    }
    for (const id of group.tests) {
      if (!counts.has(id))
        problems.push({ code: 'missing', path: id, group: group.id, detail: 'scheduled but not reported executed' })
      else if (counts.get(id) === 1) executed.push(`${id}@${group.configuration}`)
    }
  }
  return { executed: executed.sort(), problems }
}
