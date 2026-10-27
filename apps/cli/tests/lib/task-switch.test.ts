import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHECKPOINT_FILES, switchTask, type SwitchTaskDeps } from '../../src/lib/task-switch'

let root: string
let lines: string[]

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-switch-'))
  lines = []
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const runDir = (task: number) => join(root, 'engine-runs', String(task))

function seedCheckpoint(task: number): void {
  mkdirSync(runDir(task), { recursive: true })
  for (const name of CHECKPOINT_FILES) writeFileSync(join(runDir(task), name), `content of ${name}`)
}

function deps(overrides: Partial<SwitchTaskDeps> = {}): SwitchTaskDeps {
  return {
    runtimeDir: root,
    readRunner: () => 'atta-engine',
    liveDriverPid: () => null,
    readCheckpointRecord: async () => ({ agent: 'codex', model: 'gpt-5.5' }),
    hasPublishedWork: () => false,
    logLine: (_task, words) => lines.push(words),
    now: () => new Date('2026-10-27T03:04:05.678Z'),
    ...overrides
  }
}

describe('switchTask', () => {
  it('refuses with a live driver, naming its pid and changing nothing', async () => {
    seedCheckpoint(7)
    const result = await switchTask({ task: 7, agent: 'claude' }, deps({ liveDriverPid: () => 4242 }))
    expect(result.kind).toBe('refused')
    expect(result.message).toContain('pid 4242')
    for (const name of CHECKPOINT_FILES) expect(existsSync(join(runDir(7), name))).toBe(true)
    expect(lines).toEqual([])
  })

  it('moves all three checkpoint files aside when the task has no published work', async () => {
    seedCheckpoint(7)
    const result = await switchTask({ task: 7, agent: 'claude', model: 'opus' }, deps())
    expect(result.kind).toBe('switched')
    if (result.kind !== 'switched') return
    expect(result.publishedWork).toBe(false)
    expect(result.folder).toBe(join(runDir(7), 'switched-2026-10-27T03-04-05.678Z'))
    for (const name of CHECKPOINT_FILES) {
      expect(existsSync(join(runDir(7), name))).toBe(false)
      expect(readFileSync(join(result.folder as string, name), 'utf8')).toBe(`content of ${name}`)
    }
  })

  it('keeps going on the same branch when work is published, moving the checkpoint the same way', async () => {
    seedCheckpoint(7)
    const result = await switchTask({ task: 7, agent: 'claude' }, deps({ hasPublishedWork: () => true }))
    expect(result.kind).toBe('switched')
    if (result.kind !== 'switched') return
    expect(result.publishedWork).toBe(true)
    expect(result.message).toContain('branch and pull request are untouched')
    expect(readdirSync(runDir(7)).filter((name) => name.startsWith('checkpoints'))).toEqual([])
  })

  it('writes one driver-log line with the from and to agent, model and the folder', async () => {
    seedCheckpoint(7)
    const result = await switchTask({ task: 7, agent: 'claude', model: 'opus' }, deps())
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('from codex (gpt-5.5) to claude (opus)')
    expect(lines[0]).toContain(result.kind === 'switched' ? (result.folder as string) : 'unreachable')
  })

  it('moves the files of a second switch into its own folder, never over the first', async () => {
    seedCheckpoint(7)
    await switchTask({ task: 7, agent: 'claude' }, deps())
    seedCheckpoint(7)
    await switchTask({ task: 7, agent: 'codex' }, deps())
    expect(readdirSync(runDir(7)).filter((name) => name.startsWith('switched-'))).toHaveLength(2)
  })

  it('changes nothing on the standalone runner and says it switches by itself', async () => {
    seedCheckpoint(7)
    const result = await switchTask({ task: 7, agent: 'claude' }, deps({ readRunner: () => 'standalone' }))
    expect(result.kind).toBe('standalone')
    expect(result.message).toContain('already continues a task on a new --agent by itself')
    for (const name of CHECKPOINT_FILES) expect(existsSync(join(runDir(7), name))).toBe(true)
    expect(lines).toEqual([])
  })

  it('logs and reports a task with no checkpoint, moving nothing', async () => {
    const result = await switchTask({ task: 9, agent: 'codex' }, deps())
    expect(result.kind).toBe('switched')
    if (result.kind !== 'switched') return
    expect(result.folder).toBeNull()
    expect(lines).toHaveLength(1)
  })
})
