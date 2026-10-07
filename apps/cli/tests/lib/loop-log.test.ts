import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'bun:test'
import {
  appendLoopLogLine,
  appendRoleLine,
  appendRunStartMarker,
  LOOP_LOG_MAX_BYTES,
  loopLogPathFor
} from '../../src/lib/loop-log'
import { devReviewLoop, type LoopDeps } from '../../src/lib/dev-review-loop.js'
import {
  cleanupWorlds,
  makeInProcessDeps,
  makeWorld,
  outboxLines,
  withWorldEnv,
  defaultDeveloperTurnOutput
} from './dev-review-loop-harness.js'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
afterEach(cleanupWorlds)
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe('loopLogPathFor', () => {
  it("builds the task's own output/driver.log under the runtime directory", () => {
    const root = tempDir('loop-log-root-')
    expect(loopLogPathFor({ owner: 'acme', repo: 'widget' }, 521, root)).toBe(
      join(root, 'tasks-execution', '521', 'output', 'driver.log')
    )
  })

  it('ignores the repo, which the runtime directory already carries', () => {
    // The log used to sit in a `<owner>-<repo>/` directory of its own. The
    // runtime directory is already per-repository — a configured one belongs
    // to one repo, and the default keeps the segment — so two repositories
    // sharing an Issue number still get two files without the filename
    // repeating what the root already says.
    const root = tempDir('loop-log-root-')
    expect(loopLogPathFor(null, 521, root)).toBe(loopLogPathFor({ owner: 'acme', repo: 'widget' }, 521, root))
  })
})

describe('appendLoopLogLine', () => {
  it('creates the parent directory and the file, appending one line per call', () => {
    const dir = tempDir('loop-log-append-')
    const path = join(dir, 'nested', '521.log')
    appendLoopLogLine(path, 'first line')
    appendLoopLogLine(path, 'second line')
    expect(readFileSync(path, 'utf8')).toBe('first line\nsecond line\n')
  })

  it('appends across separate calls as if across separate process relaunches — never truncates', () => {
    const dir = tempDir('loop-log-append-')
    const path = join(dir, '521.log')
    appendLoopLogLine(path, 'run 1 line')
    // Simulate a fresh process by just calling again — the function itself
    // opens/closes the fd every call, exactly as a relaunch would.
    appendLoopLogLine(path, 'run 2 line')
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('run 1 line')
    expect(content).toContain('run 2 line')
    expect(content.indexOf('run 1 line')).toBeLessThan(content.indexOf('run 2 line'))
  })

  it('never throws when the parent path cannot be created (e.g. a file sitting where a directory is needed)', () => {
    const dir = tempDir('loop-log-append-')
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const path = join(blocker, '521.log')
    expect(() => appendLoopLogLine(path, 'line')).not.toThrow()
    expect(existsSync(path)).toBe(false)
  })

  it('refuses to follow a symlink at the target path rather than writing through it', () => {
    const dir = tempDir('loop-log-append-')
    const real = join(dir, 'real.log')
    writeFileSync(real, 'pre-existing\n')
    const link = join(dir, 'link.log')
    symlinkSync(real, link)
    appendLoopLogLine(link, 'should not land in real.log')
    expect(readFileSync(real, 'utf8')).toBe('pre-existing\n')
  })

  it('stops writing once the file has grown past LOOP_LOG_MAX_BYTES', () => {
    const dir = tempDir('loop-log-append-')
    const path = join(dir, '521.log')
    writeFileSync(path, 'x'.repeat(LOOP_LOG_MAX_BYTES + 1))
    appendLoopLogLine(path, 'this line must not be appended')
    const content = readFileSync(path, 'utf8')
    expect(content).not.toContain('this line must not be appended')
  })
})

describe('appendRoleLine', () => {
  it('prefixes every physical line with [<role>]', () => {
    const dir = tempDir('loop-log-role-')
    const path = join(dir, '521.log')
    appendRoleLine(path, 'developer', 'line one\nline two')
    expect(readFileSync(path, 'utf8')).toBe('[developer] line one\n[developer] line two\n')
  })
})

describe('appendRunStartMarker', () => {
  it('writes a delineated marker naming the role, pid, and run id', () => {
    const dir = tempDir('loop-log-marker-')
    const path = join(dir, '521.log')
    appendRunStartMarker(path, { role: 'dev-review-loop', pid: 12345, runId: 'run-abc' })
    const content = readFileSync(path, 'utf8')
    expect(content).toContain('=== run started')
    expect(content).toContain('role=dev-review-loop')
    expect(content).toContain('pid=12345')
    expect(content).toContain('run_id=run-abc')
  })

  it('two markers in sequence both survive, in order — the two-relaunch shape', () => {
    const dir = tempDir('loop-log-marker-')
    const path = join(dir, '521.log')
    appendRunStartMarker(path, { role: 'dev-review-loop', pid: 1 })
    appendRoleLine(path, 'developer', 'round 1 narration')
    appendRunStartMarker(path, { role: 'dev-review-loop', pid: 2 })
    appendRoleLine(path, 'developer', 'round 2 narration (after relaunch)')
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines.filter((l) => l.startsWith('=== run started')).length).toBe(2)
    expect(lines).toContain('[developer] round 1 narration')
    expect(lines).toContain('[developer] round 2 narration (after relaunch)')
  })
})

// [log-portable-v1] 6, O1/O2/O3: the driver sets `process.env.VINAYA_HOST`
// to `'loop'` once, at loop start, only when nothing upstream already named
// a host — and restores whatever it found there once the run ends, publish
// or pause alike. Driven in-process through `devReviewLoop()` itself (via
// `withWorldEnv`, bypassing `runLoopInProcess`'s own default input/overrides
// so each test can read `process.env.VINAYA_HOST` at the exact moment the
// call returns, before the harness's own outer env restore would mask it).
describe('devReviewLoop — the host attribution set at loop start', () => {
  it("sets VINAYA_HOST to 'loop' for every event this run logs when nothing upstream named a host, and restores it to unset afterward", async () => {
    const world = makeWorld()
    const base = makeInProcessDeps(world)
    const seenHosts: Array<string | undefined> = []
    const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
      seenHosts.push(process.env.VINAYA_HOST)
      return base.dispatchRole!(role, agent, prompt, opts)
    }
    let hostDuringRun: string | undefined
    let hostAfterReturn: string | undefined
    const result = await withWorldEnv(world, async () => {
      hostDuringRun = process.env.VINAYA_HOST
      const r = await devReviewLoop({ task: world.task, agent: 'claude' }, { ...base, dispatchRole })
      hostAfterReturn = process.env.VINAYA_HOST
      return r
    })

    // The harness clears VINAYA_HOST before this closure runs — a clean
    // starting point, never leaked from an earlier fixture.
    expect(hostDuringRun).toBeUndefined()
    expect(result.finalDecision.type).toBe('publish')
    expect(seenHosts.length).toBeGreaterThan(0)
    expect(seenHosts.every((h) => h === 'loop')).toBe(true)

    const lines = outboxLines(world)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => (l.meta as { host?: string } | undefined)?.host === 'loop')).toBe(true)

    expect(hostAfterReturn).toBeUndefined()
  })

  it("never overwrites a host already set — a hook's own VINAYA_HOST='hook' survives the whole run, every event it logs keeps 'hook', and the value is restored (not cleared) after", async () => {
    const world = makeWorld()
    const base = makeInProcessDeps(world)
    const seenHosts: Array<string | undefined> = []
    const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
      seenHosts.push(process.env.VINAYA_HOST)
      return base.dispatchRole!(role, agent, prompt, opts)
    }
    let hostAfterReturn: string | undefined
    const result = await withWorldEnv(world, async () => {
      // Set AFTER `withWorldEnv`'s own clearing, so this simulates the real
      // shape: something upstream of the driver (a hook that dispatched
      // this very run) already named a host before the driver's own
      // assignment ever runs.
      process.env.VINAYA_HOST = 'hook'
      const r = await devReviewLoop({ task: world.task, agent: 'claude' }, { ...base, dispatchRole })
      hostAfterReturn = process.env.VINAYA_HOST
      return r
    })

    expect(result.finalDecision.type).toBe('publish')
    expect(seenHosts.length).toBeGreaterThan(0)
    expect(seenHosts.every((h) => h === 'hook')).toBe(true)

    const lines = outboxLines(world)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.every((l) => (l.meta as { host?: string } | undefined)?.host === 'hook')).toBe(true)

    expect(hostAfterReturn).toBe('hook')
  })

  // A full publish under `GITHUB_ACTIONS` is deliberately NOT exercised here:
  // `log-sink.ts`'s own O3 rule ("a CI job never falls back to a folder")
  // means every one of this run's events resolves to `{kind: 'none'}` with
  // no configured server — `logEvents`'s own `waitForOwnLoopLine` then burns
  // its full 5s budget per event with nothing ever landing, which is exactly
  // right for a real CI job's log() calls but far too slow for a test that
  // logs a dozen events across a whole round. The quick developer-stop pause
  // below reaches its outcome before any of that matters.
  it("does not special-case CI — still sets VINAYA_HOST to 'loop' unconditionally when GITHUB_ACTIONS is set and VINAYA_HOST is unset; log-sink.ts's own precedence (GITHUB_ACTIONS checked before VINAYA_HOST, unchanged by this task) is what keeps the reported host 'ci'", async () => {
    const world = makeWorld({ developerStop: 'ESCALATE: no brief section names this repo at all.' as never })
    const base = makeInProcessDeps(world)
    let stopReads = 0
    let hostSeenAtDeveloperDispatch: string | undefined
    let ciSeenAtDeveloperDispatch: string | undefined
    const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
      if (role === 'developer') {
        hostSeenAtDeveloperDispatch = process.env.VINAYA_HOST
        ciSeenAtDeveloperDispatch = process.env.GITHUB_ACTIONS
        return {
          exitCode: 0,
          durationMs: 1,
          usage: null,
          resumeId: null,
          timedOut: false,
          effectId: 'eff-dev-1',
          turnOutput: defaultDeveloperTurnOutput(prompt)
        }
      }
      return base.dispatchRole!(role, agent, prompt, opts)
    }
    let hostAfterReturn: string | undefined
    const result = await withWorldEnv(world, async () => {
      process.env.GITHUB_ACTIONS = 'true'
      const r = await devReviewLoop(
        { task: world.task, agent: 'claude' },
        {
          ...base,
          dispatchRole,
          fetchDeveloperStop: () => (++stopReads === 1 ? null : { body: world.developerStop!, identity: 'new-stop-1' })
        }
      )
      hostAfterReturn = process.env.VINAYA_HOST
      return r
    })

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })
    expect(hostSeenAtDeveloperDispatch).toBe('loop')
    expect(ciSeenAtDeveloperDispatch).toBe('true')
    expect(hostAfterReturn).toBeUndefined()
  })

  it('restores the host after a pause too, not only after a clean publish', async () => {
    const world = makeWorld({ developerStop: 'ESCALATE: no brief section names this repo at all.' as never })
    const base = makeInProcessDeps(world)
    let stopReads = 0
    // The default fake always marks a developer dispatch as pushed, which
    // skips the one branch that reads `fetchDeveloperStop` — replaced here
    // with one that never pushes, the same shape the escalation-pause
    // fixtures elsewhere in this suite use to reach it.
    const dispatchRole: LoopDeps['dispatchRole'] = async (role, agent, prompt, opts) => {
      if (role === 'developer') {
        return {
          exitCode: 0,
          durationMs: 1,
          usage: null,
          resumeId: null,
          timedOut: false,
          effectId: 'eff-dev-1',
          turnOutput: defaultDeveloperTurnOutput(prompt)
        }
      }
      return base.dispatchRole!(role, agent, prompt, opts)
    }
    let hostAfterReturn: string | undefined
    const result = await withWorldEnv(world, async () => {
      const r = await devReviewLoop(
        { task: world.task, agent: 'claude' },
        {
          ...base,
          dispatchRole,
          fetchDeveloperStop: () => (++stopReads === 1 ? null : { body: world.developerStop!, identity: 'new-stop-1' })
        }
      )
      hostAfterReturn = process.env.VINAYA_HOST
      return r
    })

    expect(result.finalDecision).toMatchObject({ type: 'pause', reason: 'escalation' })
    expect(hostAfterReturn).toBeUndefined()
  })
})
