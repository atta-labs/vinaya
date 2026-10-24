import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  engineCancellationRequested,
  readTaskRunner,
  recordTaskRunner,
  requestEngineCancellation,
  taskRunnerRecordPath
} from '../../../src/lib/task-run-engine.js'

const roots: string[] = []
const root = () => {
  const value = mkdtempSync(join(tmpdir(), 'engine-runner-routing-'))
  roots.push(value)
  return value
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true })
})

describe('recorded task runner routing', () => {
  it('keeps legacy runs on standalone and records either selected runner atomically', async () => {
    const runtime = root()
    expect(readTaskRunner(17, runtime)).toBe('standalone')
    recordTaskRunner(17, 'atta-engine', runtime, () => new Date('2026-01-02T03:04:05.000Z'))
    expect(readTaskRunner(17, runtime)).toBe('atta-engine')
    expect(await Bun.file(taskRunnerRecordPath(17, runtime)).json()).toEqual({
      schemaVersion: 1,
      runner: 'atta-engine',
      recordedAt: '2026-01-02T03:04:05.000Z'
    })
    recordTaskRunner(17, 'standalone', runtime)
    expect(readTaskRunner(17, runtime)).toBe('standalone')
  })

  it('records an Engine cancellation request in the Engine run directory', () => {
    const runtime = root()
    expect(engineCancellationRequested(17, runtime)).toBe(false)
    requestEngineCancellation(17, runtime)
    expect(engineCancellationRequested(17, runtime)).toBe(true)
  })
})
