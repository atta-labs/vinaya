import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROCESS_FIXTURE_BUDGET_MS, stripVinayaEnv } from './process-fixture.js'
import { fixtureDir } from './test-temp-fixture.js'
import {
  containmentLogLine,
  identityOf,
  isSameProcessAlive,
  registeredProcesses,
  registeredProcessOwned,
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

  test('a stale leaderless group number cannot authorize signalling a reused unrelated group', () => {
    const entry = { pid: 100, startTime: 'original', processGroup: true, runToken: 'r', label: 'old' }
    const inspect = { identity: (_pid: number) => null, groupExists: () => true, groupOf: () => 100 }
    expect(registeredProcessOwned(entry, inspect)).toBe(false)
  })

  test('a verified surviving member proves the original leaderless group, but reused member identities do not', () => {
    const entry = {
      pid: 100,
      startTime: 'leader',
      processGroup: true,
      runToken: 'r',
      label: 'old',
      members: [{ pid: 101, startTime: 'member' }]
    }
    const inspect = {
      identity: (pid: number) => (pid === 101 ? { pid, startTime: 'member' } : null),
      groupExists: () => true,
      groupOf: () => 100
    }
    expect(registeredProcessOwned(entry, inspect)).toBe(true)
    expect(
      registeredProcessOwned(entry, {
        ...inspect,
        identity: (pid) => (pid === 101 ? { pid, startTime: 'reused' } : null)
      })
    ).toBe(false)
    expect(registeredProcessOwned(entry, { ...inspect, groupOf: () => 200 })).toBe(false)
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

  test('a recorded live member allows reaping the original group after its leader exits', async () => {
    const dir = registryDir()
    const pidFile = join(dir, 'member.pid')
    const child = spawn('sh', ['-c', `sleep 300 & echo $! > '${pidFile}'; read acknowledgement; exit 0`], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: stripVinayaEnv()
    })
    const budget = setTimeout(() => child.kill('SIGKILL'), PROCESS_FIXTURE_BUDGET_MS)
    let member: ReturnType<typeof identityOf> = null
    try {
      while (!existsSync(pidFile)) await new Promise((resolve) => setTimeout(resolve, 10))
      member = identityOf(Number(readFileSync(pidFile, 'utf8')))
      const identity = identityOf(child.pid!)!
      await registerProcess({ ...identity, runToken: 'orphan', label: 'observed group', processGroup: true }, { dir })
      expect(registeredProcesses('orphan', { dir })[0]?.members).toContainEqual(member!)
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
      child.stdin!.end('ack\n')
      await exited
      await stopRegistered('orphan', { dir, graceMs: 200 })
      expect(await waitGone(member!.pid)).toBe(true)
    } finally {
      clearTimeout(budget)
      child.kill('SIGKILL')
      if (member && isSameProcessAlive(member)) process.kill(member.pid, 'SIGKILL')
    }
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
