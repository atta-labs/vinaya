/**
 * The test independence check's comparison, over recorded outcomes, and the nightly workflow that runs it.
 *
 * The comparison is proven on recorded group outcomes, never by running tests: a file that passes alone and fails
 * eight at a time is named with both outcomes and fails the command; a file failing in both passes is listed as
 * failing only; equal outcomes name nothing. The workflow (`.github/workflows/test-independence.yml`) is read from
 * disk and parsed.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import type { NativeGroup } from '@attalabs/test-selection'
import {
  ALONE,
  compareOutcomes,
  exitStatusOf,
  type FileOutcome,
  fileOutcomes,
  INDEPENDENCE_PLACEMENTS,
  reportLines,
  TOGETHER
} from './independence-check.ts'
import { readTestInventory } from './inventory-check.ts'
import { buildTestSchedule, ciScheduleInput, type GroupOutcome, readShardLists } from './schedule.ts'

const REPO_ROOT = join(import.meta.dir, '..', '..')

const outcomes = (entries: Record<string, FileOutcome>) => new Map(Object.entries(entries))

describe('the comparison of the two passes', () => {
  test('a file that passes alone and fails eight at a time is named with both outcomes and fails the command', () => {
    const report = compareOutcomes(
      outcomes({ 'a.test.ts': 'passed', 'b.test.ts': 'passed' }),
      outcomes({ 'a.test.ts': 'failed', 'b.test.ts': 'passed' })
    )
    expect(report.dependent).toEqual([{ file: 'a.test.ts', alone: 'passed', together: 'failed' }])
    expect(report.failing).toEqual([])
    expect(report.passedBoth).toBe(1)
    expect(exitStatusOf(report)).toBe(1)
    const lines = reportLines('shard-1', report).join('\n')
    expect(lines).toContain(`\`a.test.ts\` — ${ALONE} at a time: passed; ${TOGETHER} at a time: failed`)
    expect(lines).not.toContain('`b.test.ts`')
  })

  test('a file that fails alone and passes together, or is not proven in one pass, is named too', () => {
    const report = compareOutcomes(
      outcomes({ 'a.test.ts': 'failed', 'b.test.ts': 'passed' }),
      outcomes({ 'a.test.ts': 'passed', 'b.test.ts': 'not proven' })
    )
    expect(report.dependent).toEqual([
      { file: 'a.test.ts', alone: 'failed', together: 'passed' },
      { file: 'b.test.ts', alone: 'passed', together: 'not proven' }
    ])
    expect(exitStatusOf(report)).toBe(1)
  })

  test('a file failing in both passes is reported as failing only and does not fail the command', () => {
    const report = compareOutcomes(
      outcomes({ 'a.test.ts': 'failed', 'b.test.ts': 'passed', 'c.test.ts': 'not proven' }),
      outcomes({ 'a.test.ts': 'failed', 'b.test.ts': 'passed', 'c.test.ts': 'failed' })
    )
    expect(report.dependent).toEqual([])
    expect(report.failing).toEqual([
      { file: 'a.test.ts', alone: 'failed', together: 'failed' },
      { file: 'c.test.ts', alone: 'not proven', together: 'failed' }
    ])
    expect(exitStatusOf(report)).toBe(0)
    const lines = reportLines('build', report).join('\n')
    expect(lines).toContain('No file changed result between the two passes.')
    expect(lines).toContain('Failing in both passes (2)')
  })

  test('equal passing outcomes name nothing', () => {
    const report = compareOutcomes(
      outcomes({ 'a.test.ts': 'passed', 'b.test.ts': 'passed' }),
      outcomes({ 'b.test.ts': 'passed', 'a.test.ts': 'passed' })
    )
    expect(report).toEqual({ dependent: [], failing: [], passedBoth: 2 })
    expect(exitStatusOf(report)).toBe(0)
  })
})

describe("a pass's file outcomes, read from what each group's runner proved", () => {
  const group = (id: string, test: string, configuration = 'default') =>
    ({ id, tests: [test], configuration }) as unknown as NativeGroup
  const ended = (id: string, fields: Partial<GroupOutcome>): GroupOutcome => ({
    group: id,
    executed: [],
    failed: [],
    unreported: [],
    trusted: true,
    confirmed: [],
    obligations: [],
    ...fields
  })

  test('confirmed is passed, named failing is failed, and anything else is not proven', () => {
    const groups = [
      group('g1', 'a.test.ts'),
      group('g2', 'b.test.ts'),
      group('g3', 'c.test.ts'),
      group('g4', 'd.test.ts'),
      group('g5', 'e.test.ts', 'ci')
    ]
    const read = fileOutcomes(groups, {
      outcomes: [
        ended('g1', { executed: ['a.test.ts'], confirmed: ['a.test.ts'] }),
        ended('g2', { executed: ['b.test.ts'], failed: ['b.test.ts'], obligations: ['b.test.ts'] }),
        ended('g3', { trusted: false, obligations: ['c.test.ts'] }),
        ended('g5', { executed: ['e.test.ts'], confirmed: ['e.test.ts'] })
      ]
    })
    expect(Object.fromEntries(read)).toEqual({
      'a.test.ts': 'passed',
      'b.test.ts': 'failed',
      'c.test.ts': 'not proven',
      'd.test.ts': 'not proven',
      'e.test.ts (ci)': 'passed'
    })
  })
})

describe("every placement's full schedule comes from the scheduler's exports", () => {
  test('the placements are the build job, the shared packages and each CLI shard, and each holds files', () => {
    expect([...INDEPENDENCE_PLACEMENTS]).toEqual([
      'build',
      'shared',
      'shard-1',
      'shard-2',
      'shard-3',
      'shard-4',
      'shard-5',
      'shard-6'
    ])
    const view = readTestInventory(REPO_ROOT).head
    const input = ciScheduleInput(view, { scope: 'all', reason: 'independence check' })
    const schedule = buildTestSchedule({ view, shardLists: readShardLists(REPO_ROOT, view), ...input })
    for (const placement of INDEPENDENCE_PLACEMENTS)
      expect(schedule.placements[placement]?.length ?? 0, placement).toBeGreaterThan(0)
  })
})

describe('the nightly workflow', () => {
  type Step = { name?: string; if?: string; run?: string; env?: Record<string, string> }
  const workflow = parse(readFileSync(join(REPO_ROOT, '.github/workflows/test-independence.yml'), 'utf8')) as {
    on: Record<string, unknown>
    jobs: Record<
      string,
      {
        'timeout-minutes'?: number
        strategy?: { 'fail-fast'?: boolean; matrix?: { placement?: string[] } }
        steps: Step[]
      }
    >
  }

  test('runs every night and by hand, and never on a pull request or a push', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch'])
    const schedule = workflow.on.schedule as { cron: string }[]
    expect(schedule).toHaveLength(1)
    // Minute, hour, then every day of every month, every weekday.
    expect(schedule[0]?.cron).toMatch(/^\d{1,2} \d{1,2} \* \* \*$/)
  })

  test('has one job per placement, in parallel, each running the check and writing the job summary', () => {
    const jobs = Object.values(workflow.jobs)
    expect(jobs).toHaveLength(1)
    const job = jobs[0]
    expect(job?.strategy?.matrix?.placement).toEqual([...INDEPENDENCE_PLACEMENTS])
    expect(job?.strategy?.['fail-fast']).toBe(false)
    expect(job?.['timeout-minutes']).toBe(240)
    const check = job?.steps.find((s) => s.run?.includes('scripts/test-suites/independence-check.ts'))
    expect(check?.run).toContain('--placement ${{ matrix.placement }}')
    expect(check?.run).toContain('--summary "$GITHUB_STEP_SUMMARY"')
    expect(check?.env?.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}')
    expect(check?.if).toBeUndefined()
    expect(job?.steps.some((s) => s.run === 'bun install --frozen-lockfile')).toBe(true)
  })
})
