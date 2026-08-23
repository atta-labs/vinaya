import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LabelGateway, Op } from '../src/lib/ops.js'
import {
  applyEject,
  applyInstall,
  containedAbs,
  containedManagedBlockAbs,
  planEject,
  planInstall,
  renderInstallDiff
} from '../src/lib/ops.js'
import type { ManagedManifest } from '../src/lib/config.js'

function scratch(): string {
  const dir = join(tmpdir(), `vinaya-ops-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

const noLabels: LabelGateway = {
  async exists() {
    return true // "already exists" → never created, never recorded
  },
  async create() {}
}

const recordingLabels = (created: string[]): LabelGateway => ({
  async exists() {
    return false
  },
  async create(name) {
    created.push(name)
  }
})

const ops: Op[] = [
  { kind: 'create-file', path: '.github/workflows/vinaya-checks.yml', content: 'name: checks\n', group: 'wf' },
  {
    kind: 'managed-block',
    path: '.husky/pre-commit',
    marker: 'pre-commit',
    body: 'vinaya check --all --diff-only',
    comment: 'hash',
    hostPreamble: '#!/usr/bin/env sh\n',
    mode: 0o755,
    group: 'hooks'
  },
  { kind: 'create-label', name: 'vinaya/tier:0', color: 'ededed', description: 'trivial', group: 'labels' }
]

describe('planInstall', () => {
  it('classifies fresh create/create-host on an empty repo', () => {
    const root = scratch()
    const plan = planInstall(ops, root)
    const create = plan.entries.find((e) => e.kind === 'create-file')
    const block = plan.entries.find((e) => e.kind === 'managed-block')
    expect(create?.kind === 'create-file' && create.action).toBe('create')
    expect(block?.kind === 'managed-block' && block.action).toBe('create-host')
    expect(plan.hasRefusals).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses to overwrite foreign content at a create-file path', () => {
    const root = scratch()
    mkdirSync(join(root, '.github/workflows'), { recursive: true })
    writeFileSync(join(root, '.github/workflows/vinaya-checks.yml'), 'name: someone-elses\n')
    const plan = planInstall(ops, root)
    const create = plan.entries.find((e) => e.kind === 'create-file')
    expect(create?.kind === 'create-file' && create.action).toBe('refuse-foreign')
    expect(plan.hasRefusals).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('appends a managed block to a pre-existing adopter hook instead of clobbering', () => {
    const root = scratch()
    mkdirSync(join(root, '.husky'), { recursive: true })
    writeFileSync(join(root, '.husky/pre-commit'), '#!/usr/bin/env sh\nnpm test\n')
    const plan = planInstall(ops, root)
    const block = plan.entries.find((e) => e.kind === 'managed-block')
    expect(block?.kind === 'managed-block' && block.action).toBe('append')
    rmSync(root, { recursive: true, force: true })
  })
})

describe('applyInstall → dry-run equals install', () => {
  it('writes exactly the content the diff shows', async () => {
    const root = scratch()
    const plan = planInstall(ops, root)
    const diff = renderInstallDiff(plan)
    await applyInstall(plan, root, noLabels)
    const written = readFileSync(join(root, '.github/workflows/vinaya-checks.yml'), 'utf-8')
    expect(written).toBe('name: checks\n')
    // The diff the user would confirm contained that exact content.
    expect(diff).toContain('name: checks')
    rmSync(root, { recursive: true, force: true })
  })

  it('records created labels in the manifest, skips existing ones', async () => {
    const root = scratch()
    const created: string[] = []
    const plan = planInstall(ops, root)
    const manifest = await applyInstall(plan, root, recordingLabels(created))
    expect(created).toEqual(['vinaya/tier:0'])
    expect(manifest.labels).toEqual(['vinaya/tier:0'])
    rmSync(root, { recursive: true, force: true })
  })
})

describe('eject round-trip', () => {
  it('deletes vinaya-created files and reports labels, never deletes them', async () => {
    const root = scratch()
    const plan = planInstall(ops, root)
    const manifest = await applyInstall(plan, root, noLabels)
    manifest.labels = ['vinaya/tier:0'] // as if created

    const ejectPlan = planEject(manifest, root)
    const { removedLabelsToReport } = applyEject(ejectPlan, root)

    expect(existsSync(join(root, '.github/workflows/vinaya-checks.yml'))).toBe(false)
    expect(removedLabelsToReport).toEqual(['vinaya/tier:0'])
    rmSync(root, { recursive: true, force: true })
  })

  it('strips only the managed block, keeping the adopter hook + their lines', async () => {
    const root = scratch()
    mkdirSync(join(root, '.husky'), { recursive: true })
    const adopterHook = '#!/usr/bin/env sh\nnpm test\n'
    writeFileSync(join(root, '.husky/pre-commit'), adopterHook)

    const plan = planInstall(ops, root)
    const manifest = await applyInstall(plan, root, noLabels)

    // block appended; adopter lines still present
    const afterInstall = readFileSync(join(root, '.husky/pre-commit'), 'utf-8')
    expect(afterInstall).toContain('npm test')
    expect(afterInstall).toContain('vinaya:managed:pre-commit')

    applyEject(planEject(manifest, root), root)

    const afterEject = readFileSync(join(root, '.husky/pre-commit'), 'utf-8')
    expect(afterEject).toContain('npm test')
    expect(afterEject).not.toContain('vinaya:managed')
    expect(existsSync(join(root, '.husky/pre-commit'))).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('deletes a vinaya-CREATED hook host entirely on eject', async () => {
    const root = scratch()
    const plan = planInstall(ops, root) // no pre-existing hook → create-host
    const manifest = await applyInstall(plan, root, noLabels)
    expect(existsSync(join(root, '.husky/pre-commit'))).toBe(true)

    applyEject(planEject(manifest, root), root)
    // vinaya created the host (shebang + block only) → removed whole
    expect(existsSync(join(root, '.husky/pre-commit'))).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })
})

describe('planEject on a corrupt/missing manifest is caller-guarded', () => {
  it('produces no destructive action for empty records', () => {
    const empty: ManagedManifest = { version: 1, files: [], blocks: [], labels: [] }
    const plan = planEject(empty, scratch())
    expect(plan.actions).toEqual([])
    expect(plan.escapes).toEqual([])
  })
})

describe('path-traversal containment (a whole file eject deletes stays inside the repo)', () => {
  it('containedAbs rejects `..`, absolute paths, and the repo root itself', () => {
    const root = scratch()
    expect(containedAbs(root, 'a/b.txt')).toBe(join(root, 'a/b.txt'))
    expect(containedAbs(root, '../OUTSIDE.txt')).toBeNull()
    expect(containedAbs(root, 'a/../../OUTSIDE.txt')).toBeNull()
    expect(containedAbs(root, '/etc/passwd')).toBeNull()
    expect(containedAbs(root, '.')).toBeNull() // the root itself
    rmSync(root, { recursive: true, force: true })
  })

  it('planEject flags an escaping manifest path and emits no delete action for it', () => {
    const root = scratch()
    const hostile: ManagedManifest = { version: 1, files: ['../OUTSIDE.txt', 'inside.txt'], blocks: [], labels: [] }
    const plan = planEject(hostile, root)
    expect(plan.escapes).toContain('../OUTSIDE.txt')
    expect(plan.actions.some((a) => a.kind === 'delete-file' && a.path === '../OUTSIDE.txt')).toBe(false)
    expect(plan.actions.some((a) => a.kind === 'delete-file' && a.path === 'inside.txt')).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it('applyEject never deletes an escaping path even if one reaches the action list', () => {
    const parent = scratch()
    const root = join(parent, 'repo')
    mkdirSync(root, { recursive: true })
    const outside = join(parent, 'OUTSIDE.txt')
    writeFileSync(outside, 'do not delete me')
    // Hand-craft an action list with an escaping delete (belt-and-suspenders).
    applyEject({ actions: [{ kind: 'delete-file', path: '../OUTSIDE.txt', present: true }], escapes: [] }, root)
    expect(existsSync(outside)).toBe(true)
    rmSync(parent, { recursive: true, force: true })
  })
})

describe('containedManagedBlockAbs — per-kind bounds for a managed block (#68)', () => {
  function gitRepo(): string {
    const root = scratch()
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    return root
  }

  it('delegates a non-`.git/` path to containedAbs unchanged', () => {
    const root = gitRepo()
    expect(containedManagedBlockAbs(root, '.husky/pre-commit')).toBe(join(root, '.husky/pre-commit'))
    expect(containedManagedBlockAbs(root, '../OUTSIDE')).toBeNull()
    expect(containedManagedBlockAbs(root, '/etc/passwd')).toBeNull()
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves a `.git/hooks/*` path into the git common dir', () => {
    const root = gitRepo()
    expect(containedManagedBlockAbs(root, '.git/hooks/pre-commit')).toBe(join(root, '.git/hooks/pre-commit'))
    rmSync(root, { recursive: true, force: true })
  })

  // Strictly TIGHTER than the old repoRoot rule: in a primary checkout
  // `<repoRoot>/.git` IS the common dir, so these were previously "contained".
  // No managed block has any business outside `hooks/`.
  it('refuses a `.git/` path outside the hooks subtree, and the hooks dir itself', () => {
    const root = gitRepo()
    expect(containedManagedBlockAbs(root, '.git/config')).toBeNull()
    expect(containedManagedBlockAbs(root, '.git/objects/ab/cdef')).toBeNull()
    expect(containedManagedBlockAbs(root, '.git/hooks')).toBeNull()
    rmSync(root, { recursive: true, force: true })
  })

  it('refuses a traversal that climbs back out of the hooks subtree', () => {
    const root = gitRepo()
    expect(containedManagedBlockAbs(root, '.git/hooks/../../../OUTSIDE')).toBeNull()
    expect(containedManagedBlockAbs(root, '.git/hooks/../config')).toBeNull()
    rmSync(root, { recursive: true, force: true })
  })

  // The whole point of the fix: from a linked worktree the hook's real home is
  // the MAIN checkout's shared hooks dir, legitimately outside `repoRoot`.
  it('resolves to the shared common dir from a linked worktree, where containedAbs answers a worktree-local phantom', () => {
    const root = gitRepo()
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
    writeFileSync(join(root, 'README.md'), '# x\n')
    execFileSync('git', ['add', 'README.md'], { cwd: root })
    execFileSync('git', ['commit', '-q', '-m', 'Chore: initial commit'], { cwd: root })
    const wt = `${root}-wt`
    execFileSync('git', ['worktree', 'add', '-q', wt, '-b', 'task/demo/1'], { cwd: root })

    try {
      // `realpathSync` on the expectation only: `git rev-parse
      // --git-common-dir` answers with a fully resolved path, and on macOS
      // the tmpdir is a `/var` -> `/private/var` symlink. Nothing in the
      // product compares across that boundary — `target` and `hooksRoot` both
      // come from `gitCommonDir`, so they agree in whichever form git used —
      // but the test's own `root` is the unresolved form.
      expect(containedManagedBlockAbs(wt, '.git/hooks/pre-commit')).toBe(
        join(realpathSync(join(root, '.git/hooks')), 'pre-commit')
      )
      // The old rule, for contrast: it answers with a path inside the
      // WORKTREE, where no hook has ever lived — the worktree's `.git` is a
      // gitlink file. Resolving there is what silently skipped the strip and
      // left an active hook behind in the shared dir.
      expect(containedAbs(wt, '.git/hooks/pre-commit')).toBe(join(wt, '.git/hooks/pre-commit'))
      expect(containedManagedBlockAbs(wt, '.git/hooks/pre-commit')).not.toBe(join(wt, '.git/hooks/pre-commit'))
    } finally {
      execFileSync('git', ['worktree', 'remove', '--force', wt], { cwd: root })
      rmSync(wt, { recursive: true, force: true })
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('containedManagedBlockAbs resolves the common dir exactly once', () => {
  /**
   * Pins the BLOCKER the code review on PR #175 disproved with a `git` shim.
   *
   * An earlier revision let the target and the bound each call `gitCommonDir`
   * independently. They share the same *code*, which is not the same as
   * sharing the same *answer*: a shim that succeeds on the first call and
   * fails on the second puts them on opposite sides of the fallback, and a
   * valid hook in a linked worktree then resolves outside its own hooks root
   * and reads as an escape. It fails closed — nothing wrong is deleted — but
   * `eject` tells the adopter their manifest is corrupt when it is not.
   *
   * Counting spawns is the assertion because the property IS "one call".
   * Asserting only on the returned path would keep passing the moment someone
   * reintroduces a second call, which is exactly how this shipped.
   *
   * It runs in a CHILD process because mutating `process.env.PATH` in-process
   * does not change how Bun resolves `execFileSync('git', …)` — measured: a
   * shim first on the mutated PATH is never reached. The child gets the shim
   * through its own spawn `env`, which does take effect.
   */
  it('spawns `git rev-parse --git-common-dir` once per call, not once per half', () => {
    // `mkdtempSync`, not `scratch()`: this writes an EXECUTABLE `git` and puts
    // it first on a child's PATH, so a predictable directory name on a shared
    // `/tmp` would be a plant-and-win. Matches the discipline
    // `tests/checks/body-bare-digits-changeset-exempt.test.ts` already uses.
    const root = mkdtempSync(join(tmpdir(), 'vinaya-ops-shim-'))
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })

      const shimDir = join(root, 'shim')
      const log = join(root, 'calls.log')
      mkdirSync(shimDir)
      const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
      // Both interpolations are quoted inside the script: they are
      // `mkdtempSync`/`command -v` output, not attacker input, but an unquoted
      // path in a generated shell script is a habit worth not having.
      writeFileSync(
        join(shimDir, 'git'),
        `#!/bin/sh\ncase " $* " in *" rev-parse "*) echo call >> "${log}" ;; esac\nexec "${realGit}" "$@"\n`
      )
      execFileSync('chmod', ['755', join(shimDir, 'git')])

      const probe = join(root, 'probe.ts')
      const modulePath = join(import.meta.dirname, '../src/lib/ops.ts')
      writeFileSync(
        probe,
        `import { containedManagedBlockAbs } from ${JSON.stringify(modulePath)}\n` +
          `containedManagedBlockAbs(${JSON.stringify(root)}, '.git/hooks/pre-commit')\n`
      )

      // PATH is set on THIS spawn's env only — `process.env` is never mutated,
      // so the shim cannot leak into a sibling test or the parent process.
      execFileSync(process.execPath, [probe], {
        cwd: root,
        env: { ...process.env, PATH: `${shimDir}:${process.env.PATH ?? ''}` }
      })

      const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).length : 0
      // The shim must actually be reachable, or `0` would "pass" a broken probe.
      expect(calls).toBeGreaterThan(0)
      expect(calls).toBe(1)
    } finally {
      // `finally`, so an assertion failure still removes the executable shim.
      rmSync(root, { recursive: true, force: true })
    }
  })
})
