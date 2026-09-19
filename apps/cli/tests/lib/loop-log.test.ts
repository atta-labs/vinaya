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

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
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
