/**
 * `run-paths.ts` — the one function every run file resolves through, its
 * per-repository default, and the default-branch-only rule an unattended
 * caller puts a configured `runtimeDir` through.
 */
import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import {
  DRIVER_LOCK_FILENAME,
  defaultRuntimeDir,
  isUnattendedProcess,
  repoSegment,
  resolveRuntimeDir,
  runPath,
  type RunPathsRepo
} from '../../src/lib/run-paths'
import type { VinayaConfig } from '../../src/lib/config'

const REPO: RunPathsRepo = { owner: 'atta-labs', repo: 'vinaya' }
const RUNTIME = '/runtime'

const withRuntimeDir = (runtimeDir?: string): VinayaConfig | null =>
  (runtimeDir === undefined ? {} : { runtimeDir }) as VinayaConfig

describe('defaultRuntimeDir — a per-repository folder under the machine Vinaya home', () => {
  it('keeps the repository segment, because task numbers repeat across repositories', () => {
    expect(defaultRuntimeDir(REPO, '/home/x/.vinaya')).toBe('/home/x/.vinaya/runtime/atta-labs-vinaya')
  })

  it('falls back to `unresolved` when the repository could not be resolved', () => {
    expect(defaultRuntimeDir(null, '/home/x/.vinaya')).toBe('/home/x/.vinaya/runtime/unresolved')
  })

  it('treats a traversal-shaped repo half exactly like an unresolved repo', () => {
    expect(repoSegment({ owner: 'atta-labs', repo: '../../etc' })).toBe('unresolved')
    expect(defaultRuntimeDir({ owner: '..', repo: '..' }, '/home/x/.vinaya')).toBe('/home/x/.vinaya/runtime/unresolved')
  })
})

describe('resolveRuntimeDir — who is allowed to name the directory', () => {
  it('uses the per-repository default when nothing is configured', () => {
    expect(resolveRuntimeDir({ repo: REPO, localConfig: withRuntimeDir(), unattended: false, home: '/h' })).toBe(
      '/h/runtime/atta-labs-vinaya'
    )
  })

  it('honours the working tree for an attended caller', () => {
    expect(
      resolveRuntimeDir({ repo: REPO, localConfig: withRuntimeDir('/srv/runs'), unattended: false, home: '/h' })
    ).toBe('/srv/runs')
  })

  it('honours a configured value for an unattended caller only when the default branch declares the same one', () => {
    expect(
      resolveRuntimeDir({
        repo: REPO,
        localConfig: withRuntimeDir('/srv/runs'),
        trustAnchorConfig: withRuntimeDir('/srv/runs'),
        unattended: true,
        home: '/h'
      })
    ).toBe('/srv/runs')
  })

  it('refuses a working-tree value the default branch does not declare, falling back to the default', () => {
    expect(
      resolveRuntimeDir({
        repo: REPO,
        localConfig: withRuntimeDir('/tmp/attacker'),
        trustAnchorConfig: withRuntimeDir('/srv/runs'),
        unattended: true,
        home: '/h'
      })
    ).toBe('/h/runtime/atta-labs-vinaya')
  })

  it('falls back to the default when the trust anchor is unavailable — never to the working tree', () => {
    expect(
      resolveRuntimeDir({
        repo: REPO,
        localConfig: withRuntimeDir('/tmp/attacker'),
        trustAnchorConfig: null,
        unattended: true,
        home: '/h'
      })
    ).toBe('/h/runtime/atta-labs-vinaya')
  })
})

describe('isUnattendedProcess', () => {
  it('reads the driver marker and a dispatched role, and nothing else', () => {
    expect(isUnattendedProcess({ VINAYA_UNATTENDED: '1' })).toBe(true)
    expect(isUnattendedProcess({ VINAYA_ROLE: 'developer' })).toBe(true)
    expect(isUnattendedProcess({})).toBe(false)
    expect(isUnattendedProcess({ VINAYA_ROLE: '' })).toBe(false)
  })
})

describe('runPath — every run file resolves through this one function', () => {
  const taskDir = join(RUNTIME, 'tasks-execution', '648')

  it('places the driver lock at the task folder root, in no classified subdirectory', () => {
    expect(runPath(RUNTIME, 648, { area: 'task', file: DRIVER_LOCK_FILENAME })).toBe(join(taskDir, 'driver.pid.json'))
    expect(runPath(RUNTIME, 648, { area: 'task' })).toBe(taskDir)
  })

  it('classifies a task folder by the nature of its files', () => {
    expect(runPath(RUNTIME, 648, { area: 'control' })).toBe(join(taskDir, 'control'))
    expect(runPath(RUNTIME, 648, { area: 'sessions', file: 'developer-claude.json' })).toBe(
      join(taskDir, 'sessions', 'developer-claude.json')
    )
    expect(runPath(RUNTIME, 648, { area: 'hooks', file: 'settings.json' })).toBe(
      join(taskDir, 'hooks', 'settings.json')
    )
    expect(runPath(RUNTIME, 648, { area: 'output', file: 'driver.log' })).toBe(join(taskDir, 'output', 'driver.log'))
  })

  it('gives every round its own folder under the task', () => {
    expect(runPath(RUNTIME, 648, { area: 'round', round: 2 })).toBe(join(taskDir, 'rounds', '2'))
    expect(runPath(RUNTIME, 648, { area: 'round', round: 2, file: 'reviewer.md' })).toBe(
      join(taskDir, 'rounds', '2', 'reviewer.md')
    )
  })

  it('gives a pull-request-only or unanchored dispatch a folder that cannot collide with an Issue number', () => {
    expect(runPath(RUNTIME, { pr: 648 }, { area: 'sessions', file: 'x.json' })).toBe(
      join(RUNTIME, 'tasks-execution', 'pr-648', 'sessions', 'x.json')
    )
    expect(runPath(RUNTIME, 'unscoped', { area: 'output' })).toBe(
      join(RUNTIME, 'tasks-execution', 'unscoped', 'output')
    )
  })

  it('keeps two repositories sharing one task number apart, through the default directory', () => {
    const a = runPath(defaultRuntimeDir({ owner: 'o', repo: 'a' }, '/h'), 12, { area: 'control' })
    const b = runPath(defaultRuntimeDir({ owner: 'o', repo: 'b' }, '/h'), 12, { area: 'control' })
    expect(a).not.toBe(b)
  })
})
