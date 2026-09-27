/**
 * `task-status.ts`'s pure outbox-reading half — `deriveLoopState`,
 * `lastRoundVerdictLines`, `readLoopPhase`, `readLastConfidence`,
 * `renderTaskStatusTable`, `resumeCommandFor` — all
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
  confidenceFromSummaryComments,
  deriveLoopState,
  lastRoundVerdictLines,
  phaseIsCurrentFor,
  readLastConfidence,
  readLoopPhase,
  renderTaskStatusTable,
  resumeCommandFor,
  type TaskStatusRow
} from '../../src/lib/task-status.js'
import {
  mergedTaskPrNumbers,
  phaseHistoryLookup,
  phaseHistoryLookupFor,
  phaseSamplesFromMergedPrs,
  readPhaseSamples,
  resetPhaseHistoryCache,
  prCommentReaderForOneStatusRead,
  MERGED_TASK_PR_READ_CAP,
  PHASE_HISTORY_CACHE_TTL_MS,
  PHASE_HISTORY_FAILURE_BACKOFF_MS,
  SUMMARY_CONFIDENCE_READS_PER_STATUS_READ
} from '../../src/lib/task-status-history.js'
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

/** A principal-authored comment as a history read sees it. */
function historyComment(body: string, createdAt: string, author = 'principal') {
  return { body, author, createdAt }
}

const ROUND_MARKER = (round: number): string => `<!-- aeg:developer:round-${round} -->\nHead: abc123`
const REVIEWER_VERDICT = 'VERDICT: APPROVE\n\nJudged head: abc123'
const SECURITY_VERDICT = 'VERDICT: PASS\n\nJudged head: abc123'

/** One merged pull request's comments: a round marker, then that round's two verdicts `reviewMinutes` later. */
function mergedPrComments(startIso: string, reviewMinutes: number) {
  const start = Date.parse(startIso)
  const verdictAt = new Date(start + reviewMinutes * 60_000).toISOString()
  return [
    historyComment(ROUND_MARKER(1), startIso),
    historyComment(REVIEWER_VERDICT, verdictAt),
    historyComment(SECURITY_VERDICT, verdictAt)
  ]
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

/** The summary-table half of the confidence read, over one principal-authored comment — the same rule `publishedSummaryConfidence` applies after its forge read. */
function summaryConfidenceFor(body: string) {
  return confidenceFromSummaryComments([{ body, author: 'principal' }], ['principal'])
}

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

  it('never reports a summary round the loop never asked as an absence — that round has no confidence at all', () => {
    // The published summary's own table: round 1 is never asked for a
    // confidence (its cell is the not-asked glyph), round 2 stated one.
    const notAskedOnly = [
      '| round | blocker | major | minor | critical | high | medium | low | confidence | outcome |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      '| 1 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | — | green |'
    ].join('\n')
    expect(summaryConfidenceFor(notAskedOnly)).toBeNull()

    const askedLater = `${notAskedOnly}\n| 2 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 80% | green |`
    expect(summaryConfidenceFor(askedLater)).toEqual({ round: 2, percent: 80, source: 'published-summary' })
  })

  it('reports a malformed statement as a recorded absence, never as a zero', () => {
    const root = tempDir()
    writeStatedConfidence(root, TASK, 2, 'pretty confident, I think\n')
    expect(readLastConfidence(root, TASK, null)).toEqual({ round: 2, percent: null, source: 'stated' })
  })
})

describe('typical phase times from history (O2/O4)', () => {
  const ALLOWLIST = ['principal']

  it("measures a round's review interval from its marker to the last of its verdicts", () => {
    const samples = phaseSamplesFromMergedPrs([mergedPrComments('2026-09-20T10:00:00.000Z', 6)], ALLOWLIST)
    expect(samples.reviewing).toEqual([6])
    // No later round marker followed those verdicts, so the record says
    // nothing about time spent developing after them.
    expect(samples.developing).toEqual([])
  })

  it("measures a developing interval from a round's verdicts to the next round's marker", () => {
    const samples = phaseSamplesFromMergedPrs(
      [
        [
          historyComment(ROUND_MARKER(1), '2026-09-20T10:00:00.000Z'),
          historyComment(REVIEWER_VERDICT, '2026-09-20T10:05:00.000Z'),
          historyComment(SECURITY_VERDICT, '2026-09-20T10:06:00.000Z'),
          historyComment(ROUND_MARKER(2), '2026-09-20T10:26:00.000Z'),
          historyComment(REVIEWER_VERDICT, '2026-09-20T10:30:00.000Z')
        ]
      ],
      ALLOWLIST
    )
    expect(samples.reviewing).toEqual([6, 4])
    expect(samples.developing).toEqual([20])
  })

  it('ignores a round marker and a verdict posted by anyone outside the principal allowlist', () => {
    const impostor = [
      historyComment(ROUND_MARKER(1), '2026-09-20T10:00:00.000Z', 'passer-by'),
      historyComment(REVIEWER_VERDICT, '2026-09-20T18:00:00.000Z', 'passer-by')
    ]
    expect(phaseSamplesFromMergedPrs([impostor], ALLOWLIST)).toEqual({ developing: [], reviewing: [] })
  })

  it('answers with the median of every merged pull request it read, and its sample count', () => {
    const samples = phaseSamplesFromMergedPrs(
      [
        mergedPrComments('2026-09-20T10:00:00.000Z', 4),
        mergedPrComments('2026-09-21T10:00:00.000Z', 6),
        mergedPrComments('2026-09-22T10:00:00.000Z', 20)
      ],
      ALLOWLIST
    )
    // The median, never the mean: the 20-minute outlier would have pulled a
    // mean to 10 minutes.
    expect(phaseHistoryLookupFor(samples)('dispatch_reviewers')).toEqual({
      typicalPhaseMinutes: 6,
      typicalPhaseSamples: 3
    })
  })

  it('shows no typical time for a phase with too few past intervals, and for one with no history class at all (O4)', () => {
    const thin = phaseSamplesFromMergedPrs(
      [mergedPrComments('2026-09-20T10:00:00.000Z', 4), mergedPrComments('2026-09-21T10:00:00.000Z', 6)],
      ALLOWLIST
    )
    const lookup = phaseHistoryLookupFor(thin)
    expect(lookup('dispatch_reviewers')).toBeNull()
    expect(lookup('dispatch_developer')).toBeNull()
    // Publishing, pausing and a confidence re-ask have no comparable interval
    // on a merged pull request at all.
    expect(lookup('publish')).toBeNull()
    expect(lookup('pause')).toBeNull()
    expect(lookup('ask_confidence')).toBeNull()
  })

  it('reads only task branches, newest merge first, and never more pull requests than its cap', () => {
    const merged = JSON.stringify([
      { number: 10, headRefName: 'task/demo/1', mergedAt: '2026-09-20T10:00:00.000Z' },
      { number: 11, headRefName: 'changeset-release/main', mergedAt: '2026-09-21T10:00:00.000Z' },
      { number: 12, headRefName: 'task/demo/2', mergedAt: '2026-09-22T10:00:00.000Z' },
      { number: 13, headRefName: 'task/demo/3', mergedAt: '2026-09-23T10:00:00.000Z' }
    ])
    expect(mergedTaskPrNumbers(merged)).toEqual([13, 12, 10])
    expect(mergedTaskPrNumbers(merged, 2)).toEqual([13, 12])
    expect(MERGED_TASK_PR_READ_CAP).toBeGreaterThan(0)
  })

  it('degrades to no typical time when the forge read fails, never to an error, and reports the read as failed', () => {
    const read = readPhaseSamples({
      listMergedPrs: () => {
        throw new Error('gh: could not reach the forge')
      },
      fetchPrComments: () => {
        throw new Error('never called')
      },
      allowlist: () => ALLOWLIST
    })
    expect(phaseHistoryLookupFor(read.samples)('dispatch_reviewers')).toBeNull()
    // `ok: false` is what keeps this emptiness out of the cache — the forge
    // never reported it, so the next read tries again.
    expect(read.ok).toBe(false)
  })

  it("keeps the pull requests it could read when one of them fails, and reads each one's comments once", () => {
    const reads: number[] = []
    const read = readPhaseSamples({
      listMergedPrs: () =>
        JSON.stringify([
          { number: 10, headRefName: 'task/demo/1', mergedAt: '2026-09-20T10:00:00.000Z' },
          { number: 11, headRefName: 'task/demo/2', mergedAt: '2026-09-21T10:00:00.000Z' },
          { number: 12, headRefName: 'task/demo/3', mergedAt: '2026-09-22T10:00:00.000Z' },
          { number: 13, headRefName: 'task/demo/4', mergedAt: '2026-09-23T10:00:00.000Z' }
        ]),
      fetchPrComments: (pr) => {
        reads.push(pr)
        if (pr === 12) throw new Error('gh: comment read failed')
        return JSON.stringify({
          comments: mergedPrComments('2026-09-20T10:00:00.000Z', 5).map((c) => ({
            body: c.body,
            author: { login: c.author },
            createdAt: c.createdAt
          }))
        })
      },
      allowlist: () => ALLOWLIST
    })
    expect(reads).toEqual([13, 12, 11, 10])
    expect(phaseHistoryLookupFor(read.samples)('dispatch_reviewers')).toEqual({
      typicalPhaseMinutes: 5,
      typicalPhaseSamples: 3
    })
    // Three of four pull requests read is real history, so this result IS
    // cacheable — only a read that reached nothing is not.
    expect(read.ok).toBe(true)
  })

  it('refuses a pull-request number that is not a positive integer, never passing it to a subprocess argument list', () => {
    const merged = JSON.stringify([
      { number: 13, headRefName: 'task/demo/1', mergedAt: '2026-09-23T10:00:00.000Z' },
      { number: -1, headRefName: 'task/demo/2', mergedAt: '2026-09-22T10:00:00.000Z' },
      { number: 1.5, headRefName: 'task/demo/3', mergedAt: '2026-09-21T10:00:00.000Z' },
      { number: '12', headRefName: 'task/demo/4', mergedAt: '2026-09-20T10:00:00.000Z' }
    ])
    expect(mergedTaskPrNumbers(merged)).toEqual([13])
  })

  it('drops a merged pull request whose merge timestamp does not parse, since that timestamp decides which ones the cap keeps', () => {
    const merged = JSON.stringify([
      { number: 13, headRefName: 'task/demo/1', mergedAt: '2026-09-23T10:00:00.000Z' },
      { number: 14, headRefName: 'task/demo/2', mergedAt: null },
      { number: 15, headRefName: 'task/demo/3' }
    ])
    expect(mergedTaskPrNumbers(merged)).toEqual([13])
  })

  it('reports the read as failed when every pull request it named could not be read', () => {
    const read = readPhaseSamples({
      listMergedPrs: () =>
        JSON.stringify([{ number: 10, headRefName: 'task/demo/1', mergedAt: '2026-09-20T10:00:00.000Z' }]),
      fetchPrComments: () => {
        throw new Error('gh: comment read failed')
      },
      allowlist: () => ALLOWLIST
    })
    expect(read.ok).toBe(false)
  })

  it('reads nothing at all for a phase with no history class — the forge is never touched', () => {
    let reads = 0
    const deps = {
      listMergedPrs: () => {
        reads += 1
        return JSON.stringify([])
      },
      fetchPrComments: () => JSON.stringify({ comments: [] }),
      allowlist: () => ALLOWLIST
    }
    const lookup = phaseHistoryLookup(deps, () => 0)
    expect(lookup('publish')).toBeNull()
    expect(lookup('pause')).toBeNull()
    expect(lookup('ask_confidence')).toBeNull()
    expect(reads).toBe(0)
  })

  it('caches a successful read for its lifetime, and reads again once that lifetime passes', () => {
    resetPhaseHistoryCache()
    let reads = 0
    const deps = {
      listMergedPrs: () => {
        reads += 1
        return JSON.stringify([
          { number: 10, headRefName: 'task/demo/1', mergedAt: '2026-09-20T10:00:00.000Z' },
          { number: 11, headRefName: 'task/demo/2', mergedAt: '2026-09-21T10:00:00.000Z' },
          { number: 12, headRefName: 'task/demo/3', mergedAt: '2026-09-22T10:00:00.000Z' }
        ])
      },
      fetchPrComments: () =>
        JSON.stringify({
          comments: mergedPrComments('2026-09-20T10:00:00.000Z', 5).map((c) => ({
            body: c.body,
            author: { login: c.author },
            createdAt: c.createdAt
          }))
        }),
      allowlist: () => ALLOWLIST
    }
    let clock = 1_000
    // Two status reads inside the lifetime share one forge read…
    expect(phaseHistoryLookup(deps, () => clock)('dispatch_reviewers')).toEqual({
      typicalPhaseMinutes: 5,
      typicalPhaseSamples: 3
    })
    clock += PHASE_HISTORY_CACHE_TTL_MS - 1
    expect(phaseHistoryLookup(deps, () => clock)('dispatch_reviewers')).toEqual({
      typicalPhaseMinutes: 5,
      typicalPhaseSamples: 3
    })
    expect(reads).toBe(1)
    // …and a read past it goes to the forge again, so a long-lived session
    // picks up newly merged tasks.
    clock += 1
    expect(phaseHistoryLookup(deps, () => clock)('dispatch_reviewers')).toEqual({
      typicalPhaseMinutes: 5,
      typicalPhaseSamples: 3
    })
    expect(reads).toBe(2)
    resetPhaseHistoryCache()
  })

  it('retries a failed read only after its back-off, and never twice within one status read', () => {
    resetPhaseHistoryCache()
    let attempts = 0
    const deps = {
      listMergedPrs: () => {
        attempts += 1
        if (attempts === 1) throw new Error('gh: transient failure')
        return JSON.stringify([
          { number: 10, headRefName: 'task/demo/1', mergedAt: '2026-09-20T10:00:00.000Z' },
          { number: 11, headRefName: 'task/demo/2', mergedAt: '2026-09-21T10:00:00.000Z' },
          { number: 12, headRefName: 'task/demo/3', mergedAt: '2026-09-22T10:00:00.000Z' }
        ])
      },
      fetchPrComments: () =>
        JSON.stringify({
          comments: mergedPrComments('2026-09-20T10:00:00.000Z', 7).map((c) => ({
            body: c.body,
            author: { login: c.author },
            createdAt: c.createdAt
          }))
        }),
      allowlist: () => ALLOWLIST
    }
    let clock = 5_000
    // One status read of ten rows, against a forge that is refusing: the whole
    // read attempts the forge ONCE. Retrying per row is what turns a rate
    // limit into a worse rate limit.
    const failing = phaseHistoryLookup(deps, () => clock)
    for (let row = 0; row < 10; row++) expect(failing('dispatch_reviewers')).toBeNull()
    expect(attempts).toBe(1)

    // A second status read inside the back-off window does not ask again
    // either — the failure is remembered, not cached for the process.
    clock += PHASE_HISTORY_FAILURE_BACKOFF_MS - 1
    expect(phaseHistoryLookup(deps, () => clock)('dispatch_reviewers')).toBeNull()
    expect(attempts).toBe(1)

    // Past the back-off the forge is asked again, and one transient failure has
    // not emptied the column for the life of a long-lived server session.
    clock += 1
    expect(phaseHistoryLookup(deps, () => clock)('dispatch_reviewers')).toEqual({
      typicalPhaseMinutes: 7,
      typicalPhaseSamples: 3
    })
    expect(attempts).toBe(2)
    resetPhaseHistoryCache()
  })

  it('reads the forge once for a whole healthy status read, however many rows ask', () => {
    resetPhaseHistoryCache()
    let listReads = 0
    let commentReads = 0
    const deps = {
      listMergedPrs: () => {
        listReads += 1
        return JSON.stringify([
          { number: 10, headRefName: 'task/demo/1', mergedAt: '2026-09-20T10:00:00.000Z' },
          { number: 11, headRefName: 'task/demo/2', mergedAt: '2026-09-21T10:00:00.000Z' },
          { number: 12, headRefName: 'task/demo/3', mergedAt: '2026-09-22T10:00:00.000Z' }
        ])
      },
      fetchPrComments: () => {
        commentReads += 1
        return JSON.stringify({
          comments: mergedPrComments('2026-09-20T10:00:00.000Z', 5).map((c) => ({
            body: c.body,
            author: { login: c.author },
            createdAt: c.createdAt
          }))
        })
      },
      allowlist: () => ALLOWLIST
    }
    const lookup = phaseHistoryLookup(deps, () => 9_000)
    for (let row = 0; row < 10; row++) lookup(row % 2 === 0 ? 'dispatch_developer' : 'dispatch_reviewers')
    expect(listReads).toBe(1)
    expect(commentReads).toBe(3)
    resetPhaseHistoryCache()
  })

  it('answers rather than throwing when a comment carries no readable body', () => {
    const read = readPhaseSamples({
      listMergedPrs: () =>
        JSON.stringify([{ number: 10, headRefName: 'task/demo/1', mergedAt: '2026-09-20T10:00:00.000Z' }]),
      // A changed `gh` output shape: `body` is not a string. Reaching the
      // marker parser with it would throw out of the whole status read.
      fetchPrComments: () =>
        JSON.stringify({
          comments: [{ body: null, author: { login: 'principal' }, createdAt: '2026-09-20T10:00:00.000Z' }]
        }),
      allowlist: () => ALLOWLIST
    })
    expect(read.samples).toEqual({ developing: [], reviewing: [] })
    // The forge WAS reached and its answer parsed — the comments simply carried
    // nothing readable — so this counts as a successful read and is remembered
    // for the full lifetime, unlike a read that reached nothing at all.
    expect(read.ok).toBe(true)
  })
})

describe('phaseIsCurrentFor (O1)', () => {
  it('reads a live driver as current, and every stopped run as not', () => {
    expect(phaseIsCurrentFor({ kind: 'running', pid: 1, startedAt: 'x' }, 'dispatch_developer')).toBe(true)
    expect(phaseIsCurrentFor({ kind: 'published', round: 2 }, 'publish')).toBe(false)
    expect(phaseIsCurrentFor({ kind: 'no_driver' }, 'dispatch_developer')).toBe(false)
    expect(phaseIsCurrentFor({ kind: 'exited', reason: 'error', lastDecision: 'x' }, 'dispatch_developer')).toBe(false)
    expect(phaseIsCurrentFor({ kind: 'not_started' }, 'dispatch_developer')).toBe(false)
  })

  it('reads a pause as current only when the control record agrees it is a pause', () => {
    expect(phaseIsCurrentFor({ kind: 'paused', reason: 'escalation', round: 1 }, 'pause')).toBe(true)
    // `pause-state.json` is never cleared on resume, so a task that paused at
    // round 1, resumed, and then died mid-round still derives `paused` while
    // `loop_state` names the phase it was working in. Reporting that phase as
    // current would assert developing is happening with no driver alive.
    expect(phaseIsCurrentFor({ kind: 'paused', reason: 'escalation', round: 1 }, 'dispatch_developer')).toBe(false)
    expect(phaseIsCurrentFor({ kind: 'paused', reason: 'escalation', round: 1 }, 'dispatch_reviewers')).toBe(false)
  })
})

describe('the summary-confidence comment reader (O1)', () => {
  const comments = (body: string) =>
    JSON.stringify({ comments: [{ body, author: { login: 'principal' }, createdAt: '2026-09-22T12:00:00.000Z' }] })

  function depsCounting(reads: number[]) {
    return {
      listMergedPrs: () => JSON.stringify([]),
      fetchPrComments: (pr: number) => {
        reads.push(pr)
        return comments('published summary')
      },
      allowlist: () => ['principal']
    }
  }

  it('reads one pull request once and remembers it across status reads', () => {
    resetPhaseHistoryCache()
    const reads: number[] = []
    const deps = depsCounting(reads)
    expect(prCommentReaderForOneStatusRead(deps, () => 1_000)(703)).not.toBeNull()
    // A second status read, well inside the lifetime — a published run's
    // summary never changes, so an Operator polling re-pays nothing.
    expect(prCommentReaderForOneStatusRead(deps, () => 2_000)(703)).not.toBeNull()
    expect(reads).toEqual([703])
    resetPhaseHistoryCache()
  })

  it('caps how many fresh reads one status read may make, reporting no record past the cap', () => {
    resetPhaseHistoryCache()
    const reads: number[] = []
    const reader = prCommentReaderForOneStatusRead(depsCounting(reads), () => 1_000)
    const asked = SUMMARY_CONFIDENCE_READS_PER_STATUS_READ + 3
    const answers = Array.from({ length: asked }, (_, i) => reader(800 + i))
    expect(reads).toHaveLength(SUMMARY_CONFIDENCE_READS_PER_STATUS_READ)
    expect(answers.filter((a) => a === null)).toHaveLength(asked - SUMMARY_CONFIDENCE_READS_PER_STATUS_READ)
    resetPhaseHistoryCache()
  })

  it('retries a failed read only after the back-off, like the history read', () => {
    resetPhaseHistoryCache()
    let attempts = 0
    const deps = {
      listMergedPrs: () => JSON.stringify([]),
      fetchPrComments: () => {
        attempts += 1
        throw new Error('gh: comment read failed')
      },
      allowlist: () => ['principal']
    }
    expect(prCommentReaderForOneStatusRead(deps, () => 1_000)(703)).toBeNull()
    expect(prCommentReaderForOneStatusRead(deps, () => 1_000 + PHASE_HISTORY_FAILURE_BACKOFF_MS - 1)(703)).toBeNull()
    expect(attempts).toBe(1)
    expect(prCommentReaderForOneStatusRead(deps, () => 1_000 + PHASE_HISTORY_FAILURE_BACKOFF_MS)(703)).toBeNull()
    expect(attempts).toBe(2)
    resetPhaseHistoryCache()
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
    phaseIsCurrent: null,
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
        phaseIsCurrent: true,
        lastConfidence: { round: 2, percent: 90, source: 'published-summary' },
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
        phaseIsCurrent: true,
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

  it("marks a figure the developer has only just stated, whose round's review has not completed", () => {
    const lines = renderTaskStatusTable([
      {
        ...base,
        pr: { number: 517 },
        state: { kind: 'running', pid: 4242, startedAt: 'x' },
        round: 3,
        phase: 'developing',
        recordedPhase: 'dispatch_developer',
        minutesInPhase: 2,
        phaseIsCurrent: true,
        lastConfidence: { round: 3, percent: 95, source: 'stated' }
      }
    ])
    // Read without the qualifier, this looks like round 3's review outcome.
    expect(lines[1]).toContain('95% (round 3, stated)')
  })

  it("marks the phase as last recorded when the driver vanished mid-flight, and doesn't for a live or resting run", () => {
    const stale = renderTaskStatusTable([
      {
        ...base,
        pr: { number: 517 },
        state: { kind: 'no_driver' },
        round: 2,
        phase: 'developing',
        recordedPhase: 'dispatch_developer',
        minutesInPhase: 2880,
        phaseIsCurrent: false
      }
    ])
    expect(stale[1]?.split(/\s{2,}/)).toEqual([
      '[task-run-v1] 14',
      '#515',
      '#517',
      'no driver',
      '2',
      'developing (last recorded)',
      '2880m',
      '—',
      '—'
    ])

    const live = renderTaskStatusTable([
      {
        ...base,
        pr: { number: 517 },
        state: { kind: 'running', pid: 4242, startedAt: 'x' },
        round: 2,
        phase: 'developing',
        recordedPhase: 'dispatch_developer',
        minutesInPhase: 2,
        phaseIsCurrent: true
      }
    ])
    expect(live[1]).toContain('developing ')
    expect(live[1]).not.toContain('last recorded')

    // A pause IS a place a run sits in, waiting for a person, so its phase
    // carries no qualifier. A published run is not: nothing is publishing.
    const resting = renderTaskStatusTable([
      {
        ...base,
        pr: { number: 517 },
        state: { kind: 'paused', reason: 'escalation', round: 2 },
        round: 2,
        phase: 'paused',
        recordedPhase: 'pause',
        minutesInPhase: 40,
        phaseIsCurrent: true
      }
    ])
    expect(resting[1]).not.toContain('last recorded')

    const finished = renderTaskStatusTable([
      {
        ...base,
        pr: { number: 517 },
        state: { kind: 'published', round: 2 },
        round: 2,
        phase: 'publishing',
        recordedPhase: 'publish',
        minutesInPhase: 4320,
        phaseIsCurrent: false
      }
    ])
    expect(finished[1]).toContain('publishing (last recorded)')
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
        phaseIsCurrent: true,
        lastConfidence: { round: 2, percent: null, source: 'published-summary' }
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
