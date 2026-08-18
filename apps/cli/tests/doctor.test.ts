import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import type { DoctorDeps, Finding } from '../src/commands/doctor.js'
import { runDoctor } from '../src/commands/doctor.js'
import type { InitDeps } from '../src/commands/init.js'
import { runInit } from '../src/commands/init.js'
import { DOC_OWNERS_PATH } from '@attalabs/aeg-core'
import { CHECKS_WORKFLOW_PATH, CONFIG_PATH, DOCTRINE_POINTER_PATH } from '../src/lib/artifacts.js'
import type { LabelGateway } from '../src/lib/ops.js'

let root: string

function initDeps(overrides: Partial<InitDeps> = {}): InitDeps {
  const labels: LabelGateway = {
    async exists() {
      return false
    },
    async create() {}
  }
  return {
    detectRepo: async () => ({ repoRoot: root, owner: 'acme', repo: 'widget' }),
    checkGhAuth: async () => true,
    labelGateway: () => labels,
    hookDirFor: () => '.husky',
    customHooksPath: async () => null,
    setHooksPath: async () => {},
    confirm: async () => true,
    ...overrides
  }
}

function doctorDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    detectRepo: async () => ({ repoRoot: root, owner: 'acme', repo: 'widget' }),
    ghAuthStatus: async () => ({ authenticated: true, detail: 'Logged in to github.com as tester' }),
    branchProtectionConfigured: async () => null,
    hookDirFor: () => '.husky',
    readHooksPath: async () => null,
    nodeVersion: () => 'v99.0.0',
    bunVersion: () => 'test-bun',
    packageVersion: () => '0.1.0-test',
    ...overrides
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

/**
 * Recursive snapshot of the fixture tree: relative path → content. Skips
 * `.git` — a git-backed fixture's object/pack files are binary and huge
 * relative to the fixture itself; nothing under `.git` is a doctor mutation
 * target, so it's outside what this comparison needs to prove.
 */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === '.git') continue
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.set(relative(dir, p), readFileSync(p, 'utf-8'))
    }
  }
  walk(dir)
  return out
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

async function runDoctorJson(overrides: Partial<DoctorDeps> = {}): Promise<{ healthy: boolean; findings: Finding[] }> {
  const original = process.stdout.write.bind(process.stdout)
  let buf = ''
  process.stdout.write = ((chunk: string) => {
    buf += chunk
    return true
  }) as typeof process.stdout.write
  try {
    await runDoctor(['--json'], doctorDeps(overrides))
  } finally {
    process.stdout.write = original
  }
  return JSON.parse(buf).data
}

beforeEach(() => {
  root = join(tmpdir(), `vinaya-doctor-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'README.md'), '# widget\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('vinaya doctor — never mutates', () => {
  it('reports healthy on a clean install, and the tree is byte-identical before and after', async () => {
    await runInit(['--yes'], initDeps())
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(true)
    expect(report.findings.every((f) => f.severity === 'ok' || f.severity === 'info')).toBe(true)

    expect(snapshot(root)).toEqual(before)
  })

  it('exits 0 on a healthy repo and 1 when findings exist', async () => {
    await runInit(['--yes'], initDeps())
    let rc = -1
    let out = ''
    out = await captureStdout(async () => {
      rc = await runDoctor([], doctorDeps())
    })
    expect(rc).toBe(0)
    expect(out).toContain('Healthy')

    rmSync(join(root, '.husky/pre-commit'))
    out = await captureStdout(async () => {
      rc = await runDoctor([], doctorDeps())
    })
    expect(rc).toBe(1)
    expect(out).toContain('hooks')
  })

  it('flags a deleted hook without recreating it', async () => {
    await runInit(['--yes'], initDeps())
    rmSync(join(root, '.husky/pre-commit'))
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'hooks' && f.message.includes('pre-commit'))
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toContain('missing')

    expect(snapshot(root)).toEqual(before) // doctor fixed nothing
  })

  it('flags a corrupted managed block (markers stripped) without fixing it', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, '.husky/pre-push'), '#!/usr/bin/env sh\necho not-a-vinaya-hook-anymore\n')
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'hooks' && f.message.includes('pre-push'))
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toMatch(/missing or corrupted/)

    expect(snapshot(root)).toEqual(before)
  })

  it('flags a broken vinaya.config.json (invalid JSON) without fixing it', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, CONFIG_PATH), '{ this is not json')
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'config')
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toContain('invalid')

    expect(snapshot(root)).toEqual(before)
  })

  it('flags a removed workflow without recreating it', async () => {
    await runInit(['--yes'], initDeps())
    rmSync(join(root, CHECKS_WORKFLOW_PATH))
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'workflows' && f.message.includes(CHECKS_WORKFLOW_PATH))
    expect(hit?.severity).toBe('error')

    expect(snapshot(root)).toEqual(before)
  })

  it('flags a drifted workflow (content differs from the current generator) without fixing it', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, CHECKS_WORKFLOW_PATH), 'name: hand-edited\n')
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'workflows' && f.message.includes(CHECKS_WORKFLOW_PATH))
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('drifted')

    expect(snapshot(root)).toEqual(before)
  })

  it('does not flag .vinaya/doc-owners as drifted once a real binding is added (found live: was recommending `vinaya upgrade`, which would have wiped it)', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, DOC_OWNERS_PATH), 'apps/foo/src/**  apps/foo/specs/foo.md\n', { flag: 'a' })

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.message.includes(DOC_OWNERS_PATH))
    expect(hit?.severity).toBe('ok')
    expect(hit?.message).not.toContain('drift')
  })

  it('flags a dropped manifest entry (file present on disk, absent from `managed.files`)', async () => {
    await runInit(['--yes'], initDeps())
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.managed.files = cfg.managed.files.filter((f: string) => f !== DOCTRINE_POINTER_PATH)
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'doctrine-pointer' && f.message.includes("isn't recorded"))
    expect(hit?.severity).toBe('warn')

    expect(snapshot(root)).toEqual(before)
  })

  it('flags a custom check pointing at a missing script', async () => {
    await runInit(['--yes'], initDeps())
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.checks = { ghost: { run: 'scripts/vinaya-checks/ghost.ts', scope: 'full' } }
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'checks')
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toContain('ghost')

    expect(snapshot(root)).toEqual(before)
  })

  // The execution flip removed these two from `vinaya check`'s own output —
  // a rejected config now refuses the run outright. They must SURVIVE here,
  // permanently: doctor is the only surface left that can explain why a run
  // that executes nothing executes nothing.
  it('still surfaces the bare-key rejection on a config `vinaya check` now refuses outright', async () => {
    await runInit(['--yes'], initDeps())
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.checks = { my_check: { run: 'scripts/vinaya-checks/my_check.ts', scope: 'full' } }
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)
    mkdirSync(join(root, 'scripts', 'vinaya-checks'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'vinaya-checks', 'my_check.ts'), '#!/usr/bin/env bun\n')
    const before = snapshot(root)

    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    const hit = report.findings.find((f) => f.check === 'checks' && f.message.includes('REJECTED'))
    expect(hit).toBeDefined()
    // `error`, not `warn`: post-flip this is fatal to every `vinaya check`.
    expect(hit?.severity).toBe('error')
    expect(hit?.message).toContain('my_check')
    expect(hit?.message).toContain('prefixing alone is not enough')

    expect(snapshot(root)).toEqual(before)
  })

  it('still surfaces the override diagnostic, now stating the core check is replaced', async () => {
    await runInit(['--yes'], initDeps())
    const cfg = JSON.parse(readFileSync(join(root, CONFIG_PATH), 'utf-8'))
    cfg.checks = { 'doc-coverage': { run: 'scripts/vinaya-checks/mine.ts', scope: 'full' } }
    writeFileSync(join(root, CONFIG_PATH), `${JSON.stringify(cfg, null, 2)}\n`)
    mkdirSync(join(root, 'scripts', 'vinaya-checks'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'vinaya-checks', 'mine.ts'), '#!/usr/bin/env bun\n')

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'checks' && f.message.includes('REPLACES'))
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('doc-coverage')
    expect(hit?.message).toContain('The core check does not run')
  })

  it('reports "not initialized" on a repo that never ran init, and still writes nothing', async () => {
    const before = snapshot(root)
    const report = await runDoctorJson()
    expect(report.healthy).toBe(false)
    expect(report.findings.some((f) => f.check === 'install')).toBe(true)
    expect(snapshot(root)).toEqual(before)
  })

  it('refuses on a non-git-repo', async () => {
    let rc = -1
    await captureStdout(async () => {
      rc = await runDoctor([], doctorDeps({ detectRepo: async () => null }))
    })
    expect(rc).toBe(1)
  })

  it('silence when a workflow invokes the test script', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'widget', scripts: { test: 'turbo test' } }))
    writeFileSync(join(root, '.github/workflows/ci.yml'), 'jobs:\n  test:\n    steps:\n      - run: bunx turbo test\n')

    const report = await runDoctorJson()
    expect(report.findings.some((f) => f.check === 'test-ci')).toBe(false)
  })

  it('flags no workflow invoking the test script', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'widget', scripts: { test: 'turbo test' } }))
    const before = snapshot(root)

    const report = await runDoctorJson()
    const hit = report.findings.find((f) => f.check === 'test-ci')
    expect(hit).toBeDefined()
    expect(hit?.severity).toBe('warn')
    expect(hit?.message).toContain('Test Plan')

    expect(snapshot(root)).toEqual(before)
  })

  it('does not flag a repo with no scripts.test at all', async () => {
    await runInit(['--yes'], initDeps())
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'widget', scripts: { build: 'tsc' } }))

    const report = await runDoctorJson()
    expect(report.findings.some((f) => f.check === 'test-ci')).toBe(false)
  })

  it('does not let environment/branch-protection info findings affect health', async () => {
    await runInit(['--yes'], initDeps())
    const report = await runDoctorJson({
      ghAuthStatus: async () => ({ authenticated: false, detail: 'not logged in' }),
      branchProtectionConfigured: async () => false
    })
    // gh-not-authenticated is a warn (findings, not healthy) but branch
    // protection unconfigured is info-only — assert the two are distinguished.
    const auth = report.findings.find((f) => f.check === 'environment' && f.message.startsWith('gh:'))
    const bp = report.findings.find((f) => f.check === 'branch-protection')
    expect(auth?.severity).toBe('warn')
    expect(bp?.severity).toBe('info')
  })
})

// Regression coverage for a real hooks false-negative found live: `roles/developer.md`
// requires every Developer to work in a linked git worktree, and in one a bare
// `join(repoRoot, '.git/hooks/pre-commit')` never resolves — `.git` there is a
// FILE (a gitdir pointer), not a directory — even though the hooks are present
// and firing correctly (they are never per-worktree; every linked worktree
// shares the main checkout's hooks). Doctor reported both hooks "missing" and
// recommended `vinaya upgrade`, which would not have fixed anything.
describe('vinaya doctor — raw git hooks inside a linked worktree', () => {
  it('reports installed .git/hooks as present and matching, probed from a linked worktree', async () => {
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    git(root, ['add', 'README.md'])
    git(root, ['commit', '-q', '-m', 'Chore: initial commit'])

    await runInit(['--yes'], initDeps({ hookDirFor: () => '.git/hooks' }))
    git(root, ['add', '-A'])
    // --no-verify: this commit's only job is to land the files `runInit` just
    // wrote (doctor compares their on-disk bytes against the generator, so the
    // real hook content must survive untouched — no local-fixture swap here,
    // unlike quickstart.test.ts). Running the real hook for real would shell
    // to `npx --yes @attalabs/vinaya@<this workspace's current package.json
    // version>`, which is network-dependent and fails outright whenever that
    // version isn't published yet (e.g. mid-bump, exactly the state this repo
    // is in right now) — orthogonal to what this test actually verifies.
    git(root, ['commit', '-q', '-m', 'Chore: install Vinaya', '--no-verify'])

    const wtRoot = join(tmpdir(), `vinaya-doctor-wt-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    git(root, ['worktree', 'add', wtRoot, '-b', 'task/demo/1'])

    try {
      const report = await runDoctorJson({
        detectRepo: async () => ({ repoRoot: wtRoot, owner: 'acme', repo: 'widget' }),
        hookDirFor: () => '.git/hooks'
      })
      const hookFindings = report.findings.filter((f) => f.check === 'hooks')
      expect(hookFindings.length).toBeGreaterThan(0)
      expect(hookFindings.some((f) => f.message.includes('is missing'))).toBe(false)
      // Every file-level finding is ok; the ONE non-ok is the deliberate
      // clone-gap routing warn a `.git/hooks` install now always carries
      // (atta-labs/attalabs#927) — git never tracks `.git/hooks`, so this
      // install shape leaves every fresh clone without ring 0.
      const nonOk = hookFindings.filter((f) => f.severity !== 'ok')
      expect(nonOk.length).toBe(1)
      expect(nonOk[0]?.severity).toBe('warn')
      expect(nonOk[0]?.message).toContain('which git does not track')
    } finally {
      git(root, ['worktree', 'remove', '--force', wtRoot])
    }
  }, 20_000) // real `runInit` + two `git commit`s + `worktree add` — bun's 5s default is too tight on a cold CI runner
})

// Regression coverage for Issue #77: C5 (`evaluateC5`) only ever tests a
// binding's glob against the current PR's changed files, so a binding whose
// code was deleted or renamed wholesale never fires on any diff again — it
// reads as healthy forever. These tests need a REAL git-tracked-file list
// (the diagnostic shells to `git ls-files`), so — unlike the rest of this
// file — the fixture must be a real `git init` + `git add` + `git commit`
// tree, not the plain tmpdir the other describe blocks use. A plain,
// non-git tmpdir makes `git ls-files` fail outright (not a git repository),
// which would make every binding in a plain-tmpdir fixture falsely report
// "matches zero files" — a test that can never fail.
describe('vinaya doctor — doc-owners binding health', () => {
  function writeTracked(relPath: string, content: string): void {
    const abs = join(root, relPath)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }

  async function initAndCommit(docOwnersContent: string, extraFiles: Record<string, string>): Promise<void> {
    git(root, ['init', '-q', '-b', 'main'])
    git(root, ['config', 'user.email', 'test@example.com'])
    git(root, ['config', 'user.name', 'Test'])
    await runInit(['--yes'], initDeps())
    writeTracked(DOC_OWNERS_PATH, docOwnersContent)
    for (const [relPath, content] of Object.entries(extraFiles)) writeTracked(relPath, content)
    git(root, ['add', '-A'])
    git(root, ['commit', '-q', '-m', 'Chore: fixture', '--no-verify'])
  }

  it('measured shape + negative control: a glob naming a deleted tree warns; a live glob in the same manifest does not', async () => {
    const docOwners = ['apps/deleted-tool/src/**  docs/deleted-tool.md', 'apps/live/src/**  docs/live.md'].join('\n')
    await initAndCommit(docOwners, {
      'docs/deleted-tool.md': '# deleted tool\n',
      'apps/live/src/index.ts': 'export {}\n',
      'docs/live.md': '# live\n'
    })

    const report = await runDoctorJson()
    const docOwnersFindings = report.findings.filter((f) => f.check === 'doc-owners')

    const dead = docOwnersFindings.find((f) => f.message.includes(`${DOC_OWNERS_PATH}:1`))
    expect(dead?.severity).toBe('warn')
    expect(dead?.message).toContain('apps/deleted-tool/src/**')
    expect(dead?.message).toContain('matches none of')

    const live = docOwnersFindings.find((f) => f.message.includes(`${DOC_OWNERS_PATH}:2`))
    expect(live?.severity).toBe('ok')
  })

  it('dangling pointer is independent of the glob-match check: a live glob with a missing pointer fires only the pointer warning', async () => {
    await initAndCommit('apps/live2/src/**  docs/missing.md\n', {
      'apps/live2/src/index.ts': 'export {}\n'
    })

    const report = await runDoctorJson()
    const docOwnersFindings = report.findings.filter((f) => f.check === 'doc-owners')

    expect(docOwnersFindings.some((f) => f.message.includes('matches none of'))).toBe(false)
    const dangling = docOwnersFindings.find((f) => f.message.includes('docs/missing.md'))
    expect(dangling?.severity).toBe('warn')
    expect(dangling?.message).toContain('does not exist on disk')
  })

  it('a URL pointer never trips the dangling-pointer check, even when its glob matches nothing', async () => {
    await initAndCommit('apps/deleted-tool2/src/**  https://example.com/docs\n', {})

    const report = await runDoctorJson()
    const docOwnersFindings = report.findings.filter((f) => f.check === 'doc-owners')

    const dead = docOwnersFindings.find((f) => f.message.includes('apps/deleted-tool2/src/**'))
    expect(dead?.severity).toBe('warn')
    expect(dead?.message).toContain('matches none of')
    expect(docOwnersFindings.some((f) => f.message.includes('does not exist on disk'))).toBe(false)
  })

  it('dormancy: no .vinaya/doc-owners, and separately an empty one, produce zero doc-owners findings', async () => {
    await runInit(['--yes'], initDeps())
    rmSync(join(root, DOC_OWNERS_PATH))

    let report = await runDoctorJson()
    expect(report.findings.filter((f) => f.check === 'doc-owners')).toEqual([])

    writeFileSync(join(root, DOC_OWNERS_PATH), '')
    report = await runDoctorJson()
    expect(report.findings.filter((f) => f.check === 'doc-owners')).toEqual([])
  })

  it('never mutates: fixture tree is byte-identical before and after runDoctor runs this diagnostic', async () => {
    await initAndCommit('apps/deleted-tool3/src/**  docs/deleted-tool3.md\n', {
      'docs/deleted-tool3.md': '# deleted tool 3\n'
    })
    const before = snapshot(root)

    await runDoctorJson()

    expect(snapshot(root)).toEqual(before)
  })
})
