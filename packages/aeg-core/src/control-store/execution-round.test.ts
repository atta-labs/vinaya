import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireOwnership,
  type ControlStoreDeps,
  readEffects,
  readExecutionRoundMirror,
  writeEffect,
  writeExecutionRoundMirror
} from './local'

let root: string
let deps: ControlStoreDeps

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'execution-round-'))
  deps = { root: () => root, now: () => new Date('2026-10-26T00:00:00Z'), pid: () => 4242, hostname: () => 'host' }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const mirror = {
  repository: 'owner/repo',
  threadId: 'engine-task-7',
  checkpointId: 'cp-1',
  round: 3,
  recordedAt: '2026-10-26T00:00:00Z'
}

describe('the execution-round mirror', () => {
  it('reads back what was written, keyed by task and thread', () => {
    writeExecutionRoundMirror(deps, 7, mirror)
    expect(readExecutionRoundMirror(deps, 7, 'engine-task-7')).toEqual({
      status: 'ok',
      value: { version: 1, kind: 'execution_round', task: 7, ...mirror }
    })
    expect(readExecutionRoundMirror(deps, 7, 'engine-task-7-reentry-1').status).toBe('absent')
    expect(readExecutionRoundMirror(deps, 8, 'engine-task-7').status).toBe('absent')
  })

  it('overwrites in place as the checkpoint moves', () => {
    writeExecutionRoundMirror(deps, 7, mirror)
    writeExecutionRoundMirror(deps, 7, { ...mirror, checkpointId: 'cp-2', round: 4 })
    const read = readExecutionRoundMirror(deps, 7, 'engine-task-7')
    expect(read.status === 'ok' && [read.value.checkpointId, read.value.round]).toEqual(['cp-2', 4])
  })

  it('reports a torn record as corrupt, never absent', () => {
    writeExecutionRoundMirror(deps, 7, mirror)
    const dir = join(root, '7', 'control', 'execution-round')
    for (const file of readdirSync(dir)) writeFileSync(join(dir, file), '{"version":1,')
    expect(readExecutionRoundMirror(deps, 7, 'engine-task-7').status).toBe('corrupt')
  })

  it('keeps a thread id in the executor scheme, and only ever inside the task folder', () => {
    for (const threadId of ['agent-spawn-run:engine-task-7', '../../escape']) {
      writeExecutionRoundMirror(deps, 7, { ...mirror, threadId })
      const read = readExecutionRoundMirror(deps, 7, threadId)
      expect(read.status === 'ok' && read.value.threadId).toBe(threadId)
    }
    expect(readdirSync(join(root, '7', 'control', 'execution-round'))).toHaveLength(2)
    expect(readdirSync(root)).toEqual(['7'])
  })
})

describe('reading every effect record of a task', () => {
  it('returns each record, a corrupt one included', () => {
    expect(readEffects(deps, 7)).toEqual([])
    const owned = acquireOwnership(deps, 7, 'owner')
    if (!owned.acquired) throw new Error('no epoch')
    const identity = { operation: 'branch-push', target: 't', payloadDigest: 'd', recordedAt: '2026-10-26T00:00:00Z' }
    writeEffect(deps, 7, owned.epoch, 'a', { ...identity, inputVersion: 2, status: 'verified', url: 'x' })
    writeEffect(deps, 7, owned.epoch, 'b', { ...identity, inputVersion: 3, status: 'started' })
    writeFileSync(join(root, '7', 'control', 'effect', 'c.json'), 'nope')
    const read = readEffects(deps, 7)
    expect(read.map((entry) => (entry.status === 'ok' ? entry.value.inputVersion : entry.status))).toEqual([
      2,
      3,
      'corrupt'
    ])
  })
})
