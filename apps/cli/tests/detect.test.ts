import { describe, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InitDeps } from '../src/commands/init.js'
import { runInit } from '../src/commands/init.js'
import {
  branchProtectionConfigured,
  checkGhAuth,
  classifyBranchProtectionError,
  customHooksPath,
  detectGitRepo,
  ghAuthStatus
} from '../src/lib/detect.js'
import type { LabelGateway } from '../src/lib/ops.js'

// `gh api repos/<owner>/<repo>/branches/main/protection` exits non-zero for
// three genuinely different reasons — only two of them are KNOWN, real
// answers (unprotected / plan-required); everything else is truly unknown.
// Pulled into its own pure function (`lib/detect.ts`) specifically so this is
// testable without shelling out to a real `gh` — see that file's doc comment
// for the live incident this fixes (a private repo without a paid GitHub
// plan reported "could not be determined" in the same doctor run that had
// just reported gh as authenticated and the remote as present).
describe('classifyBranchProtectionError', () => {
  it('classifies a 404 as unprotected (false) — a real, known answer', () => {
    expect(classifyBranchProtectionError('gh: Branch not protected (HTTP 404)')).toBe(false)
  })

  it('classifies the GitHub-Pro-required 403 as plan-required, not the generic unknown', () => {
    const stderr = 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)'
    expect(classifyBranchProtectionError(stderr)).toBe('plan-required')
  })

  it('recognizes the alternate GitHub phrasing (make this repository public)', () => {
    const stderr = 'gh: Upgrade to a paid plan or make this repository public to use this endpoint. (HTTP 403)'
    expect(classifyBranchProtectionError(stderr)).toBe('plan-required')
  })

  it('does not widen the 403 branch to swallow a real permission failure (stays unknown, not "unprotected"\'s sibling)', () => {
    expect(classifyBranchProtectionError('gh: Resource not accessible by integration (HTTP 403)')).toBeNull()
  })

  it('classifies an unrelated auth/network failure as unknown (null)', () => {
    expect(classifyBranchProtectionError('gh: authentication required')).toBeNull()
  })

  it('classifies empty stderr as unknown (null)', () => {
    expect(classifyBranchProtectionError('')).toBeNull()
  })
})

// `detectGitRepo`, `checkGhAuth`, `ghAuthStatus`, and `branchProtectionConfigured`
// have no dependency-injection seam — they shell out to `git`/`gh` via a
// module-scope `execFileAsync` bound once at import time (see that file's own
// top comment). Faking them at the module level (`mock.module('node:child_process', ...)`)
// was tried and rejected: `execFileAsync = promisify(execFile)` captures a
// concrete function reference the moment `detect.ts` is first evaluated, and
// several OTHER command modules import `detectGitRepo` for their own default
// deps, so whichever test file's module graph resolves first wins that
// binding — a bun-process-wide race, not a per-file guarantee. Faking at the
// PATH boundary instead — a real, tiny, executable `git`/`gh` stand-in placed
// ahead of the real one on `$PATH` — is deterministic per test, requires no
// module mocking, and cannot leak into other test files' real subprocess
// calls (audit's `execFileSync` calls, doctor's real git fixtures, etc.)
// since it is scoped to `process.env.PATH` for exactly the `try` block below
// and restored in every `finally`.
function withFakeBin<T>(name: string, script: string, fn: () => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), `vinaya-fakebin-${name}-`))
  const file = join(dir, name)
  writeFileSync(file, `#!/usr/bin/env bash\n${script}\n`)
  chmodSync(file, 0o755)
  const originalPath = process.env.PATH
  process.env.PATH = `${dir}:${originalPath}`
  return fn().finally(() => {
    process.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  })
}

describe('detectGitRepo', () => {
  it('returns null outside a git repository', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-not-a-repo-'))
    const originalCwd = process.cwd()
    try {
      process.chdir(dir)
      expect(await detectGitRepo()).toBeNull()
    } finally {
      process.chdir(originalCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns a populated RepoInfo — repoRoot plus owner/repo parsed from a GitHub origin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-real-repo-'))
    const originalCwd = process.cwd()
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:acme/widget.git'], { cwd: dir })
      process.chdir(dir)
      const info = await detectGitRepo()
      // Compare against git's OWN answer, not the mkdtemp string — macOS
      // resolves `/tmp` through a symlink and git reports the resolved path.
      const expectedRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir }).toString().trim()
      expect(info).toEqual({ repoRoot: expectedRoot, owner: 'acme', repo: 'widget' })
    } finally {
      process.chdir(originalCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves owner/repo blank when the origin remote is not a github.com URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-non-github-'))
    const originalCwd = process.cwd()
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      execFileSync('git', ['remote', 'add', 'origin', 'https://gitlab.com/acme/widget.git'], { cwd: dir })
      process.chdir(dir)
      const info = await detectGitRepo()
      expect(info?.owner).toBe('')
      expect(info?.repo).toBe('')
    } finally {
      process.chdir(originalCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves owner/repo blank when there is no origin remote at all — init still works locally', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-no-origin-'))
    const originalCwd = process.cwd()
    try {
      execFileSync('git', ['init', '-q'], { cwd: dir })
      process.chdir(dir)
      const info = await detectGitRepo()
      expect(info?.owner).toBe('')
      expect(info?.repo).toBe('')
    } finally {
      process.chdir(originalCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('checkGhAuth', () => {
  it('returns true when `gh auth status` exits zero', async () => {
    await withFakeBin('gh', 'exit 0', async () => {
      expect(await checkGhAuth()).toBe(true)
    })
  })

  it('returns false when `gh auth status` exits non-zero', async () => {
    await withFakeBin('gh', 'exit 1', async () => {
      expect(await checkGhAuth()).toBe(false)
    })
  })

  it('returns false when `gh` is entirely absent from PATH (no real gh login needed to run this suite)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-no-gh-'))
    const originalPath = process.env.PATH
    process.env.PATH = dir
    try {
      expect(await checkGhAuth()).toBe(false)
    } finally {
      process.env.PATH = originalPath
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ghAuthStatus', () => {
  it("reports authenticated, with gh's own stderr text as the detail, on success", async () => {
    await withFakeBin('gh', 'echo "Logged in to github.com as tester" 1>&2\nexit 0', async () => {
      const status = await ghAuthStatus()
      expect(status.authenticated).toBe(true)
      expect(status.detail).toContain('Logged in to github.com as tester')
    })
  })

  it("reports not authenticated, with gh's own stderr text as the detail, on failure", async () => {
    await withFakeBin('gh', 'echo "You are not logged into any GitHub hosts" 1>&2\nexit 1', async () => {
      const status = await ghAuthStatus()
      expect(status.authenticated).toBe(false)
      expect(status.detail).toContain('You are not logged into any GitHub hosts')
    })
  })
})

describe('branchProtectionConfigured', () => {
  it('returns null immediately when owner or repo is blank — no subprocess call at all', async () => {
    expect(await branchProtectionConfigured('', '')).toBeNull()
    expect(await branchProtectionConfigured('acme', '')).toBeNull()
    expect(await branchProtectionConfigured('', 'widget')).toBeNull()
  })

  it('returns true when the branch-protection API call succeeds', async () => {
    await withFakeBin('gh', "echo '{}'\nexit 0", async () => {
      expect(await branchProtectionConfigured('acme', 'widget')).toBe(true)
    })
  })

  it('returns false on a 404 (branch genuinely not protected)', async () => {
    await withFakeBin('gh', 'echo "gh: Branch not protected (HTTP 404)" 1>&2\nexit 1', async () => {
      expect(await branchProtectionConfigured('acme', 'widget')).toBe(false)
    })
  })

  it("returns 'plan-required' on the GitHub-Pro-required 403, not the generic unknown", async () => {
    await withFakeBin(
      'gh',
      'echo "gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)" 1>&2\nexit 1',
      async () => {
        expect(await branchProtectionConfigured('acme', 'widget')).toBe('plan-required')
      }
    )
  })

  it('returns null on an unrecognized failure (auth/network)', async () => {
    await withFakeBin('gh', 'echo "gh: authentication required" 1>&2\nexit 1', async () => {
      expect(await branchProtectionConfigured('acme', 'widget')).toBeNull()
    })
  })
})

// #397 round 2 (F1): `.vinaya/hooks` is `upgrade`'s own tracked-hooks value
// (`TRACKED_HOOK_DIR`) — `init` must not refuse a repo that already carries
// it as `core.hooksPath`, or a repo `upgrade` has already migrated could
// never re-run `init`. Never covered by a real git repo before this test:
// `init.test.ts`'s own custom-hooksPath coverage injects `customHooksPath`
// as a mock and never exercises this function's real git-backed logic.
describe('customHooksPath — .vinaya/hooks is not a custom path (#397 round 2)', () => {
  function realRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'vinaya-customhookspath-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
    return dir
  }

  it('returns null for .vinaya/hooks — the value `upgrade` itself sets', async () => {
    const dir = realRepo()
    try {
      execFileSync('git', ['config', 'core.hooksPath', '.vinaya/hooks'], { cwd: dir })
      expect(await customHooksPath(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still returns null for .husky and .husky/_ (unchanged)', async () => {
    const dir = realRepo()
    try {
      execFileSync('git', ['config', 'core.hooksPath', '.husky'], { cwd: dir })
      expect(await customHooksPath(dir)).toBeNull()
      execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: dir })
      expect(await customHooksPath(dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still refuses a genuinely non-standard core.hooksPath', async () => {
    const dir = realRepo()
    try {
      execFileSync('git', ['config', 'core.hooksPath', '.config/hooks'], { cwd: dir })
      expect(await customHooksPath(dir)).toBe('.config/hooks')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a repo with core.hooksPath=.vinaya/hooks runs `init` without the refusal', async () => {
    const dir = realRepo()
    try {
      execFileSync('git', ['config', 'core.hooksPath', '.vinaya/hooks'], { cwd: dir })
      const labels: LabelGateway = {
        async exists() {
          return false
        },
        async create() {}
      }
      const deps: InitDeps = {
        detectRepo: async () => ({ repoRoot: dir, owner: '', repo: '' }),
        checkGhAuth: async () => true,
        labelGateway: () => labels,
        hookDirFor: () => '.husky',
        customHooksPath,
        setHooksPath: async () => {},
        confirm: async () => true
      }
      const original = process.stdout.write.bind(process.stdout)
      process.stdout.write = (() => true) as typeof process.stdout.write
      let rc: number
      try {
        rc = await runInit(['--yes'], deps)
      } finally {
        process.stdout.write = original
      }
      expect(rc).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
