import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { paginate, readEscalationPacket, readTaskLoopStateObserved } from '../../../src/lib/task-tools/read.js'

const TASK = 558

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/**
 * Returns an `outbox` PATH inside a fresh, per-test unique parent directory
 * — never the unique `mkdtempSync` directory itself. `readEscalationPacket`
 * derives its control-store root from `dirname(root)` (code review, round
 * 2, MEDIUM — the same `GLOBAL_VINAYA_HOME` sibling layout production
 * uses); a bare `mkdtempSync(join(tmpdir(), …))` result's own `dirname` is
 * just the SHARED system tmpdir, identical across every call in this
 * process, so two tests' escalation fixtures would collide there. Neither
 * `outbox/` nor its `control-store` sibling need to pre-exist — every
 * writer here creates its own subdirectory with `{ recursive: true }`.
 */
function tempDir(): string {
  const parent = mkdtempSync(join(tmpdir(), 'vinaya-task-tools-read-'))
  tempDirs.push(parent)
  return join(parent, 'outbox')
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

/**
 * Writes a fixture `EscalationRecord` at the SAME `dirname(root)/control-
 * store/<task>/escalation/<escalationId>.json` path `readEscalationPacket`
 * itself derives from `root` (code review, round 2, MEDIUM) — proves the
 * derivation is a real, fixture-testable sibling of `root`, never a read
 * that escapes to this machine's real global control store.
 */
function writeEscalationFixture(
  root: string,
  task: number,
  escalationId: string,
  record: Record<string, unknown>
): void {
  const dir = join(taskDir(root, task), 'control', 'escalation')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${escalationId}.json`), JSON.stringify(record), 'utf8')
}

function deadPid(): number {
  const r = spawnSync('true', [])
  if (typeof r.pid !== 'number') throw new Error('spawnSync did not report a pid')
  return r.pid
}

function controlDir(root: string, task: number): string {
  return join(taskDir(root, task), 'control')
}

/**
 * A published round in the control store's own layout: the two verdict effect
 * records at `verified` under `<task>/control/effect/<key>.json`, plus the
 * `loop_state` record whose `round` bounds the shared reader's scan — raw JSON
 * matching the schemas, the same seed-without-ownership shape
 * `writeEscalationFixture` uses. Retires the old flat `control/effect-<key>`
 * markers this task removed.
 */
function writePublishedRound(root: string, task: number, round: number): void {
  const dir = controlDir(root, task)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'loop-state.json'),
    JSON.stringify({
      version: 1,
      kind: 'loop_state',
      task,
      round,
      phase: 'publish',
      pauseReason: null,
      budgets: { mechanicalRetries: 0, reviewRounds: round, infrastructureRetries: 0 },
      heldResult: null,
      deliveredFindings: null,
      recordedAt: '2026-09-15T00:00:00.000Z'
    }),
    'utf8'
  )
  const effectDir = join(dir, 'effect')
  mkdirSync(effectDir, { recursive: true })
  for (const role of ['reviewer', 'security'] as const) {
    const key = `${round}-${role}-verdict`
    writeFileSync(
      join(effectDir, `${key}.json`),
      JSON.stringify({
        version: 1,
        kind: 'effect',
        task,
        key,
        operation: 'pr-comment',
        target: 'pr:900',
        inputVersion: round,
        payloadDigest: 'digest',
        status: 'verified',
        url: 'https://example.test/comment',
        recordedAt: '2026-09-15T00:00:00.000Z'
      }),
      'utf8'
    )
  }
}

function writePause(
  root: string,
  task: number,
  overrides: Partial<{ round: number; reason: string; detail: string; prNumber: number }> = {}
): void {
  writeRunFile(
    root,
    task,
    'pause-state.json',
    JSON.stringify({
      task,
      round: overrides.round ?? 2,
      head: 'abc123',
      branch: `task/issue-${task}`,
      prNumber: overrides.prNumber ?? 900,
      reason: overrides.reason ?? 'escalation',
      detail: overrides.detail,
      pausedAt: '2026-09-10T00:00:00.000Z'
    })
  )
}

describe('readTaskLoopStateObserved', () => {
  it('reports unknown freshness for a task with no outbox directory at all', () => {
    const root = tempDir()
    const observed = readTaskLoopStateObserved(root, TASK)
    expect(observed.value).toEqual({ kind: 'no_driver' })
    expect(observed.freshness).toBe('unknown')
    expect(() => new Date(observed.observedAt).toISOString()).not.toThrow()
  })

  it('reports fresh for a run mid-round (a live driver lock)', () => {
    const root = tempDir()
    writeRunFile(
      root,
      TASK,
      'driver.pid.json',
      JSON.stringify({ pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' })
    )
    const observed = readTaskLoopStateObserved(root, TASK)
    expect(observed.value).toEqual({ kind: 'running', pid: process.pid, startedAt: '2026-09-10T00:00:00.000Z' })
    expect(observed.freshness).toBe('fresh')
  })

  it('reports fresh for a currently-paused task', () => {
    const root = tempDir()
    writePause(root, TASK, { round: 2, reason: 'max_rounds' })
    const observed = readTaskLoopStateObserved(root, TASK)
    expect(observed.value.kind).toBe('paused')
    expect(observed.freshness).toBe('fresh')
  })
})

describe('readEscalationPacket', () => {
  it('returns null when the outbox carries no pause record at all', () => {
    const root = tempDir()
    expect(readEscalationPacket(root, TASK)).toBeNull()
  })

  it('returns a fresh packet with inputs and next actions from a live pause record', () => {
    const root = tempDir()
    writePause(root, TASK, { round: 3, reason: 'infrastructure', detail: 'reviewer role missing report.txt' })
    const packet = readEscalationPacket(root, TASK)
    expect(packet).not.toBeNull()
    expect(packet?.freshness).toBe('fresh')
    expect(packet?.reason).toBe('infrastructure')
    expect(packet?.detail).toBe('reviewer role missing report.txt')
    expect(packet?.inputs).toEqual({
      task: TASK,
      round: 3,
      head: 'abc123',
      branch: `task/issue-${TASK}`,
      prNumber: 900
    })
    expect(packet?.requestedAuthority).toBe('operator')
    expect(packet?.permittedNextActions.length).toBeGreaterThan(0)
    expect(packet?.permittedNextActions.at(-1)).toContain('vinaya dev-review-loop --resume 900')
  })

  it('marks a pause record stale once the outbox shows a later round already published', () => {
    const root = tempDir()
    writePause(root, TASK, { round: 1, reason: 'max_rounds' })
    writePublishedRound(root, TASK, 2)
    const packet = readEscalationPacket(root, TASK)
    expect(packet?.freshness).toBe('stale')
  })

  it('carries the last round’s held verdict lines as evidence when present', () => {
    const root = tempDir()
    writePause(root, TASK, { round: 4, reason: 'no_progress' })
    writeRunFile(root, TASK, 'round-4-reviewer.md', 'VERDICT: REQUEST_CHANGES\nsome finding')
    writeRunFile(root, TASK, 'round-4-security.md', 'VERDICT: APPROVE\nno findings')
    const packet = readEscalationPacket(root, TASK)
    expect(packet?.evidence).toEqual({
      round: 4,
      reviewer: 'VERDICT: REQUEST_CHANGES',
      security: 'VERDICT: APPROVE'
    })
  })

  it('routes a self-resolving pause reason to self, never to the principal', () => {
    const root = tempDir()
    writePause(root, TASK, { round: 1, reason: 'ruling_posted' })
    expect(readEscalationPacket(root, TASK)?.requestedAuthority).toBe('self')
  })

  it('runIdentity/inputVersions are null when no durable escalation record exists yet (code review, round 2, MEDIUM)', () => {
    const root = tempDir()
    writePause(root, TASK, { round: 3, reason: 'escalation' })
    const packet = readEscalationPacket(root, TASK)
    expect(packet?.runIdentity).toBeNull()
    expect(packet?.inputVersions).toBeNull()
  })

  it('exposes runIdentity/inputVersions from the durable escalation record, read through a root derived from the SAME outbox root — never the real machine global (code review, round 2, MEDIUM)', () => {
    const root = tempDir()
    writePause(root, TASK, { round: 3, reason: 'escalation' })
    const escalationId = `${TASK}-3-abc123`
    writeEscalationFixture(root, TASK, escalationId, {
      version: 1,
      kind: 'escalation',
      task: TASK,
      escalationId,
      round: 3,
      head: 'abc123',
      branch: `task/issue-${TASK}`,
      pr: 900,
      runId: 'run-abc',
      pid: 4242,
      host: 'ci-box',
      reason: 'escalation',
      attemptedRecovery: 'none — an escalation is a decision request, not a retry condition.',
      requestedDecision: 'rule or redirect the work',
      recipient: 'principal',
      briefHash: 'brief-hash',
      objectivesVersion: 'v1',
      rulingOrdinal: 0,
      policyDigest: 'policy-digest',
      recordedAt: '2026-09-15T00:00:00.000Z'
    })

    const packet = readEscalationPacket(root, TASK)

    expect(packet?.runIdentity).toEqual({ runId: 'run-abc', pid: 4242, host: 'ci-box' })
    expect(packet?.inputVersions).toEqual({
      briefHash: 'brief-hash',
      objectivesVersion: 'v1',
      rulingOrdinal: 0,
      policyDigest: 'policy-digest'
    })
  })

  it('follows PauseState.escalationId, not the natural key, once a disambiguating suffix was claimed', () => {
    const root = tempDir()
    writePause(root, TASK, { round: 3, reason: 'ruling_posted' })
    // Simulate a `PauseState` whose own escalation collided and was written
    // to a suffixed slot — write the fixture there, not at the natural key.
    const suffixedId = `${TASK}-3-abc123-2`
    const raw = JSON.parse(readFileSync(join(taskDir(root, TASK), 'control', 'pause-state.json'), 'utf8')) as Record<
      string,
      unknown
    >
    writeFileSync(
      join(taskDir(root, TASK), 'control', 'pause-state.json'),
      JSON.stringify({ ...raw, escalationId: suffixedId }),
      'utf8'
    )
    writeEscalationFixture(root, TASK, suffixedId, {
      version: 1,
      kind: 'escalation',
      task: TASK,
      escalationId: suffixedId,
      round: 3,
      head: 'abc123',
      branch: `task/issue-${TASK}`,
      pr: 900,
      runId: 'run-suffixed',
      pid: 1,
      host: 'box',
      reason: 'ruling_posted',
      attemptedRecovery: 'none required — the driver detected a mid-round ruling itself and paused for safety.',
      requestedDecision: 'resume',
      recipient: 'self',
      briefHash: null,
      objectivesVersion: null,
      rulingOrdinal: 1,
      policyDigest: 'policy-digest',
      recordedAt: '2026-09-15T00:00:00.000Z'
    })

    const packet = readEscalationPacket(root, TASK)

    expect(packet?.runIdentity).toEqual({ runId: 'run-suffixed', pid: 1, host: 'box' })
  })

  it('a dead driver lock never turns a genuinely fresh pause into a mid-round read', () => {
    const root = tempDir()
    writeRunFile(
      root,
      TASK,
      'driver.pid.json',
      JSON.stringify({ pid: deadPid(), startedAt: '2026-09-10T00:00:00.000Z' })
    )
    writePause(root, TASK, { round: 1, reason: 'no_push' })
    // deriveLoopState still prefers the exited/no-trace fallback ordering it
    // already has; the escalation read stays independent of it entirely.
    expect(readEscalationPacket(root, TASK)?.reason).toBe('no_push')
  })
})

describe('paginate', () => {
  it('returns everything with no cursor when it fits under the limit', () => {
    expect(paginate([1, 2, 3], undefined, 10)).toEqual({ items: [1, 2, 3], nextCursor: null })
  })

  it('bounds a page at limit and returns a cursor for the rest', () => {
    const page1 = paginate([1, 2, 3, 4, 5], undefined, 2)
    expect(page1).toEqual({ items: [1, 2], nextCursor: '2' })
    const page2 = paginate([1, 2, 3, 4, 5], page1.nextCursor ?? undefined, 2)
    expect(page2).toEqual({ items: [3, 4], nextCursor: '4' })
    const page3 = paginate([1, 2, 3, 4, 5], page2.nextCursor ?? undefined, 2)
    expect(page3).toEqual({ items: [5], nextCursor: null })
  })

  it('treats a malformed cursor as the start rather than throwing', () => {
    expect(paginate([1, 2, 3], 'not-a-number', 10)).toEqual({ items: [1, 2, 3], nextCursor: null })
  })
})
