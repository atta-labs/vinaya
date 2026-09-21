/**
 * `run-paths.ts` — the one function every run file resolves through, its
 * per-repository default, and the default-branch-only rule an unattended
 * caller puts a configured `runtimeDir` through.
 */
import { describe, expect, it } from 'bun:test'
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DRIVER_LOCK_FILENAME,
  defaultRuntimeDir,
  ensureRunDir,
  isInsideRepo,
  isUnattendedProcess,
  markProcessUnattended,
  repoSegment,
  resolveRuntimeDir,
  runPath,
  UNATTENDED_ENV_KEY,
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

  it('gives a round its own Developer folder, nested under that round rather than the task root (task-files-v1 2, #649)', () => {
    expect(runPath(RUNTIME, 648, { area: 'developer', round: 2 })).toBe(join(taskDir, 'rounds', '2', 'developer'))
    expect(runPath(RUNTIME, 648, { area: 'developer', round: 2, file: '.vinaya-confidence' })).toBe(
      join(taskDir, 'rounds', '2', 'developer', '.vinaya-confidence')
    )
    // A different round gets a different folder — never one shared across rounds.
    expect(runPath(RUNTIME, 648, { area: 'developer', round: 3, file: '.vinaya-confidence' })).toBe(
      join(taskDir, 'rounds', '3', 'developer', '.vinaya-confidence')
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

describe('resolveRuntimeDir — a value inside the repository is refused (security review, LOW)', () => {
  it('refuses a configured value naming a directory in the working tree, for an ATTENDED caller too', () => {
    expect(
      resolveRuntimeDir({
        repo: REPO,
        localConfig: withRuntimeDir('/w/repo/.vinaya-runs'),
        unattended: false,
        home: '/h',
        repoRoot: '/w/repo'
      })
    ).toBe('/h/runtime/atta-labs-vinaya')
  })

  it('refuses the repository root itself', () => {
    expect(
      resolveRuntimeDir({
        repo: REPO,
        localConfig: withRuntimeDir('/w/repo'),
        unattended: false,
        home: '/h',
        repoRoot: '/w/repo'
      })
    ).toBe('/h/runtime/atta-labs-vinaya')
  })

  it('still honours a value outside the repository', () => {
    expect(
      resolveRuntimeDir({
        repo: REPO,
        localConfig: withRuntimeDir('/srv/runs'),
        unattended: false,
        home: '/h',
        repoRoot: '/w/repo'
      })
    ).toBe('/srv/runs')
  })

  it('never mistakes a sibling whose name merely starts with the repo root for one inside it', () => {
    expect(isInsideRepo('/w/repo-backup/runs', '/w/repo')).toBe(false)
    expect(isInsideRepo('/w/repo/runs', '/w/repo')).toBe(true)
    expect(isInsideRepo('/w/repo', '/w/repo')).toBe(true)
    expect(isInsideRepo('/srv/runs', null)).toBe(false)
  })
})

describe('markProcessUnattended — the marker actually gets written (round 2 review, MAJOR)', () => {
  it('flips an environment this function was handed from attended to unattended', () => {
    const env: NodeJS.ProcessEnv = {}
    expect(isUnattendedProcess(env)).toBe(false)
    markProcessUnattended(env)
    expect(env[UNATTENDED_ENV_KEY]).toBe('1')
    expect(isUnattendedProcess(env)).toBe(true)
  })

  it('is idempotent', () => {
    const env: NodeJS.ProcessEnv = {}
    markProcessUnattended(env)
    markProcessUnattended(env)
    expect(env[UNATTENDED_ENV_KEY]).toBe('1')
  })
})

describe('ensureRunDir — run-file directories are owner-only (security review, MEDIUM)', () => {
  it('creates the whole chain 0700, whatever the umask, and re-asserts it on an existing directory', () => {
    const base = mkdtempSync(join(tmpdir(), 'vinaya-ensure-run-dir-'))
    try {
      const runtimeDir = join(base, 'runs')
      const deep = runPath(runtimeDir, 648, { area: 'round', round: 2, file: 'reviewer-work' })
      ensureRunDir(deep, runtimeDir)
      // Every ancestor this call created, not just the leaf — which writer
      // got there first must not decide the mode.
      for (const dir of [
        join(base, 'runs'),
        join(base, 'runs', 'tasks-execution'),
        join(base, 'runs', 'tasks-execution', '648'),
        join(base, 'runs', 'tasks-execution', '648', 'rounds'),
        join(base, 'runs', 'tasks-execution', '648', 'rounds', '2'),
        deep
      ]) {
        expect(statSync(dir).mode & 0o777, `${dir} should be owner-only`).toBe(0o700)
      }
      // A second call over the same tree stays 0700 and does not throw.
      ensureRunDir(deep, runtimeDir)
      expect(statSync(deep).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('refuses a pre-planted symlink at a missing ancestor, never writing through it (security review, CRITICAL)', () => {
    const base = mkdtempSync(join(tmpdir(), 'vinaya-ensure-run-dir-symlink-'))
    const attackerDir = mkdtempSync(join(tmpdir(), 'vinaya-ensure-run-dir-attacker-'))
    try {
      const runsRoot = join(base, 'runs', 'tasks-execution', '649')
      mkdirSync(runsRoot, { recursive: true })
      // A co-tenant on a shared `runtimeDir` pre-plants a symlink where the
      // real `rounds` directory would otherwise be created next.
      symlinkSync(attackerDir, join(runsRoot, 'rounds'))

      const runtimeDir = join(base, 'runs')
      const deep = runPath(runtimeDir, 649, { area: 'round', round: 2, file: 'reviewer-work' })
      expect(() => ensureRunDir(deep, runtimeDir)).toThrow()
      expect(readdirSync(attackerDir)).toEqual([])
    } finally {
      rmSync(base, { recursive: true, force: true })
      rmSync(attackerDir, { recursive: true, force: true })
    }
  })

  it('tolerates a symlinked ancestor ABOVE the runtime root, such as the macOS default temp root (#668)', () => {
    // Simulates macOS's own `/var` -> `/private/var` symlink: `realBase` is
    // the real directory, `base` is a symlink to it that this test's own
    // `runtimeDir` is built underneath — exactly the shape `os.tmpdir()`
    // hands every macOS process, unrelated to any co-tenant attack.
    const realBase = mkdtempSync(join(tmpdir(), 'vinaya-ensure-run-dir-real-'))
    const base = `${realBase}-symlink`
    symlinkSync(realBase, base)
    try {
      const runtimeDir = join(base, 'runs')
      const deep = runPath(runtimeDir, 650, { area: 'round', round: 1, file: 'reviewer-work' })
      expect(() => ensureRunDir(deep, runtimeDir)).not.toThrow()
      expect(statSync(deep).isDirectory()).toBe(true)
      // The runtime root itself — at the boundary, not above it — is still
      // a real, owner-only directory, never a symlink, even though `base`
      // (above it) is one.
      expect(lstatSync(runtimeDir).isDirectory()).toBe(true)
    } finally {
      rmSync(base, { force: true })
      rmSync(realBase, { recursive: true, force: true })
    }
  })
})
