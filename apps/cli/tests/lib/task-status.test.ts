/**
 * `task-status.ts`'s pure outbox-reading half — `deriveLoopState`,
 * `lastRoundVerdictLines`, `renderTaskStatusRow`, `resumeCommandFor` — all
 * take an explicit `root`, so these run in-process against a plain temp
 * directory rather than a subprocess with a faked `$HOME` (unlike
 * `dev-review-loop.test.ts`'s own driver-lock tests, which must use a
 * subprocess because `dev-review-loop.ts` reads `outboxRoot()` — a module-
 * level constant frozen at first import — internally).
 *
 * The forge-reading half (`listOpenTaskIssues`, `hasFrozenBrief`,
 * `findPrForRef`) shells out to real `gh` and is exercised instead through
 * the CLI end-to-end, in `apps/cli/tests/commands/task-status.test.ts`.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  deriveLoopState,
  lastRoundVerdictLines,
  readLastConfidence,
  readLoopPhase,
  renderTaskStatusTable,
  resumeCommandFor,
  type TaskStatusRow
} from '../../src/lib/task-status.js'
import { CONFIDENCE_FILE_NAME } from '../../src/lib/dev-review-loop/round-assess.js'
import { appendRoleLine, loopLogPathFor } from '../../src/lib/loop-log.js'

const TASK = 515

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-task-status-'))
  tempDirs.push(dir)
  return dir
}

/**
 * The task's own folder under an injected runtime directory — the same
 * layout `run-paths.ts` builds, written out by hand here so these fixtures
 * assert against literal strings rather than the function under test.
 */
function taskDir(root: string, task: number): string {
  return join(root, 'tasks-execution', String(task))
}

/**
 * Places a fixture file by the same classification production uses: the
 * driver lock at the task folder's root, a held verdict in its round's own
 * folder, and everything else (pause state, the legacy effect records) in
 * `control/`.
 */
function writeRunFile(root: string, task: number, name: string, content: string): void {
  const held = /^round-(\d+)-(reviewer|security)\.md$/.exec(name)
  const dir = held
    ? join(taskDir(root, task), 'rounds', held[1] as string)
    : name === 'driver.pid.json'
      ? taskDir(root, task)
      : join(taskDir(root, task), 'control')
  const file = held ? `${held[2]}.md` : name
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, file), content, 'utf8')
}

function controlDir(root: string, task: number): string {
  return join(taskDir(root, task), 'control')
}

/**
 * The durable `loop_state` record whose `round` bounds the shared
 * `newestPublishedRound` reader's scan — written as raw JSON matching
 * `LoopStateRecordSchema` (the same seed-a-record-without-acquiring-ownership
 * shape `read.test.ts`'s `writeEscalationFixture` uses), never through the
 * epoch-fenced `writeLoopState`. The driver writes this at every transition,
 * `publish` included, so a published run always has one.
 */
function writeLoopStateRound(
  root: string,
  task: number,
  round: number,
  opts: { phase?: string; recordedAt?: string } = {}
): void {
  const dir = controlDir(root, task)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'loop-state.json'),
    JSON.stringify({
      version: 1,
      kind: 'loop_state',
      task,
      round,
      phase: opts.phase ?? 'publish',
      pauseReason: null,
      budgets: { mechanicalRetries: 0, reviewRounds: round, infrastructureRetries: 0 },
      heldResult: null,
      deliveredFindings: null,
      recordedAt: opts.recordedAt ?? '2026-09-15T00:00:00.000Z'
    }),
    'utf8'
  )
}

/** The developer's own confidence statement for a round, at the exact path `confidencePromptLine` names for it — that round's own Developer folder inside the task's folder. */
function writeStatedConfidence(root: string, task: number, round: number, body: string): void {
  const dir = join(taskDir(root, task), 'rounds', String(round), 'developer')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, CONFIDENCE_FILE_NAME), body, 'utf8')
}

/**
 * One verdict effect record at the control store's own
 * `<task>/control/effect/<key>.json` path, at `status` — `verified` is the
 * status a published verdict advances to. Raw JSON matching
 * `EffectRecordSchema`, the layout `readEffect` reads (never the old flat
 * `control/effect-<key>.json` this task retired).
 */
function writeEffectRecord(root: string, task: number, key: string, status: 'started' | 'verified'): void {
  const dir = join(controlDir(root, task), 'effect')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${key}.json`),
    JSON.stringify({
      version: 1,
      kind: 'effect',
      task,
      key,
      operation: 'pr-comment',
      target: 'pr:517',
      inputVersion: 1,
      payloadDigest: 'digest',
      status,
      ...(status === 'verified' ? { url: 'https://example.test/comment' } : {}),
      recordedAt: '2026-09-15T00:00:00.000Z'
    }),
    'utf8'
  )
}

/** Both verdict effects at `verified` for `round`, plus a `loop_state` whose round covers it — exactly what a clean publish leaves behind. */
function writePublishedRound(root: string, task: number, round: number): void {
  writeLoopStateRound(root, task, round)
  writeEffectRecord(root, task, `${round}-reviewer-verdict`, 'verified')
  writeEffectRecord(root, task, `${round}-security-verdict`, 'verified')
}

/** A pid that has definitely already exited — `spawnSync` blocks until the child is gone before returning its pid (`dev-review-loop.test.ts`'s own `deadPid`). */
function deadPid(): number {
  const r = spawnSync('true', [])
  if (typeof r.pid !== 'number') throw new Error('spawnSync did not report a pid')
  return r.pid
}

describe('deriveLoopState', () => {
  it('reports no_driver when the outbox carries nothing for this task', () => {
    const root = tempDir()
    expect(deriveLoopState(root, TASK, { repo: null, loopsRoot: root })).toEqual({ kind: 'no_driver' })
  })

  it('reports running with the driver pid when the lock names a live process', () => {
    const root = tempDir()
    writeRunFile(
      root,
      TASK,
      'driver.pid.json',
      JSON.stringify({ pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' })
    )
    expect(deriveLoopState(root, TASK, { repo: null, loopsRoot: root })).toEqual({
      kind: 'running',
      pid: process.pid,
      startedAt: '2026-09-10T00:00:00.000Z'
    })
  })

  it('treats a dead pid record as absent, never as running', () => {
    const root = tempDir()
    writeRunFile(
      root,
      TASK,
      'driver.pid.json',
      JSON.stringify({ pid: deadPid(), startedAt: '2026-09-10T00:00:00.000Z' })
    )
    expect(deriveLoopState(root, TASK, { repo: null, loopsRoot: root })).toEqual({ kind: 'no_driver' })
  })

  it('reports paused with the reason from the pause record when no driver is running', () => {
    const root = tempDir()
    writeRunFile(
      root,
      TASK,
      'pause-state.json',
      JSON.stringify({
        task: TASK,
        round: 2,
        head: 'abc123',
        branch: 'task/task-run-v1/14',
        prNumber: 517,
        reason: 'escalation',
        pausedAt: '2026-09-10T00:00:00.000Z'
      })
    )
    expect(deriveLoopState(root, TASK, { repo: null, loopsRoot: root })).toEqual({
      kind: 'paused',
      reason: 'escalation',
      detail: undefined,
      round: 2
    })
  })

  it('reports published when the newest round verified both verdict effect records', () => {
    const root = tempDir()
    writePublishedRound(root, TASK, 1)
    expect(deriveLoopState(root, TASK, { repo: null, loopsRoot: root })).toEqual({ kind: 'published', round: 1 })
  })

  it("does not report published when only one of the round's two effects verified", () => {
    const root = tempDir()
    writeLoopStateRound(root, TASK, 1)
    writeEffectRecord(root, TASK, '1-reviewer-verdict', 'verified')
    writeEffectRecord(root, TASK, '1-security-verdict', 'started')
    expect(deriveLoopState(root, TASK, { repo: null, loopsRoot: root })).toEqual({ kind: 'no_driver' })
  })

  it('does not report published from verified effects with no loop_state to bound them', () => {
    // The one case the shared reader returns null despite a verified effect on
    // disk: no `loop_state` record means no run ever persisted state, so
    // nothing is treated as published (the reader never enumerates effects off
    // disk — it scans rounds bounded by loop_state.round).
    const root = tempDir()
    writeEffectRecord(root, TASK, '1-reviewer-verdict', 'verified')
    writeEffectRecord(root, TASK, '1-security-verdict', 'verified')
    expect(deriveLoopState(root, TASK, { repo: null, loopsRoot: root })).toEqual({ kind: 'no_driver' })
  })

  it('prefers published over a pause record superseded by a later publish', () => {
    const root = tempDir()
    // Paused at round 2 — resumed since, and round 3 published cleanly. The
    // pause-state.json file is never cleared on resume (today's outbox
    // shape), so this is the exact staleness `deriveLoopState`'s own doc
    // comment names.
    writeRunFile(
      root,
      TASK,
      'pause-state.json',
      JSON.stringify({
        task: TASK,
        round: 2,
        head: 'abc123',
        branch: 'task/task-run-v1/14',
        prNumber: 517,
        reason: 'escalation',
        pausedAt: '2026-09-10T00:00:00.000Z'
      })
    )
    writePublishedRound(root, TASK, 3)
    expect(deriveLoopState(root, TASK, { repo: null, loopsRoot: root })).toEqual({ kind: 'published', round: 3 })
  })

  it('still reports the pause when it is newer than the latest publish', () => {
    const root = tempDir()
    writePublishedRound(root, TASK, 1)
    writeRunFile(
      root,
      TASK,
      'pause-state.json',
      JSON.stringify({
        task: TASK,
        round: 2,
        head: 'def456',
        branch: 'task/task-run-v1/14',
        prNumber: 517,
        reason: 'max_rounds',
        pausedAt: '2026-09-10T00:00:00.000Z'
      })
    )
    expect(deriveLoopState(root, TASK, { repo: null, loopsRoot: root })).toEqual({
      kind: 'paused',
      reason: 'max_rounds',
      detail: undefined,
      round: 2
    })
  })

  // `#548` v3, O2: a dead lock with no decided pause/publish is what an
  // uncaught error mid-loop leaves behind — `dev-review-loop.ts`'s own
  // `recordDriverExited` appends exactly this line shape to the role log.
  it('reports exited, naming the reason and last decision, when the lock is dead and the role log carries a driver_exited trace', () => {
    const root = tempDir()
    writeRunFile(
      root,
      TASK,
      'driver.pid.json',
      JSON.stringify({ pid: deadPid(), startedAt: '2026-09-10T00:00:00.000Z' })
    )
    appendRoleLine(
      loopLogPathFor(null, TASK, root),
      'dev-review-loop',
      'driver_exited: reason=error last_decision=dispatch_developer'
    )
    expect(deriveLoopState(root, TASK, { repo: null, loopsRoot: root })).toEqual({
      kind: 'exited',
      reason: 'error',
      lastDecision: 'dispatch_developer'
    })
  })

  it('prefers a real published round over a stale driver_exited trace from an earlier, already-superseded crash', () => {
    const root = tempDir()
    // The dead lock and the trace are both from a run superseded by a LATER
    // run that took over the lock, completed, and cleared it — no lock file
    // remains at all, so `exited` is never even considered.
    appendRoleLine(
      loopLogPathFor(null, TASK, root),
      'dev-review-loop',
      'driver_exited: reason=error last_decision=dispatch_developer'
    )
    writePublishedRound(root, TASK, 1)
    expect(deriveLoopState(root, TASK, { repo: null, loopsRoot: root })).toEqual({ kind: 'published', round: 1 })
  })
})

describe('lastRoundVerdictLines', () => {
  it('returns null when the outbox carries no round verdict files', () => {
    const root = tempDir()
    expect(lastRoundVerdictLines(root, TASK)).toBeNull()
  })

  it("reads the highest round's two verdict files, first line only", () => {
    const root = tempDir()
    writeRunFile(root, TASK, 'round-1-reviewer.md', 'VERDICT: APPROVE\n\nJudged head: abc\n')
    writeRunFile(root, TASK, 'round-1-security.md', 'VERDICT: PASS\n\nJudged head: abc\n')
    writeRunFile(root, TASK, 'round-2-reviewer.md', 'VERDICT: REQUEST CHANGES\n\nJudged head: def\n')
    writeRunFile(root, TASK, 'round-2-security.md', 'VERDICT: PASS\n\nJudged head: def\n')
    expect(lastRoundVerdictLines(root, TASK)).toEqual({
      round: 2,
      reviewer: 'VERDICT: REQUEST CHANGES',
      security: 'VERDICT: PASS'
    })
  })
})

describe('readLoopPhase (O1)', () => {
  it('returns null when no control record exists for the task', () => {
    const root = tempDir()
    expect(readLoopPhase(root, TASK)).toBeNull()
  })

  it("reads the round, the recorded phase, its shown label, and the minutes since the record's own timestamp", () => {
    const root = tempDir()
    writeLoopStateRound(root, TASK, 3, { phase: 'dispatch_reviewers', recordedAt: '2026-09-15T00:00:00.000Z' })
    expect(readLoopPhase(root, TASK, () => new Date('2026-09-15T00:07:30.000Z'))).toEqual({
      round: 3,
      recordedPhase: 'dispatch_reviewers',
      phase: 'reviewing',
      minutesInPhase: 8
    })
  })

  it('maps every phase the loop records to one shown phase, and passes an unknown one through verbatim', () => {
    const root = tempDir()
    const labelFor = (phase: string): string | undefined => {
      writeLoopStateRound(root, TASK, 1, { phase })
      return readLoopPhase(root, TASK)?.phase
    }
    expect(labelFor('dispatch_developer')).toBe('developing')
    expect(labelFor('ask_confidence')).toBe('awaiting confidence')
    expect(labelFor('dispatch_reviewers')).toBe('reviewing')
    expect(labelFor('publish')).toBe('publishing')
    expect(labelFor('pause')).toBe('paused')
    expect(labelFor('some_phase_added_later')).toBe('some_phase_added_later')
  })

  it('reports zero rather than a negative age when the record was written ahead of this clock', () => {
    const root = tempDir()
    writeLoopStateRound(root, TASK, 1, { phase: 'publish', recordedAt: '2026-09-15T00:10:00.000Z' })
    expect(readLoopPhase(root, TASK, () => new Date('2026-09-15T00:00:00.000Z'))?.minutesInPhase).toBe(0)
  })
})

describe('readLastConfidence (O1)', () => {
  it('returns null when no record carries a confidence for any round', () => {
    const root = tempDir()
    expect(readLastConfidence(root, TASK, null)).toBeNull()
  })

  it("reads the newest round's own stated confidence, naming the round it belongs to", () => {
    const root = tempDir()
    writeStatedConfidence(root, TASK, 2, 'CONFIDENCE: 90 — fixed the reported issue\n')
    writeStatedConfidence(root, TASK, 3, 'CONFIDENCE: 75 — one finding needed a wider fix\n')
    expect(readLastConfidence(root, TASK, null)).toEqual({ round: 3, percent: 75, source: 'stated' })
  })

  it('reports a malformed statement as a recorded absence, never as a zero', () => {
    const root = tempDir()
    writeStatedConfidence(root, TASK, 2, 'pretty confident, I think\n')
    expect(readLastConfidence(root, TASK, null)).toEqual({ round: 2, percent: null, source: 'stated' })
  })
})

describe('renderTaskStatusTable (O3)', () => {
  const base: Omit<TaskStatusRow, 'state' | 'pr'> = {
    tranche: 'task-run-v1',
    id: '14',
    issue: 515,
    round: null,
    phase: null,
    recordedPhase: null,
    minutesInPhase: null,
    lastConfidence: null,
    phaseHistory: null
  }

  it('renders one header row and one row per task, every recorded fact in its own column', () => {
    const rows: TaskStatusRow[] = [
      {
        ...base,
        pr: { number: 517 },
        state: { kind: 'running', pid: 4242, startedAt: 'x' },
        round: 2,
        phase: 'reviewing',
        recordedPhase: 'dispatch_reviewers',
        minutesInPhase: 7,
        lastConfidence: { round: 2, percent: 90, source: 'stated' },
        phaseHistory: { typicalPhaseMinutes: 5, typicalPhaseSamples: 4 }
      }
    ]
    const lines = renderTaskStatusTable(rows)
    expect(lines[0]?.split(/\s{2,}/)).toEqual([
      'task',
      'issue',
      'pr',
      'state',
      'round',
      'phase',
      'in phase',
      'confidence',
      'typical (history)'
    ])
    expect(lines[1]?.split(/\s{2,}/)).toEqual([
      '[task-run-v1] 14',
      '#515',
      '#517',
      'running (pid 4242)',
      '2',
      'reviewing',
      '7m',
      '90% (round 2)',
      '5m (n=4)'
    ])
  })

  it('names the typical-time column as history, in the header and in one sentence below the table', () => {
    const lines = renderTaskStatusTable([
      {
        ...base,
        pr: { number: 517 },
        state: { kind: 'running', pid: 4242, startedAt: 'x' },
        round: 1,
        phase: 'developing',
        recordedPhase: 'dispatch_developer',
        minutesInPhase: 3,
        phaseHistory: { typicalPhaseMinutes: 12, typicalPhaseSamples: 5 }
      }
    ])
    expect(lines[0]).toContain('typical (history)')
    const note = lines[lines.length - 1] as string
    expect(note).toContain('history, not a prediction')
    // Never a promise about this run: no deadline, no remaining time, no ETA.
    for (const line of lines) {
      expect(line.toLowerCase()).not.toContain('eta')
      expect(line.toLowerCase()).not.toContain('remaining')
    }
  })

  it('renders every absent fact as one dash, and prints no history sentence when no row carries a figure (O4)', () => {
    const lines = renderTaskStatusTable([{ ...base, pr: null, state: { kind: 'not_started' } }])
    expect(lines).toHaveLength(2)
    expect(lines[1]?.split(/\s{2,}/)).toEqual(['[task-run-v1] 14', '#515', '—', 'not started', '—', '—', '—', '—', '—'])
  })

  it('renders a confidence the loop recorded as absent as an absence, never as a zero', () => {
    const lines = renderTaskStatusTable([
      {
        ...base,
        pr: { number: 517 },
        state: { kind: 'paused', reason: 'confidence', round: 2 },
        round: 2,
        phase: 'paused',
        recordedPhase: 'pause',
        minutesInPhase: 40,
        lastConfidence: { round: 2, percent: null, source: 'stated' }
      }
    ])
    expect(lines[1]).toContain('absent (round 2)')
    expect(lines[1]).toContain('paused (confidence)')
  })
})

describe('resumeCommandFor', () => {
  it("renders the exact command the loop's own pause comment prints", () => {
    expect(resumeCommandFor(517)).toBe('vinaya dev-review-loop --resume 517')
    expect(resumeCommandFor(682, 'codex', 'gpt-5.6-terra')).toBe(
      'vinaya dev-review-loop --resume 682 --agent codex --model gpt-5.6-terra'
    )
  })
})
