// Native groups and the execution check, from data alone: no runner starts
// here, and nothing outside the library directory is imported.
import { describe, expect, test } from 'bun:test'
import {
  type ExecutionFacts,
  groupNativeTests,
  type NativeTestRequest,
  type TestIdentity,
  validateExecutedIdentities
} from '../index.js'

const ROOT = '/work/repo'

function identity(id: string, suite: string, over: Partial<TestIdentity> = {}): TestIdentity {
  const cwd = suite === 'root' ? '.' : (id.split('/').slice(0, 2).join('/') as string)
  return {
    id,
    suite,
    owner: suite === 'root' ? 'repository' : `@fx/${suite}`,
    kind: suite === 'root' ? 'repository' : 'workspace',
    runner: suite === 'core' ? 'vitest' : 'bun',
    cwd,
    preload: null,
    environment: {},
    ...over
  }
}

const APP_A = identity('packages/app/tests/a.test.ts', 'app')
const APP_B = identity('packages/app/tests/b.test.ts', 'app')
const CORE_A = identity('packages/core/src/a.test.ts', 'core')
const CORE_OLD_A = identity('packages/core/src/old/a.test.ts', 'core')
const CORE_XA = identity('packages/core/xsrc/a.test.ts', 'core')
const ROOT_CHECK = identity('scripts/check.test.ts', 'root')

const completed = (group: string, files: string[]): ExecutionFacts => ({ group, outcome: 'completed', files })

describe('groupNativeTests', () => {
  test('groups by suite and configuration, with cwd-relative arguments, Bun ones ./-prefixed', () => {
    const { groups, problems } = groupNativeTests({ tests: [APP_B, CORE_A, APP_A] })
    expect(problems).toEqual([])
    expect(groups.map((g) => [g.id, g.cwd, g.args])).toEqual([
      ['app@default', 'packages/app', ['./tests/a.test.ts', './tests/b.test.ts']],
      ['core@default', 'packages/core', ['src/a.test.ts']]
    ])
  })

  test('keeps a repository-owned test in its own group — ownership is never prior execution', () => {
    const { groups } = groupNativeTests({ tests: [ROOT_CHECK, APP_A] })
    expect(groups.find((g) => g.kind === 'repository')).toMatchObject({
      id: 'root@default',
      cwd: '.',
      tests: ['scripts/check.test.ts'],
      args: ['./scripts/check.test.ts']
    })
  })

  test('the same file under two configurations is two groups; a repeat under one is a problem', () => {
    const probe: NativeTestRequest = { ...APP_A, configuration: 'root-config-probe' }
    const { groups, problems } = groupNativeTests({ tests: [APP_A, probe, APP_A] })
    expect(groups.map((g) => `${g.id} ${g.tests.join(',')}`)).toEqual([
      'app@default packages/app/tests/a.test.ts',
      'app@root-config-probe packages/app/tests/a.test.ts'
    ])
    expect(problems.map((p) => `${p.code} ${p.path}`)).toEqual(['duplicate packages/app/tests/a.test.ts'])
  })

  test('refuses a member whose runner facts differ, and a path outside the repository or its cwd', () => {
    const { groups, problems } = groupNativeTests({
      tests: [
        APP_A,
        { ...APP_B, preload: 'other-preload.ts' },
        identity('../elsewhere/a.test.ts', 'app', { cwd: 'packages/app' }),
        identity('packages/other/a.test.ts', 'app', { cwd: 'packages/app' })
      ]
    })
    expect(groups.map((g) => g.tests)).toEqual([['packages/app/tests/a.test.ts']])
    expect(problems.map((p) => p.code).sort()).toEqual(['configuration-mismatch', 'outside-cwd', 'outside-root'])
  })

  test('normalizes platform separators and dot segments inside the repository', () => {
    const { groups, problems } = groupNativeTests({
      tests: [identity('packages\\app\\tests\\.\\a.test.ts', 'app', { cwd: 'packages/app' })]
    })
    expect(problems).toEqual([])
    expect(groups[0]?.tests).toEqual(['packages/app/tests/a.test.ts'])
  })

  test('a whole suite expands to its identities and runs with no file filter', () => {
    const { groups } = groupNativeTests({
      tests: [CORE_A],
      wholeSuites: [{ suite: 'core', reason: 'reads the whole tree', identities: [CORE_A, CORE_OLD_A] }]
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({
      scope: 'suite',
      reason: 'reads the whole tree',
      args: [],
      tests: ['packages/core/src/a.test.ts', 'packages/core/src/old/a.test.ts']
    })
  })

  test('a whole suite repeating a request, or a second whole suite, is a duplicate; a refused member is not seen', () => {
    const whole = { suite: 'core', reason: 'reads the whole tree', identities: [CORE_A, CORE_OLD_A] }
    const { groups, problems } = groupNativeTests({ tests: [CORE_A], wholeSuites: [whole, whole] })
    expect(groups.map((g) => g.tests)).toEqual([['packages/core/src/a.test.ts', 'packages/core/src/old/a.test.ts']])
    expect(problems.map((p) => `${p.code} ${p.path}`)).toEqual([
      'duplicate packages/core/src/a.test.ts',
      'duplicate packages/core/src/a.test.ts',
      'duplicate packages/core/src/old/a.test.ts'
    ])
    const mismatched = { ...APP_B, preload: 'other.ts' }
    const retried = groupNativeTests({ tests: [APP_A, mismatched, APP_B] })
    expect(retried.problems.map((p) => p.code)).toEqual(['configuration-mismatch'])
    expect(retried.groups[0]?.tests).toEqual(['packages/app/tests/a.test.ts', 'packages/app/tests/b.test.ts'])
  })

  test('excludes an unselected Vitest sibling whose path contains a file argument', () => {
    const { groups } = groupNativeTests({ tests: [CORE_A], universe: [CORE_A, CORE_OLD_A, CORE_XA] })
    expect(groups[0]?.args).toEqual(['src/a.test.ts'])
    expect(groups[0]?.exclude).toEqual(['xsrc/a.test.ts'])
  })

  test('an empty set yields no group, so no runner starts', () => {
    expect(groupNativeTests({ tests: [] })).toEqual({ groups: [], problems: [] })
  })
})

describe('validateExecutedIdentities', () => {
  const { groups } = groupNativeTests({ tests: [APP_A, APP_B, CORE_A, ROOT_CHECK] })

  test('accepts exactly the scheduled files, absolute or cwd-relative, under any listed root alias', () => {
    const result = validateExecutedIdentities(
      groups,
      [
        completed('app@default', ['tests/a.test.ts', './tests/b.test.ts']),
        completed('core@default', [`/private${ROOT}/packages/core/src/a.test.ts`]),
        completed('root@default', ['scripts/check.test.ts'])
      ],
      { roots: [ROOT, `/private${ROOT}`] }
    )
    expect(result.problems).toEqual([])
    expect(result.executed).toEqual([
      'packages/app/tests/a.test.ts@default',
      'packages/app/tests/b.test.ts@default',
      'packages/core/src/a.test.ts@default',
      'scripts/check.test.ts@default'
    ])
  })

  test('fails a missing, extra and repeated file, and a path outside every root', () => {
    const result = validateExecutedIdentities(
      groups,
      [
        completed('app@default', ['tests/a.test.ts', 'tests/a.test.ts', 'tests/c.test.ts']),
        completed('core@default', ['/elsewhere/packages/core/src/a.test.ts']),
        completed('root@default', ['../outside.test.ts', 'scripts/check.test.ts'])
      ],
      { roots: [ROOT] }
    )
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual([
      'duplicate packages/app/tests/a.test.ts',
      'extra packages/app/tests/c.test.ts',
      'missing packages/app/tests/b.test.ts',
      'outside-root /elsewhere/packages/core/src/a.test.ts',
      'missing packages/core/src/a.test.ts',
      'outside-root ../outside.test.ts'
    ])
  })

  test('fails a group with no report, two reports, an unscheduled or interrupted run and an unreadable report', () => {
    const appOnly = groups.filter((g) => g.id !== 'root@default')
    const result = validateExecutedIdentities(
      [...appOnly, ...groupNativeTests({ tests: [ROOT_CHECK] }).groups],
      [
        completed('app@default', ['tests/a.test.ts', 'tests/b.test.ts']),
        completed('app@default', ['tests/a.test.ts', 'tests/b.test.ts']),
        { group: 'core@default', outcome: 'signaled', detail: 'SIGTERM', files: [] },
        { group: 'root@default', outcome: 'unreadable', files: [] },
        completed('app@root-config-probe', ['tests/a.test.ts'])
      ],
      { roots: [ROOT] }
    )
    expect(result.problems.map((p) => `${p.code} ${p.path}`)).toEqual([
      'configuration-mismatch app@root-config-probe',
      'duplicate app@default',
      'interrupted core@default',
      'unreadable root@default'
    ])
  })

  test('an empty schedule with no report passes; a report with no schedule does not', () => {
    expect(validateExecutedIdentities([], [], { roots: [ROOT] })).toEqual({ executed: [], problems: [] })
    expect(
      validateExecutedIdentities([], [completed('app@default', ['tests/a.test.ts'])], { roots: [ROOT] }).problems
    ).toHaveLength(1)
  })
})
