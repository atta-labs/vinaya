// Tracked hooks (atta-labs/attalabs#927) — ring 0 must survive a clone.
//
// The defect: a `.git/hooks` install writes hooks git never versions, so the
// manifest survives every clone while the hooks do not — the installing
// machine has enforcement, everyone who clones has none, silently. These
// tests prove the tracked `.vinaya/hooks` + `core.hooksPath` mechanism in the
// ONLY places the bug exists — a fresh `git clone` and a linked worktree —
// not just in the installing checkout, plus the migration/refusal/eject
// surfaces around it. Fixtures are REAL git repos throughout: the mechanism
// under test is git config + git's own hook resolution, which a bare tmp dir
// cannot exercise.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DoctorDeps } from '../src/commands/doctor.js'
import { runDoctor } from '../src/commands/doctor.js'
import type { EjectDeps } from '../src/commands/eject.js'
import { runEject } from '../src/commands/eject.js'
import type { InitDeps } from '../src/commands/init.js'
import { runInit } from '../src/commands/init.js'
import type { UpgradeDeps } from '../src/commands/upgrade.js'
import { runUpgrade, translateHookPaths } from '../src/commands/upgrade.js'
import { CONFIG_PATH, TRACKED_HOOK_DIR } from '../src/lib/artifacts.js'
import { CLAUDE_STOP_HOOK_SCRIPT_PATH } from '../src/lib/claude-stop-hook-emitter.js'
import type { ManagedManifest } from '../src/lib/config.js'
import {
  activeRawHooks,
  customHooksPath,
  foreignRawHooks,
  hookDirFromManifest,
  readCoreHooksPath,
  resolveHookDir,
  setCoreHooksPath,
  unsetCoreHooksPath
} from '../src/lib/detect.js'
import type { LabelGateway } from '../src/lib/ops.js'

let root: string

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function gitInit(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
}

const noLabels: LabelGateway = {
  async exists() {
    return true // pretend every label exists — no creation, no network
  },
  async create() {}
}

/** Real hook-routing deps (resolveHookDir / git config) — the mechanism under test. */
function realishInitDeps(repoRoot: () => string, overrides: Partial<InitDeps> = {}): InitDeps {
  return {
    detectRepo: async () => ({ repoRoot: repoRoot(), owner: 'acme', repo: 'widget' }),
    checkGhAuth: async () => true,
    labelGateway: () => noLabels,
    hookDirFor: resolveHookDir,
    customHooksPath,
    setHooksPath: setCoreHooksPath,
    confirm: async () => true,
    ...overrides
  }
}

function realishUpgradeDeps(repoRoot: () => string, overrides: Partial<UpgradeDeps> = {}): UpgradeDeps {
  return {
    detectRepo: async () => ({ repoRoot: repoRoot(), owner: 'acme', repo: 'widget' }),
    hookDirFor: resolveHookDir,
    readHooksPath: readCoreHooksPath,
    setHooksPath: setCoreHooksPath,
    confirm: async () => true,
    ...overrides
  }
}

function realishDoctorDeps(repoRoot: () => string, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    detectRepo: async () => ({ repoRoot: repoRoot(), owner: 'acme', repo: 'widget' }),
    ghAuthStatus: async () => ({ authenticated: true, detail: 'ok' }),
    branchProtectionConfigured: async () => null,
    hookDirFor: resolveHookDir,
    readHooksPath: readCoreHooksPath,
    nodeVersion: () => 'v99.0.0',
    bunVersion: () => null,
    packageVersion: () => '0.1.0-test',
    ...overrides
  }
}

function realishEjectDeps(repoRoot: () => string, overrides: Partial<EjectDeps> = {}): EjectDeps {
  return {
    detectRepo: async () => ({ repoRoot: repoRoot(), owner: 'acme', repo: 'widget' }),
    readHooksPath: readCoreHooksPath,
    unsetHooksPath: unsetCoreHooksPath,
    confirm: async () => true,
    ...overrides
  }
}

async function captureStdout(fn: () => Promise<unknown>): Promise<string> {
  const original = process.stdout.write.bind(process.stdout)
  let buf = ''
  process.stdout.write = ((chunk: string) => {
    buf += chunk
    return true
  }) as typeof process.stdout.write
  try {
    await fn()
  } finally {
    process.stdout.write = original
  }
  return buf
}

type Finding = { check: string; severity: string; message: string }
async function doctorJson(deps: DoctorDeps): Promise<{ rc: number; findings: Finding[] }> {
  let rc = -1
  const out = await captureStdout(async () => {
    rc = await runDoctor(['--json'], deps)
  })
  return { rc, findings: JSON.parse(out).data.findings }
}

function readManifest(dir: string): ManagedManifest {
  return JSON.parse(readFileSync(join(dir, CONFIG_PATH), 'utf-8')).managed
}

beforeEach(() => {
  root = join(tmpdir(), `vinaya-tracked-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'README.md'), '# widget\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// detect primitives
// ---------------------------------------------------------------------------
describe('hook-dir resolution', () => {
  it('prefers .husky when present (locked decision A, unchanged)', () => {
    mkdirSync(join(root, '.husky'))
    expect(resolveHookDir(root)).toBe('.husky')
  })

  it('defaults a clean repo to the tracked dir — sample hooks are not "active"', () => {
    gitInit(root)
    expect(existsSync(join(root, '.git/hooks'))).toBe(true) // git seeded *.sample files
    expect(resolveHookDir(root)).toBe(TRACKED_HOOK_DIR)
  })

  it('falls back to .git/hooks when an adopter has an active raw hook there — arming core.hooksPath would silently disable it', () => {
    gitInit(root)
    writeFileSync(join(root, '.git/hooks/post-checkout'), '#!/bin/sh\necho theirs\n', { mode: 0o755 })
    expect(resolveHookDir(root)).toBe('.git/hooks')
  })

  it('hookDirFromManifest maps tracked block paths to the tracked dir', () => {
    const manifest: ManagedManifest = {
      version: 2,
      files: [],
      blocks: [{ path: `${TRACKED_HOOK_DIR}/pre-commit`, marker: 'pre-commit', comment: 'hash' }],
      labels: []
    }
    expect(hookDirFromManifest(manifest, '.husky')).toBe(TRACKED_HOOK_DIR)
  })

  it('activeRawHooks counts only what git would fire — known name, regular file, executable', () => {
    gitInit(root)
    const hooks = join(root, '.git/hooks')
    // None of these ever fire; none may flip the layout or block a migration.
    writeFileSync(join(hooks, 'husky.sh'), '#!/bin/sh\n', { mode: 0o755 }) // unknown name
    writeFileSync(join(hooks, 'pre-commit.bak'), '#!/bin/sh\n', { mode: 0o755 }) // editor backup
    writeFileSync(join(hooks, 'pre-push'), '#!/bin/sh\n', { mode: 0o644 }) // known name, not executable
    mkdirSync(join(hooks, 'post-checkout')) // subdirectory squatting a hook name
    expect(activeRawHooks(root)).toEqual([])
    expect(resolveHookDir(root)).toBe(TRACKED_HOOK_DIR)
    // A real one still counts.
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho theirs\n', { mode: 0o755 })
    expect(activeRawHooks(root)).toEqual(['pre-commit'])
    expect(resolveHookDir(root)).toBe('.git/hooks')
  })

  it("foreignRawHooks excludes a host that is entirely vinaya's own stale managed block", () => {
    gitInit(root)
    const hooks = join(root, '.git/hooks')
    writeFileSync(
      join(hooks, 'pre-commit'),
      '#!/usr/bin/env sh\n# >>> vinaya:managed:pre-commit >>>\necho vinaya\n# <<< vinaya:managed:pre-commit <<<\n',
      { mode: 0o755 }
    )
    writeFileSync(join(hooks, 'post-checkout'), '#!/bin/sh\necho theirs\n', { mode: 0o755 })
    expect(activeRawHooks(root).sort()).toEqual(['post-checkout', 'pre-commit'])
    expect(foreignRawHooks(root)).toEqual(['post-checkout'])
  })

  it("customHooksPath does not refuse vinaya's own tracked dir", async () => {
    gitInit(root)
    git(root, ['config', 'core.hooksPath', TRACKED_HOOK_DIR])
    expect(await customHooksPath(root)).toBeNull()
    git(root, ['config', 'core.hooksPath', 'somewhere/else'])
    expect(await customHooksPath(root)).toBe('somewhere/else')
  })
})

// ---------------------------------------------------------------------------
// init → the fresh-clone and linked-worktree proofs (where the bug lives)
// ---------------------------------------------------------------------------
describe('ring 0 survives a clone', () => {
  it('init installs tracked, executable hooks and arms core.hooksPath; a clone carries the hooks and doctor names the one arming command until it is run', async () => {
    gitInit(root)
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial commit'])

    let rc = -1
    await captureStdout(async () => {
      rc = await runInit(
        ['--yes'],
        realishInitDeps(() => root)
      )
    })
    expect(rc).toBe(0)

    // Installing checkout: tracked hooks on disk, executable, armed.
    const preCommit = join(root, TRACKED_HOOK_DIR, 'pre-commit')
    expect(existsSync(preCommit)).toBe(true)
    expect(statSync(preCommit).mode & 0o111).not.toBe(0)
    expect(readFileSync(preCommit, 'utf-8')).toContain('vinaya:managed:pre-commit')
    expect(git(root, ['config', '--get', 'core.hooksPath'])).toBe(TRACKED_HOOK_DIR)
    // Manifest records the tracked paths — the portable half of the install.
    expect(readManifest(root).blocks.map((b) => b.path)).toEqual([
      `${TRACKED_HOOK_DIR}/pre-commit`,
      `${TRACKED_HOOK_DIR}/pre-push`,
      `${TRACKED_HOOK_DIR}/commit-msg`,
      CLAUDE_STOP_HOOK_SCRIPT_PATH
    ])

    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'Chore: install Vinaya', '--no-verify'])

    const cloneRoot = join(tmpdir(), `vinaya-tracked-clone-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    git(root, ['clone', '-q', root, cloneRoot])
    try {
      // THE fix, measured where the bug lives: the hooks arrive with the clone.
      expect(existsSync(join(cloneRoot, TRACKED_HOOK_DIR, 'pre-commit'))).toBe(true)
      expect(existsSync(join(cloneRoot, TRACKED_HOOK_DIR, 'pre-push'))).toBe(true)
      expect(statSync(join(cloneRoot, TRACKED_HOOK_DIR, 'pre-commit')).mode & 0o111).not.toBe(0)

      // The irreducible residue: git config is never cloned, so the clone is
      // inert until armed — and doctor says exactly that, with the command.
      const before = await doctorJson(realishDoctorDeps(() => cloneRoot))
      expect(before.rc).toBe(1)
      const inert = before.findings.find((f) => f.check === 'hooks' && f.severity === 'error')
      expect(inert?.message).toContain('ring 0 is INERT')
      expect(inert?.message).toContain(`git config core.hooksPath ${TRACKED_HOOK_DIR}`)

      // One command arms it; doctor's hooks findings go fully green.
      git(cloneRoot, ['config', 'core.hooksPath', TRACKED_HOOK_DIR])
      const after = await doctorJson(realishDoctorDeps(() => cloneRoot))
      const hookFindings = after.findings.filter((f) => f.check === 'hooks')
      expect(hookFindings.length).toBeGreaterThan(0)
      expect(hookFindings.every((f) => f.severity === 'ok')).toBe(true)
    } finally {
      rmSync(cloneRoot, { recursive: true, force: true })
    }
  }, 20_000)

  it('a linked worktree is covered with ZERO extra steps — tracked copy checked out, shared config already armed', async () => {
    gitInit(root)
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial commit'])
    await captureStdout(async () =>
      runInit(
        ['--yes'],
        realishInitDeps(() => root)
      )
    )
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'Chore: install Vinaya', '--no-verify'])

    const wtRoot = join(tmpdir(), `vinaya-tracked-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    git(root, ['worktree', 'add', '-q', wtRoot, '-b', 'task/demo/1'])
    try {
      // The worktree checkout carries its own tracked copy…
      expect(existsSync(join(wtRoot, TRACKED_HOOK_DIR, 'pre-commit'))).toBe(true)
      // …and sees the shared (common-config) arming — no per-worktree step.
      expect(git(wtRoot, ['config', '--get', 'core.hooksPath'])).toBe(TRACKED_HOOK_DIR)

      // git actually FIRES the worktree's own copy: overwrite it with a
      // sentinel that must block, then commit from the worktree.
      writeFileSync(join(wtRoot, TRACKED_HOOK_DIR, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
      writeFileSync(join(wtRoot, 'file.txt'), 'x\n')
      git(wtRoot, ['add', 'file.txt'])
      expect(() => git(wtRoot, ['commit', '-q', '-m', 'Chore: must be blocked'])).toThrow()

      const report = await doctorJson(realishDoctorDeps(() => wtRoot))
      const routing = report.findings.find((f) => f.check === 'hooks' && f.message.includes('core.hooksPath'))
      expect(routing?.severity).toBe('ok')
    } finally {
      git(root, ['worktree', 'remove', '--force', wtRoot])
    }
  }, 20_000)
})

// ---------------------------------------------------------------------------
// upgrade — the sanctioned migration path off .git/hooks
// ---------------------------------------------------------------------------
describe('upgrade migrates a legacy .git/hooks install', () => {
  async function legacyInstall(): Promise<void> {
    gitInit(root)
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial commit'])
    await captureStdout(async () =>
      runInit(
        ['--yes'],
        realishInitDeps(() => root, { hookDirFor: () => '.git/hooks' })
      )
    )
  }

  it('moves vinaya-created hooks to the tracked dir, strips the legacy hosts, arms the config, rewrites the manifest', async () => {
    await legacyInstall()
    expect(existsSync(join(root, '.git/hooks/pre-commit'))).toBe(true)
    expect(readCoreHooksPath(root)).resolves.toBeNull()

    let rc = -1
    const out = await captureStdout(async () => {
      rc = await runUpgrade(
        ['--yes'],
        realishUpgradeDeps(() => root)
      )
    })
    expect(rc).toBe(0)
    expect(out).toContain('Hook location')
    expect(out).toContain(`arm       git config core.hooksPath ${TRACKED_HOOK_DIR}`)

    // Tracked copies exist; legacy vinaya-created hosts are gone.
    expect(readFileSync(join(root, TRACKED_HOOK_DIR, 'pre-commit'), 'utf-8')).toContain('vinaya:managed:pre-commit')
    expect(readFileSync(join(root, TRACKED_HOOK_DIR, 'pre-push'), 'utf-8')).toContain('vinaya:managed:pre-push')
    expect(readFileSync(join(root, TRACKED_HOOK_DIR, 'commit-msg'), 'utf-8')).toContain('vinaya:managed:commit-msg')
    expect(existsSync(join(root, '.git/hooks/pre-commit'))).toBe(false)
    expect(existsSync(join(root, '.git/hooks/pre-push'))).toBe(false)
    expect(existsSync(join(root, '.git/hooks/commit-msg'))).toBe(false)
    expect(git(root, ['config', '--get', 'core.hooksPath'])).toBe(TRACKED_HOOK_DIR)
    expect(readManifest(root).blocks.map((b) => b.path)).toEqual([
      `${TRACKED_HOOK_DIR}/pre-commit`,
      `${TRACKED_HOOK_DIR}/pre-push`,
      `${TRACKED_HOOK_DIR}/commit-msg`,
      CLAUDE_STOP_HOOK_SCRIPT_PATH
    ])
  }, 20_000)

  it('REFUSES the migration when arming would disable adopter hooks — their lines in a host, or an unmanaged raw hook', async () => {
    await legacyInstall()
    // The adopter appended their own line to the shared pre-commit host.
    const host = join(root, '.git/hooks/pre-commit')
    writeFileSync(host, `${readFileSync(host, 'utf-8')}\necho my-own-step\n`, { mode: 0o755 })

    let rc = -1
    const out = await captureStdout(async () => {
      rc = await runUpgrade(
        ['--yes'],
        realishUpgradeDeps(() => root)
      )
    })
    expect(rc).toBe(0)
    expect(out).toContain('migration to .vinaya/hooks skipped')
    // Nothing moved, nothing armed, manifest untouched.
    expect(existsSync(join(root, TRACKED_HOOK_DIR, 'pre-commit'))).toBe(false)
    expect(readFileSync(host, 'utf-8')).toContain('echo my-own-step')
    expect(await readCoreHooksPath(root)).toBeNull()
    expect(readManifest(root).blocks.map((b) => b.path)).toEqual([
      '.git/hooks/pre-commit',
      '.git/hooks/pre-push',
      '.git/hooks/commit-msg',
      CLAUDE_STOP_HOOK_SCRIPT_PATH
    ])

    // Same refusal for an unmanaged raw hook elsewhere in .git/hooks.
    writeFileSync(host, readFileSync(host, 'utf-8').replace('\necho my-own-step\n', ''), { mode: 0o755 })
    writeFileSync(join(root, '.git/hooks/post-checkout'), '#!/bin/sh\necho theirs\n', { mode: 0o755 })
    const out2 = await captureStdout(async () =>
      runUpgrade(
        ['--yes'],
        realishUpgradeDeps(() => root)
      )
    )
    expect(out2).toContain('.git/hooks/post-checkout is an active raw hook vinaya does not manage')
    expect(existsSync(join(root, TRACKED_HOOK_DIR, 'pre-commit'))).toBe(false)
  }, 20_000)

  it('on an already-migrated manifest, re-arms an unarmed clone and sweeps stale legacy blocks (the post-merge machine shape)', async () => {
    await legacyInstall()
    await captureStdout(async () =>
      runUpgrade(
        ['--yes'],
        realishUpgradeDeps(() => root)
      )
    ) // migrate for real

    // Simulate the machine that merged the migration commit but never ran it:
    // manifest + tracked hooks present, config unarmed, stale legacy block back.
    await unsetCoreHooksPath(root)
    const tracked = readFileSync(join(root, TRACKED_HOOK_DIR, 'pre-commit'), 'utf-8')
    writeFileSync(join(root, '.git/hooks/pre-commit'), tracked, { mode: 0o755 })

    let rc = -1
    await captureStdout(async () => {
      rc = await runUpgrade(
        ['--yes'],
        realishUpgradeDeps(() => root)
      )
    })
    expect(rc).toBe(0)
    expect(git(root, ['config', '--get', 'core.hooksPath'])).toBe(TRACKED_HOOK_DIR)
    expect(existsSync(join(root, '.git/hooks/pre-commit'))).toBe(false)
    expect(existsSync(join(root, TRACKED_HOOK_DIR, 'pre-commit'))).toBe(true)
  }, 20_000)

  it('the post-merge arm guard: on an already-migrated manifest, refuses to arm while a foreign raw hook would be disabled — then arms once it is gone', async () => {
    // The round-1 reviewer's reproduction: machine A has its own active raw
    // hook; machine B (which cannot see it — raw hooks never travel with a
    // clone) migrates and merges. A pulls and runs upgrade — arming must
    // refuse exactly like the migration branch would have on A.
    await legacyInstall()
    await captureStdout(async () =>
      runUpgrade(
        ['--yes'],
        realishUpgradeDeps(() => root)
      )
    ) // migrate (machine B's act)
    await unsetCoreHooksPath(root) // machine A's clone state: manifest tracked, config unarmed
    writeFileSync(join(root, '.git/hooks/post-checkout'), '#!/bin/sh\necho theirs\n', { mode: 0o755 })
    // ...plus a stale vinaya-only legacy host, which must NOT block the arm
    // by itself (the sweep removes it) but must still be swept this run.
    const tracked = readFileSync(join(root, TRACKED_HOOK_DIR, 'pre-commit'), 'utf-8')
    writeFileSync(join(root, '.git/hooks/pre-commit'), tracked, { mode: 0o755 })

    let rc = -1
    const out = await captureStdout(async () => {
      rc = await runUpgrade(
        ['--yes'],
        realishUpgradeDeps(() => root)
      )
    })
    expect(rc).toBe(0)
    expect(out).toContain('NOT armed')
    expect(out).toContain('.git/hooks/post-checkout')
    // Refused the arm; adopter's hook untouched and still firing; sweep still ran.
    expect(await readCoreHooksPath(root)).toBeNull()
    expect(readFileSync(join(root, '.git/hooks/post-checkout'), 'utf-8')).toContain('echo theirs')
    expect(existsSync(join(root, '.git/hooks/pre-commit'))).toBe(false)

    // doctor must not hand out the arming command either — it names the hook
    // arming would disable.
    const report = await doctorJson(realishDoctorDeps(() => root))
    const inert = report.findings.find((f) => f.check === 'hooks' && f.severity === 'error')
    expect(inert?.message).toContain('arming it would silently disable .git/hooks/post-checkout')

    // Adopter resolves (removes their hook) — the very next upgrade arms.
    rmSync(join(root, '.git/hooks/post-checkout'))
    await captureStdout(async () =>
      runUpgrade(
        ['--yes'],
        realishUpgradeDeps(() => root)
      )
    )
    expect(git(root, ['config', '--get', 'core.hooksPath'])).toBe(TRACKED_HOOK_DIR)
  }, 20_000)
})

// ---------------------------------------------------------------------------
// translateHookPaths — pure mapping
// ---------------------------------------------------------------------------
describe('translateHookPaths', () => {
  it('rewrites only .git/hooks/ block paths', () => {
    const manifest: ManagedManifest = {
      version: 2,
      files: ['VINAYA.md'],
      blocks: [
        { path: '.git/hooks/pre-commit', marker: 'pre-commit', comment: 'hash' },
        { path: '.husky/pre-push', marker: 'pre-push', comment: 'hash' }
      ],
      labels: []
    }
    expect(translateHookPaths(manifest).blocks.map((b) => b.path)).toEqual([
      `${TRACKED_HOOK_DIR}/pre-commit`,
      '.husky/pre-push'
    ])
  })
})

// ---------------------------------------------------------------------------
// eject — the inverse includes un-arming
// ---------------------------------------------------------------------------
describe('eject of a tracked-hooks install', () => {
  it('removes the tracked hooks and unsets core.hooksPath — but leaves a re-pointed value alone', async () => {
    gitInit(root)
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial commit'])
    await captureStdout(async () =>
      runInit(
        ['--yes'],
        realishInitDeps(() => root)
      )
    )
    expect(git(root, ['config', '--get', 'core.hooksPath'])).toBe(TRACKED_HOOK_DIR)

    let rc = -1
    const out = await captureStdout(async () => {
      rc = await runEject(
        ['--yes'],
        realishEjectDeps(() => root)
      )
    })
    expect(rc).toBe(0)
    expect(out).toContain('unset core.hooksPath')
    expect(existsSync(join(root, TRACKED_HOOK_DIR, 'pre-commit'))).toBe(false)
    expect(existsSync(join(root, TRACKED_HOOK_DIR, 'pre-push'))).toBe(false)
    expect(existsSync(join(root, TRACKED_HOOK_DIR, 'commit-msg'))).toBe(false)
    expect(await readCoreHooksPath(root)).toBeNull()
  }, 20_000)
})
