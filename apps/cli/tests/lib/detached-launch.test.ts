import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'bun:test'
import { attachedRunNotice } from '../../src/commands/task-run.js'
import { launchDetached, waitForLiveDriver } from '../../src/lib/detached-launch.js'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('detached launch', () => {
  it('keeps the launched process running after the process that launched it exits', async () => {
    const script = `
      import { launchDetached } from ${JSON.stringify(join(SRC, 'lib', 'detached-launch.ts'))}
      const child = launchDetached('sleep', ['30'], ['ignore', 'ignore', 'ignore'])
      child.unref()
      process.stdout.write(String(child.pid))
    `
    const out = execFileSync(process.argv[0] as string, ['-e', script], { encoding: 'utf8' })
    const pid = Number(out.trim())
    try {
      expect(Number.isInteger(pid) && pid > 0).toBe(true)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(alive(pid)).toBe(true)
    } finally {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  })

  it('puts the launched process in a process group of its own', () => {
    const child = launchDetached('sleep', ['30'], ['ignore', 'ignore', 'ignore'])
    try {
      // A group whose id is the child's own pid exists only if the child leads it.
      expect(() => process.kill(-(child.pid as number), 0)).not.toThrow()
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('reports a launch that exits before its driver appears as exited, with its stderr', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'detached-launch-'))
    const stderrPath = join(dir, 'stderr.log')
    writeFileSync(stderrPath, 'boom\n')
    const child = launchDetached('sh', ['-c', 'exit 3'], ['ignore', 'ignore', 'ignore'])
    const result = await waitForLiveDriver(child, dir, 1, stderrPath, 5_000, 20)
    expect(result.status).toBe('exited')
    if (result.status === 'exited') {
      expect(result.error.message).toContain('code 3')
      expect(result.error.message).toContain('boom')
    }
  })

  it('reports a launch still alive when the wait ends as starting, not failed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'detached-launch-'))
    const child = launchDetached('sleep', ['30'], ['ignore', 'ignore', 'ignore'])
    try {
      const result = await waitForLiveDriver(child, dir, 1, join(dir, 'none.log'), 150, 20)
      expect(result.status).toBe('starting')
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('is the only launch path of the background run and both Operator tools', () => {
    for (const file of ['lib/task-run-background.ts', 'lib/task-tools/start.ts', 'lib/task-tools/resume.ts']) {
      const text = readFileSync(join(SRC, file), 'utf8')
      expect(text).not.toContain('detached: true')
      expect(text).not.toMatch(/\bspawn\(/)
    }
    for (const file of ['lib/task-tools/start.ts', 'lib/task-tools/resume.ts']) {
      expect(readFileSync(join(SRC, file), 'utf8')).not.toContain('function waitForLiveDriver')
    }
  })
})

describe('attached run notice', () => {
  const tranche = { tranche: 'demo-v1', n: 4, agent: 'claude' as const }

  it('names the background command for a tranche task from a terminal', () => {
    const notice = attachedRunNotice(tranche, true)
    expect(notice).toContain('stops when the terminal closes')
    expect(notice).toContain('vinaya task run demo-v1 4 --agent claude --background')
  })

  it('carries the issue address and the model into the command', () => {
    const notice = attachedRunNotice({ issue: 12, agent: 'codex', model: 'gpt-x' }, true)
    expect(notice).toContain('vinaya task run --issue 12 --agent codex --model gpt-x --background')
  })

  it('stays quiet when standard input is not a terminal', () => {
    expect(attachedRunNotice(tranche, false)).toBeNull()
  })
})
