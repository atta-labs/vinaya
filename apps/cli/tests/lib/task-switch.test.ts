import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { parseSwitchFlags } from '../../src/commands/task-switch'
import { readPauseState, writePauseState } from '../../src/lib/dev-review-loop/pause-resume'
import {
  CHECKPOINT_FILES,
  liveSwitchDeps,
  readCheckpointRecordFromFile,
  realHasPublishedWork,
  switchTask,
  type SwitchTaskDeps
} from '../../src/lib/task-switch'

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
    rewritePauseAgent: () => false,
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

  it('rewrites a held pause to the new agent and drops the old vendor model, so --resume is accepted too', async () => {
    seedCheckpoint(7)
    writePauseState(root, {
      task: 7,
      round: 2,
      head: 'abc',
      branch: 'task/issue-7',
      prNumber: 70,
      reason: 'escalation',
      pausedAt: '2026-10-27T00:00:00.000Z',
      agent: 'codex',
      model: 'gpt-5.5'
    } as Parameters<typeof writePauseState>[1])
    const live = { ...liveSwitchDeps(root, () => true), readRunner: () => 'atta-engine' as const, logLine: () => {} }
    const result = await switchTask({ task: 7, agent: 'claude', model: 'opus' }, live)
    expect(result.kind).toBe('switched')
    const held = readPauseState(root, 7)
    expect(held?.agent).toBe('claude')
    expect(held?.model).toBe('opus')
    expect(held?.prNumber).toBe(70)
    expect(held?.round).toBe(2)
  })

  it('leaves no pause record behind when none was held', async () => {
    const live = { ...liveSwitchDeps(root, () => false), readRunner: () => 'atta-engine' as const, logLine: () => {} }
    await switchTask({ task: 8, agent: 'claude' }, live)
    expect(readPauseState(root, 8)).toBeNull()
  })
})

describe('the task switch command line', () => {
  it('parses the agent, model and issue flags and collects any other token as unknown', () => {
    expect(parseSwitchFlags(['--issue', '5', '--agent', 'claude', '--model', 'opus'])).toEqual({
      issue: '5',
      agent: 'claude',
      model: 'opus',
      unknown: []
    })
    expect(parseSwitchFlags(['--agent', 'codex', '--background']).unknown).toEqual(['--background'])
  })

  const usage = (args: string[]) =>
    spawnSync('bun', [join(import.meta.dir, '../../src/index.ts'), 'task', 'switch', ...args], {
      encoding: 'utf8',
      env: { ...process.env, VINAYA_RUNTIME_DIR: root }
    })

  it('exits 2 and names --agent when the agent is missing', () => {
    const run = usage(['--issue', '1'])
    expect(run.status).toBe(2)
    expect(run.stderr).toContain('--agent')
  })

  it('exits 2 for an unknown flag, a mixed address and a non-numeric task', () => {
    expect(usage(['--issue', '1', '--agent', 'claude', '--rollback']).status).toBe(2)
    expect(usage(['tranche', '1', '--issue', '1', '--agent', 'claude']).status).toBe(2)
    expect(usage(['--issue', 'x', '--agent', 'claude']).status).toBe(2)
  })
})

describe('readCheckpointRecordFromFile', () => {
  it('reads the agent and model of the newest checkpoint', async () => {
    mkdirSync(root, { recursive: true })
    const file = join(root, 'checkpoints.sqlite')
    const db = new DatabaseSync(file)
    db.exec('CREATE TABLE checkpoints (thread_id TEXT, checkpoint_ns TEXT, checkpoint_id TEXT, model TEXT, agent TEXT)')
    db.exec("INSERT INTO checkpoints VALUES ('t', '', '1', 'old-model', 'claude')")
    db.exec("INSERT INTO checkpoints VALUES ('t', '', '2', 'gpt-5.5', 'codex')")
    db.close()
    expect(await readCheckpointRecordFromFile(file)).toEqual({ agent: 'codex', model: 'gpt-5.5' })
  })

  it('reads null from a file that is not a checkpoint database', async () => {
    const file = join(root, 'not-a-db.sqlite')
    writeFileSync(file, 'plain text')
    expect(await readCheckpointRecordFromFile(file)).toBeNull()
  })
})

describe('realHasPublishedWork', () => {
  const base = { developerBranchFor: (n: number) => `task/issue-${n}` }
  it('is true with an open pull request, or with commits beyond main, and false with neither', () => {
    expect(realHasPublishedWork(3, { ...base, findOpenPrForBranch: () => ({}), commitsBeyondMain: () => 0 })).toBe(true)
    expect(realHasPublishedWork(3, { ...base, findOpenPrForBranch: () => null, commitsBeyondMain: () => 2 })).toBe(true)
    expect(realHasPublishedWork(3, { ...base, findOpenPrForBranch: () => null, commitsBeyondMain: () => 0 })).toBe(
      false
    )
  })
})
