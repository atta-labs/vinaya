import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PROCESS_FIXTURE_BUDGET_MS, stripVinayaEnv } from './process-fixture.js'
import { fixtureDir } from './test-temp-fixture.js'
import {
  containmentLogLine,
  identityOf,
  isSameProcessAlive,
  registeredProcesses,
  registerProcess,
  selectContainmentBackend,
  stopRegistered
} from '../../src/lib/process-registry'

// The registry backend: register-and-acknowledge, identity by pid plus start time, TERM then KILL.

const registryDir = () => fixtureDir('process-registry-')

async function waitGone(pid: number, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms
  while (identityOf(pid) !== null) {
    if (Date.now() > until) return false
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return true
}

describe('process registry', () => {
  test('the backend is the registry on every OS, and its log line names the uncontained limit', () => {
    expect(selectContainmentBackend()).toBe('registry')
    expect(containmentLogLine('registry')).toContain('not contained')
  })

  test('identity is pid plus start time; a different start time is not the same process', () => {
    const self = identityOf(process.pid)
    expect(self?.pid).toBe(process.pid)
    expect(self?.startTime).toBeTruthy()
    expect(isSameProcessAlive(self as { pid: number; startTime: string })).toBe(true)
    expect(isSameProcessAlive({ pid: process.pid, startTime: 'another start' })).toBe(false)
    expect(identityOf(-1)).toBeNull()
  })

  test('a registration is on disk once registerProcess resolves', async () => {
    const dir = registryDir()
    const self = identityOf(process.pid) as { pid: number; startTime: string }
    await registerProcess({ ...self, runToken: 'run/1', label: 'self' }, { dir })
    expect(registeredProcesses('run/1', { dir })).toEqual([{ ...self, runToken: 'run/1', label: 'self' }])
  })

  test('stop sends TERM, then KILL to a process that ignores it, and removes the run records', async () => {
    const dir = registryDir()
    const child = spawn('sh', ['-c', 'trap "" TERM; while :; do sleep 1; done'], {
      stdio: 'ignore',
      detached: true,
      env: stripVinayaEnv()
    })
    // Budget: whatever the assertions below find, the stand-in never outlives this test.
    const budget = setTimeout(() => child.kill('SIGKILL'), PROCESS_FIXTURE_BUDGET_MS)
    budget.unref()
    const identity = identityOf(child.pid as number) as { pid: number; startTime: string }
    await registerProcess({ ...identity, runToken: 'r', label: 'stubborn', processGroup: true }, { dir })
    const report = await stopRegistered('r', { graceMs: 200, dir })
    expect(report.killed.map((p) => p.pid)).toEqual([identity.pid])
    expect(await waitGone(identity.pid)).toBe(true)
    expect(readdirSync(dir)).toEqual([])
  })

  test('a process that exits on TERM is reported terminated, with its group', async () => {
    const dir = registryDir()
    const child = spawn('sh', ['-c', 'sleep 300 & wait'], { stdio: 'ignore', detached: true, env: stripVinayaEnv() })
    // Budget: whatever the assertions below find, the stand-in never outlives this test.
    const budget = setTimeout(() => child.kill('SIGKILL'), PROCESS_FIXTURE_BUDGET_MS)
    budget.unref()
    const identity = identityOf(child.pid as number) as { pid: number; startTime: string }
    await registerProcess({ ...identity, runToken: 'r', label: 'group', processGroup: true }, { dir })
    const report = await stopRegistered('r', { graceMs: 3000, dir })
    expect(report.terminated.map((p) => p.pid)).toEqual([identity.pid])
    expect(report.killed).toEqual([])
  })

  test('a reused pid (same pid, another start time) is never signalled', async () => {
    const dir = registryDir()
    const self = identityOf(process.pid) as { pid: number; startTime: string }
    await registerProcess({ pid: self.pid, startTime: 'an earlier start', runToken: 'r', label: 'stale' }, { dir })
    const report = await stopRegistered('r', { graceMs: 50, dir })
    expect(report.alreadyGone.map((p) => p.pid)).toEqual([self.pid])
    expect(identityOf(process.pid)).not.toBeNull()
    expect(existsSync(join(dir, 'r'))).toBe(false)
  })
})
