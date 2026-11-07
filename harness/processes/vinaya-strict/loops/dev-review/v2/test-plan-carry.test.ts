import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { carriedPass, carryKey, passCarries, repositorySelectionBetween, testPlanTargets } from './test-plan-carry'

const REPO_ROOT = join(import.meta.dir, '../../../../../..')
const P = 'harness/processes/vinaya-strict'

describe('which Test Plan commands can carry a pass', () => {
  it('a bun test over named files, after one cd, gives its files repository-relative', () => {
    expect(
      testPlanTargets(
        `cd ${P} && bun test --isolate --timeout=120000 loops/dev-review/v2/test-plan-carry.test.ts tools/actions.test.ts`,
        REPO_ROOT
      )
    ).toEqual([`${P}/loops/dev-review/v2/test-plan-carry.test.ts`, `${P}/tools/actions.test.ts`])
    expect(testPlanTargets(`bun test ./${P}/tools`, REPO_ROOT)).toEqual([`${P}/tools`])
  })

  it('any other shape runs again', () => {
    for (const command of [
      `cd ${P} && bun test`,
      `cd ${P} && bun test missing.test.ts`,
      `cd ${P} && bun test tools/actions.test.ts | tail -1`,
      `cd ${P} && cd .. && bun test x.test.ts`,
      'bun run test',
      'bunx turbo run test --affected',
      'bun scripts/ci/replay.ts',
      'bun test ../outside.test.ts'
    ])
      expect([command, testPlanTargets(command, REPO_ROOT)]).toEqual([command, null])
  })
})

describe('whether a pass still stands', () => {
  const targets = [`${P}/tools/actions.test.ts`, `${P}/checks`]
  it('stands when the change selects none of its tests and falls back nowhere', () => {
    expect(passCarries(targets, { tests: ['apps/cli/tests/other.test.ts'], fallbacks: [] })).toBe(true)
  })
  it('falls when the change selects one of its files, a test under one of its folders, or any fallback', () => {
    expect(passCarries(targets, { tests: [`${P}/tools/actions.test.ts`], fallbacks: [] })).toBe(false)
    expect(passCarries(targets, { tests: [`${P}/checks/a.test.ts`], fallbacks: [] })).toBe(false)
    expect(passCarries(targets, { tests: [], fallbacks: ['unattributed'] })).toBe(false)
    expect(passCarries(targets, null)).toBe(false)
  })
})

describe('carrying a recorded pass to a later head', () => {
  const command = `cd ${P} && bun test tools/actions.test.ts`
  const record = { head: 'aaaa', output: 'ok' }
  const base = { command, repoRoot: REPO_ROOT, head: 'bbbb', record, ancestor: () => true }
  it('carries when nothing since the recorded head reaches its tests', () => {
    expect(carriedPass({ ...base, select: () => ({ tests: [], fallbacks: [] }) })?.output).toBe('ok')
  })
  it('runs again when the change reaches its tests, the head is not a descendant, or it is the same head', () => {
    expect(
      carriedPass({ ...base, select: () => ({ tests: [`${P}/tools/actions.test.ts`], fallbacks: [] }) })
    ).toBeNull()
    expect(carriedPass({ ...base, ancestor: () => false, select: () => ({ tests: [], fallbacks: [] }) })).toBeNull()
    expect(carriedPass({ ...base, head: 'aaaa', select: () => ({ tests: [], fallbacks: [] }) })).toBeNull()
    expect(carriedPass({ ...base, record: undefined, select: () => ({ tests: [], fallbacks: [] }) })).toBeNull()
  })
  it('keys a command per worktree', () => {
    expect(carryKey(command, '/a')).not.toBe(carryKey(command, '/b'))
  })
})

it("reads the repository's own selection from its command line", () => {
  const selection = repositorySelectionBetween(REPO_ROOT, 'HEAD', 'HEAD')
  expect(selection).toEqual({ tests: expect.any(Array), fallbacks: expect.any(Array) })
}, 120_000)
