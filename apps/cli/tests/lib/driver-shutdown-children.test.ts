import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { guardedSpawnSync } from '../../src/lib/driver-tool-guard.js'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'driver-tool-guard.ts')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return check()
}

/** A stand-in driver: runs `command` through the guard synchronously, as a driver tool does, recording the grandchild's pid. */
function startFakeDriver(dir: string, command: string): ReturnType<typeof spawn> {
  const script = `
    import { guardedSpawnSync } from ${JSON.stringify(GUARD)}
    guardedSpawnSync('sh', ['-c', ${JSON.stringify(command)}], { stdio: 'inherit', guardPollMs: 50, guardGraceMs: 1500 })
  `
  return spawn(process.argv[0] as string, ['-e', script], { cwd: dir, stdio: 'ignore' })
}

describe('a stopped driver ends the processes its own tools started', () => {
  it('ends a tool child and its descendants when the driver is killed by a signal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'driver-shutdown-'))
    const pidFile = join(dir, 'pid')
    // A tool child that starts a descendant (the hook's test run) and waits on it.
    const driver = startFakeDriver(dir, `sleep 60 & echo $! > ${pidFile}; wait`)
    let grandchild = 0
    try {
      expect(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 10_000)).toBe(true)
      grandchild = Number(readFileSync(pidFile, 'utf8').trim())
      expect(alive(grandchild)).toBe(true)
      driver.kill('SIGKILL')
      expect(await waitFor(() => !alive(grandchild), 10_000)).toBe(true)
    } finally {
      driver.kill('SIGKILL')
      if (grandchild > 0 && alive(grandchild)) process.kill(grandchild, 'SIGKILL')
    }
  })

  it('leaves a tool child of another driver alone', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'driver-shutdown-'))
    const dirB = mkdtempSync(join(tmpdir(), 'driver-shutdown-'))
    const pidA = join(dirA, 'pid')
    const pidB = join(dirB, 'pid')
    const a = startFakeDriver(dirA, `sleep 60 & echo $! > ${pidA}; wait`)
    const b = startFakeDriver(dirB, `sleep 60 & echo $! > ${pidB}; wait`)
    const pids: number[] = []
    try {
      expect(await waitFor(() => existsSync(pidA) && existsSync(pidB), 10_000)).toBe(true)
      const sleepA = Number(readFileSync(pidA, 'utf8').trim())
      const sleepB = Number(readFileSync(pidB, 'utf8').trim())
      pids.push(sleepA, sleepB)
      a.kill('SIGKILL')
      expect(await waitFor(() => !alive(sleepA), 10_000)).toBe(true)
      expect(alive(sleepB)).toBe(true)
    } finally {
      a.kill('SIGKILL')
      b.kill('SIGKILL')
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  it('still returns the command output and exit status while the driver lives', () => {
    const ok = guardedSpawnSync('sh', ['-c', 'echo out; echo err >&2'], { stdio: ['ignore', 'pipe', 'pipe'] })
    expect(ok.status).toBe(0)
    expect(ok.stdout).toBe('out\n')
    expect(ok.stderr).toBe('err\n')
    const failed = guardedSpawnSync('sh', ['-c', 'exit 7'], { stdio: ['ignore', 'pipe', 'pipe'] })
    expect(failed.status).toBe(7)
    const missing = guardedSpawnSync('vinaya-no-such-command', [], { stdio: ['ignore', 'pipe', 'pipe'] })
    expect(missing.status).toBe(127)
    expect(missing.stderr).toContain('vinaya-no-such-command')
  })
})
