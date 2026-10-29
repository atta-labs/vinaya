import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { colourEnabled } from '../../src/lib/dispatch'
import {
  createFollowView,
  type FollowViewOptions,
  formatStageLine,
  lineSplitter,
  newestStage,
  readStageHistory,
  type StageHistory,
  stageHistoryOf
} from '../../src/lib/follow-view'

const FIXTURES = join(import.meta.dir, '..', 'fixtures', 'follow-view')
const fixture = (name: string): string[] => readFileSync(join(FIXTURES, name), 'utf8').replace(/\n$/, '').split('\n')

const ROOTS = [
  '/Users/dev/repo/.worktrees/task/issue-1801',
  '/Users/dev/repo/.worktrees/task/issue-1803',
  '/Users/dev/repo'
]
const HISTORY: StageHistory = {
  review: { medianMinutes: 12, samples: 4 },
  develop: { medianMinutes: 30.4, samples: 3 },
  // Two samples are too few: typical unavailable.
  local_checks: { medianMinutes: 2, samples: 2 }
}
const NOW = new Date('2026-10-29T10:00:00Z')

const view = (overrides: Partial<FollowViewOptions> = {}) =>
  createFollowView({ colour: false, details: true, roots: ROOTS, timeZone: 'UTC', history: HISTORY, ...overrides })

// The one fixed colour per role, the loop's grey, and dimmed notes beneath their actor.
const RESET = '\x1b[0m'
const paint = (code: string) => (text: string) => `${code}${text}${RESET}`
const loop = paint('\x1b[90m')
const developer = paint('\x1b[36m')
const notes = paint('\x1b[2m\x1b[36m')
const codeReview = paint('\x1b[35m')
const security = paint('\x1b[31m')
const principal = paint('\x1b[33m')
const ESCAPE_CODE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

type Expected = [paint: (text: string) => string, text: string]

const CLAUDE_VIEW: Expected[] = [
  [loop, '07:35:07  ▸ Loop   vinaya task run: Issue #1801 — model opus (explicit --model)'],
  [loop, '07:35:07  ▸ Loop   loopId 0b1c2d3e-0000-4000-8000-000000000001'],
  [loop, '07:35:07  ▸ Loop   engine runner: task 1801, flow v2'],
  [loop, '07:35:07  ◆ Engine Runner   run started'],
  [loop, '07:35:07  ▸ Loop   no checkpoint; starting fresh on branch task/issue-1801'],
  [loop, '07:35:08  ◆ Loop   ━━ Round 1 · develop · typical 30m ━━'],
  [developer, '07:36:14  ▸ Developer   Working'],
  [notes, '          · session started'],
  // The test run's start and its finish, paired by call id: one line, its command left out, its failure beneath.
  [
    developer,
    '07:36:29  ✕ Developer   Failed running tests bun test apps/cli/tests/lib/follow-view.test.ts after 10.9s, 2 tests failed'
  ],
  [notes, '          · error: expect(received).toEqual(expected)'],
  // Two overlapping reads of one file: each finish is its own call's, whatever the order they ended in.
  [developer, '07:36:30  ✓ Developer   Finished reading apps/cli/src/lib/follow-view.ts in 900ms'],
  [developer, '07:36:30  ✓ Developer   Finished reading apps/cli/src/lib/follow-view.ts in 100ms'],
  [developer, '07:36:41  ▸ Developer   Writing'],
  [notes, '          · Two tests fail in apps/cli/tests/lib/follow-view.test.ts; fixing the pairing.'],
  [developer, '07:37:02  ✓ Developer   Finished editing apps/cli/src/lib/follow-view.ts in 50ms'],
  [developer, '07:40:10  ✓ Developer   Finished reporting completed in 20ms'],
  [loop, '07:40:11  ◆ Loop   ━━ Round 1 · local checks · typical unavailable ━━'],
  [loop, '07:40:11  ◆ Loop   Round 1 started.'],
  [loop, '07:41:30  ✓ Loop   Round 1: the checks passed.'],
  [loop, '07:41:31  ◆ Loop   ━━ Round 1 · review · typical 12m ━━'],
  [codeReview, '07:41:40  ✓ Code review   Finished reading apps/cli/src/lib/follow-view.ts in 1.5s'],
  [security, '07:41:41  ✓ Security   Finished searching execFileSync in 1.0s'],
  [loop, '07:48:25  ▸ Loop   Round 1 verdicts: The code reviewer approved; the security reviewer approved.'],
  [loop, '07:48:25  ▸ Loop   Round 1 ended after 13m 18s: approved. Confidence: 82.'],
  [loop, '07:48:26  ◆ Loop   ━━ Round 1 · ready push · typical unavailable ━━'],
  [loop, '07:48:30  ◆ Loop   ━━ Round 1 · focused checks at ready · typical unavailable ━━'],
  [
    loop,
    '07:48:30  ▸ Loop   ready push: explicit command reused its receipt: bun test apps/cli/tests/lib/follow-view.test.ts'
  ],
  [loop, '07:52:00  ◆ Loop   ━━ Round 1 · pull request opened · typical unavailable ━━'],
  [loop, '07:52:05  ◆ Loop   ━━ Round 1 · waiting on required CI · typical unavailable ━━'],
  [
    loop,
    '07:58:05  ◆ Loop   ━━ Round 1 · paused for the Principal · escalation · the Principal must act · typical unavailable ━━'
  ],
  // The driver's terminal copy of this line, beneath it in the file, is left out.
  [
    loop,
    "07:58:05  ◌ Loop   The loop stopped itself: an item needs a person to decide. A person has to act. The Operator's task_resume for task 1801 continues this run, bound to the pause at round 1, once the person has decided or repaired it."
  ],
  [loop, '07:58:05  ▸ Loop   the run is halted; watching for a newer ruling or a cancel'],
  [loop, '08:10:00  ▸ Loop   a newer ruling resumed escalation 1801-1-0f0e0d0c0b0a09080706050403020100aabbccdd'],
  [principal, '08:10:00  ✓ Principal   A ruling resumed the paused run.'],
  [loop, '08:10:01  ◆ Loop   ━━ Round 1 · waiting on required CI · typical unavailable ━━'],
  [loop, '08:14:01  ◆ Loop   ━━ Round 1 · waiting for merge · typical unavailable ━━'],
  [loop, '08:14:01  ▸ Loop   watching PR #1802 after its publication, until it is merged or closed'],
  [loop, '08:30:00  ▸ Loop   PR #1802 was merged; ending'],
  [loop, '08:30:00  ▸ Loop   driver exited (completed, publish); driver lock cleared'],
  [loop, '08:30:00  ▸ Loop   trace /Users/dev/.vinaya/runtime/dev-repo/engine-runs/1801/trace.json']
]

const CODEX_VIEW: Expected[] = [
  [loop, '09:00:00  ▸ Loop   vinaya task run: Issue #1803 — model gpt-5.5 (explicit --model)'],
  [loop, '09:00:00  ▸ Loop   engine runner: task 1803, flow v2'],
  [loop, '09:00:00  ◆ Engine Runner   run started'],
  [loop, '09:00:01  ◆ Loop   ━━ Round 1 · develop · typical 30m ━━'],
  [developer, '09:00:10  ▸ Developer   Writing'],
  [notes, '          · Reading the follow command before the edit.'],
  [developer, '09:00:11  ✓ Developer   Finished reading sed -n 1,80p in 400ms'],
  [developer, '09:00:20  ✓ Developer   Finished editing apps/cli/src/commands/task-status.ts in 0ms'],
  // A restart mid-action: this start has no finish, and the later run's action with the same id is not its finish.
  [developer, '09:00:30  ▸ Developer   Running tests bun test apps/cli/tests/lib/task-status.test.ts'],
  [loop, '09:02:00  ▸ Loop   received SIGTERM; stopping the run and ending its agents'],
  [loop, '09:02:00  ▸ Loop   driver exited (signal, cancel); driver lock cleared'],
  [loop, '09:03:00  ▸ Loop   engine runner: task 1803, flow v2'],
  [loop, '09:03:00  ◆ Engine Runner   Resumed'],
  [loop, '09:03:00  ▸ Loop   resuming the run from its checkpoint (engine-task-1803)'],
  [loop, '09:03:01  ◆ Loop   ━━ Round 1 · develop · typical 30m ━━'],
  [
    developer,
    '09:03:10  ✓ Developer   Finished running tests bun test apps/cli/tests/lib/task-status.test.ts in 30.0s, no test failed'
  ],
  [developer, '09:03:50  ✕ Developer   Failed publishing changes after 9.0s'],
  [notes, '          · the pre-push hook refused the push'],
  [
    loop,
    '09:04:00  ◆ Loop   ━━ Round 1 · paused for the Operator · infrastructure · the Operator must act · typical unavailable ━━'
  ],
  [loop, '09:04:00  ◌ Loop   Paused: infrastructure.'],
  [loop, '09:04:00  ▸ Loop   the run is halted; watching for a newer ruling or a cancel'],
  [loop, '09:20:00  ▸ Loop   the pause was cancelled; ending'],
  [loop, '09:20:00  ▸ Loop   driver exited (paused, cancel); driver lock cleared']
]

describe('a recorded driver log, one per agent (O1, O2, O3, O8)', () => {
  for (const [agent, file, expected] of [
    ['Claude Code', 'engine-claude-driver.log', CLAUDE_VIEW],
    ['Codex', 'engine-codex-driver.log', CODEX_VIEW]
  ] as const) {
    test(`${agent}: renders to the exact view lines with no colour`, () => {
      expect(view().backlog(fixture(file), NOW)).toEqual(expected.map(([, text]) => text))
    })

    test(`${agent}: renders to the exact view lines in each actor's colour`, () => {
      expect(view({ colour: true }).backlog(fixture(file), NOW)).toEqual(expected.map(([colour, text]) => colour(text)))
    })

    test(`${agent}: --quiet leaves every detail out and keeps every primary line`, () => {
      const primaries = expected.map(([, text]) => text).filter((text) => !text.startsWith('          · '))
      expect(view({ details: false }).backlog(fixture(file), NOW)).toEqual(primaries)
    })
  }

  test('the view shows no shell command text, though the file keeps it', () => {
    const raw = fixture('engine-claude-driver.log')
    expect(raw.some((line) => line.includes('2>&1 | tail -5'))).toBe(true)
    expect(
      view()
        .backlog(raw, NOW)
        .some((line) => line.includes('2>&1 | tail -5'))
    ).toBe(false)
  })
})

describe('pairing by call id (O3)', () => {
  const start = (at: string, call: string, subject: string) =>
    `2026-10-29T${at}Z [call=${call}]  > Developer   Reading ${subject}`
  const finish = (at: string, call: string, subject: string, took: string) =>
    `2026-10-29T${at}Z [call=${call}]  + Developer   Finished reading ${subject} in ${took}`

  test('a live action appends its own completed line, naming its start time, and rewrites nothing', () => {
    const v = view()
    expect(v.backlog([start('07:00:00.000', 'toolu_X', 'a.ts')], NOW)).toEqual(['07:00:00  ▸ Developer   Reading a.ts'])
    expect(v.push([finish('07:00:04.000', 'toolu_X', 'a.ts', '4.0s')], NOW)).toEqual([
      '07:00:04  ✓ Developer   Finished reading a.ts in 4.0s (started 07:00:00)'
    ])
  })

  test('two live actions with one subject finish in their own order, each by its own id', () => {
    const v = view()
    expect(
      v.push(
        [
          start('07:00:00.000', 'toolu_X', 'a.ts'),
          start('07:00:01.000', 'toolu_Y', 'a.ts'),
          finish('07:00:02.000', 'toolu_Y', 'a.ts', '1.0s'),
          finish('07:00:05.000', 'toolu_X', 'a.ts', '5.0s')
        ],
        NOW
      )
    ).toEqual([
      '07:00:00  ▸ Developer   Reading a.ts',
      '07:00:01  ▸ Developer   Reading a.ts',
      '07:00:02  ✓ Developer   Finished reading a.ts in 1.0s (started 07:00:01)',
      '07:00:05  ✓ Developer   Finished reading a.ts in 5.0s (started 07:00:00)'
    ])
  })

  test('interleaved actors each pair their own action', () => {
    const lines = [
      '2026-10-29T07:00:00.000Z [call=c1]  > Code review   Reading a.ts',
      '2026-10-29T07:00:00.500Z [call=s1]  > Security   Reading a.ts',
      '2026-10-29T07:00:01.000Z [call=s1]  + Security   Finished reading a.ts in 500ms',
      '2026-10-29T07:00:02.000Z [call=c1]  + Code review   Finished reading a.ts in 2.0s'
    ]
    expect(view().backlog(lines, NOW)).toEqual([
      '07:00:00  ✓ Code review   Finished reading a.ts in 2.0s',
      '07:00:00  ✓ Security   Finished reading a.ts in 500ms'
    ])
  })

  test('an action left open by a restart is never finished by the next run’s action, live or replayed', () => {
    const v = view()
    expect(v.backlog([start('07:00:00.000', 'item_3', 'a.ts')], NOW)).toEqual(['07:00:00  ▸ Developer   Reading a.ts'])
    expect(
      v.push(
        ['2026-10-29T07:01:00.000Z  # Engine Runner   Resumed', finish('07:01:05.000', 'item_3', 'a.ts', '5.0s')],
        NOW
      )
    ).toEqual(['07:01:00  ◆ Engine Runner   Resumed', '07:01:05  ✓ Developer   Finished reading a.ts in 5.0s'])
  })

  test('the piped and the terminal view append the same lines', () => {
    const lines = [start('07:00:00.000', 'toolu_X', 'a.ts'), finish('07:00:04.000', 'toolu_X', 'a.ts', '4.0s')]
    const piped = view().push(lines, NOW)
    const terminal = view({ colour: true })
      .push(lines, NOW)
      .map((line) => line.replace(ESCAPE_CODE, ''))
    expect(terminal).toEqual(piped)
  })
})

describe('lines the renderer does not recognise (O6)', () => {
  test('a loop line keeps its words, with its time and the loop colour', () => {
    const lines = [
      '2026-10-29T07:00:00.000Z  # Loop   Pushing: 3 of 7 checks done',
      '2026-10-29T07:00:01.000Z  ready push: test file 4 of 9 passed'
    ]
    expect(view({ colour: true }).push(lines, NOW)).toEqual([
      loop('07:00:00  ◆ Loop   Pushing: 3 of 7 checks done'),
      loop('07:00:01  ▸ Loop   ready push: test file 4 of 9 passed')
    ])
  })
})

describe('stage banners and the poll tick (O5)', () => {
  const stageAt = (iso: string, stage: Parameters<typeof formatStageLine>[0]) => formatStageLine(stage, new Date(iso))
  const history: StageHistory = { review: { medianMinutes: 4, samples: 3 } }
  const at = (minutes: number, seconds = 0) =>
    new Date(Date.parse('2026-10-29T07:00:00Z') + minutes * 60_000 + seconds * 1000)

  test('an injected clock drives a still-in-stage line every five minutes and one over-typical line', () => {
    const v = view({ history })
    expect(v.push([stageAt('2026-10-29T07:00:00Z', { round: 2, stage: 'review' })], NOW)).toEqual([
      '07:00:00  ◆ Loop   ━━ Round 2 · review · typical 4m ━━'
    ])
    expect(v.tick(at(4, 59))).toEqual([])
    expect(v.tick(at(5))).toEqual(['07:05:00  ◌ Loop   Still in review (round 2) after 5m'])
    expect(v.tick(at(6))).toEqual([])
    expect(v.tick(at(8, 1))).toEqual([
      '07:08:01  ◌ Loop   Still in review (round 2) after 8m ⚠ past twice its typical 4m'
    ])
    expect(v.tick(at(9))).toEqual([])
    expect(v.tick(at(10))).toEqual(['07:10:00  ◌ Loop   Still in review (round 2) after 10m'])
  })

  test('the next stage line ends the last stage: its count starts again', () => {
    const v = view({ history })
    v.push([stageAt('2026-10-29T07:00:00Z', { round: 1, stage: 'review' })], NOW)
    v.push([stageAt('2026-10-29T07:04:00Z', { round: 1, stage: 'ready_push' })], NOW)
    expect(v.tick(at(5))).toEqual([])
    expect(v.tick(at(9))).toEqual(['07:09:00  ◌ Loop   Still in ready push (round 1) after 5m'])
  })

  test('a paused banner names the pause reason and who must act', () => {
    expect(
      view().push([stageAt('2026-10-29T07:00:00Z', { round: 3, stage: 'paused_operator', reason: 'no_push' })], NOW)
    ).toEqual([
      '07:00:00  ◆ Loop   ━━ Round 3 · paused for the Operator · no_push · the Operator must act · typical unavailable ━━'
    ])
  })

  for (const file of ['engine-claude-driver.log', 'engine-codex-driver.log']) {
    test(`replaying ${file} closes its stage at its ending record and appends no still-in-stage line`, () => {
      const v = view()
      v.backlog(fixture(file), NOW)
      expect(v.tick(new Date('2026-10-30T10:00:00Z'))).toEqual([])
    })
  }

  test('a live ending record stops the tick at once', () => {
    const v = view({ history })
    v.push([stageAt('2026-10-29T07:00:00Z', { round: 1, stage: 'review' })], NOW)
    v.push(['2026-10-29T07:01:00.000Z  driver exited (signal, cancel); driver lock cleared'], NOW)
    expect(v.tick(at(30))).toEqual([])
  })
})

describe('the typical stage length from this machine’s merged tasks (O5)', () => {
  const withStages = fixture('history-merged-with-stages.log')
  const withoutStages = fixture('history-merged-without-stages.log')
  let root: string | null = null
  afterEach(() => {
    if (root !== null) rmSync(root, { recursive: true, force: true })
    root = null
  })

  const writeLog = (dir: string, issue: number, lines: string[], mtimeSeconds: number) => {
    const output = join(dir, 'tasks-execution', String(issue), 'output')
    mkdirSync(output, { recursive: true })
    writeFileSync(join(output, 'driver.log'), `${lines.join('\n')}\n`)
    utimesSync(join(output, 'driver.log'), mtimeSeconds, mtimeSeconds)
  }

  test('the median of each stage across the merged logs that carry stage lines, skipping one with none', () => {
    root = mkdtempSync(join(tmpdir(), 'follow-view-history-'))
    writeLog(root, 1700, withStages, 1_000)
    writeLog(root, 1701, withStages, 2_000)
    writeLog(root, 1702, withStages, 3_000)
    // Newest of all, merged, but with no stage lines: skipped.
    writeLog(root, 1600, withoutStages, 9_000)
    // Carries stage lines but never merged: not counted.
    writeLog(root, 1803, fixture('engine-codex-driver.log'), 8_000)
    // The followed task's own log is never its own history.
    writeLog(root, 1801, fixture('engine-claude-driver.log'), 7_000)
    const history = readStageHistory(root, 1801)
    expect(history.local_checks).toEqual({ medianMinutes: 3, samples: 6 })
    expect(history.review).toEqual({ medianMinutes: 8, samples: 6 })
    expect(history.ready_push).toEqual({ medianMinutes: 8, samples: 3 })
    expect(Math.round(history.develop?.medianMinutes ?? -1)).toBe(20)
    expect(view({ history }).push([formatStageLine({ round: 1, stage: 'ready_push' }, NOW)], NOW)).toEqual([
      '10:00:00  ◆ Loop   ━━ Round 1 · ready push · typical 8m ━━'
    ])
  })

  test('fewer than three samples read as typical unavailable', () => {
    root = mkdtempSync(join(tmpdir(), 'follow-view-history-'))
    writeLog(root, 1700, withStages, 1_000)
    writeLog(root, 1701, withStages, 2_000)
    const history = readStageHistory(root, null)
    expect(view({ history }).push([formatStageLine({ round: 1, stage: 'ready_push' }, NOW)], NOW)).toEqual([
      '10:00:00  ◆ Loop   ━━ Round 1 · ready push · typical unavailable ━━'
    ])
  })

  test('at most the twenty newest merged logs with stage lines count', () => {
    const logs = Array.from({ length: 25 }, () => withStages)
    expect(stageHistoryOf(logs).ready_push).toEqual({ medianMinutes: 8, samples: 20 })
  })
})

describe('the status readers’ reading of a recorded log (O7, O8)', () => {
  test('the newest stage line, and whether the run ended after it', () => {
    const claude = fixture('engine-claude-driver.log')
    expect(newestStage(claude)).toEqual({
      round: 1,
      stage: 'waiting_merge',
      at: Date.parse('2026-10-29T08:14:01.000Z'),
      ended: true
    })
    const live = claude.slice(
      0,
      claude.findIndex((line) => line.includes('PR #1802 was merged'))
    )
    expect(newestStage(live)?.ended).toBe(false)
    expect(newestStage(fixture('history-merged-without-stages.log'))).toBeNull()
  })
})

describe('the colour gate the follow command reuses (O1)', () => {
  const saved = process.env.NO_COLOR
  afterEach(() => {
    if (saved === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = saved
  })

  test('colour only on a terminal with NO_COLOR unset; NO_COLOR present with any value turns it off', () => {
    delete process.env.NO_COLOR
    expect(colourEnabled({ isTTY: true })).toBe(true)
    expect(colourEnabled({ isTTY: false })).toBe(false)
    process.env.NO_COLOR = ''
    expect(colourEnabled({ isTTY: true })).toBe(false)
    process.env.NO_COLOR = '1'
    expect(colourEnabled({ isTTY: true })).toBe(false)
  })
})

describe('line splitting', () => {
  test('a partial line waits for its newline and a split multibyte character stays whole', () => {
    const split = lineSplitter()
    const bytes = Buffer.from('a ━━ b\nc', 'utf8')
    expect(split(bytes.subarray(0, 3))).toEqual([])
    expect(split(bytes.subarray(3))).toEqual(['a ━━ b'])
    expect(split(Buffer.from('\n'))).toEqual(['c'])
  })
})
