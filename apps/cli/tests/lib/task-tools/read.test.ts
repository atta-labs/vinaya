import { afterEach, describe, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { paginate, readEscalationPacket, readTaskLoopStateObserved } from '../../../src/lib/task-tools/read.js'

const TASK = 558

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vinaya-task-tools-read-'))
  tempDirs.push(dir)
  return dir
}

function taskDir(root: string, task: number): string {
  return join(root, 'dev-review-loop', String(task))
}

function writeOutboxFile(root: string, task: number, name: string, content: string): void {
  const dir = taskDir(root, task)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), content, 'utf8')
}

function deadPid(): number {
  const r = spawnSync('true', [])
  if (typeof r.pid !== 'number') throw new Error('spawnSync did not report a pid')
  return r.pid
}

function writePause(
  root: string,
  task: number,
  overrides: Partial<{ round: number; reason: string; detail: string; prNumber: number }> = {}
): void {
  writeOutboxFile(
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
    writeOutboxFile(
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
    writeOutboxFile(root, TASK, 'effect-2-reviewer-verdict.json', JSON.stringify({ effectId: 'a', status: 'posted' }))
    writeOutboxFile(root, TASK, 'effect-2-security-verdict.json', JSON.stringify({ effectId: 'b', status: 'posted' }))
    const packet = readEscalationPacket(root, TASK)
    expect(packet?.freshness).toBe('stale')
  })

  it('carries the last round’s held verdict lines as evidence when present', () => {
    const root = tempDir()
    writePause(root, TASK, { round: 4, reason: 'no_progress' })
    writeOutboxFile(root, TASK, 'round-4-reviewer.md', 'VERDICT: REQUEST_CHANGES\nsome finding')
    writeOutboxFile(root, TASK, 'round-4-security.md', 'VERDICT: APPROVE\nno findings')
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

  it('a dead driver lock never turns a genuinely fresh pause into a mid-round read', () => {
    const root = tempDir()
    writeOutboxFile(
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
