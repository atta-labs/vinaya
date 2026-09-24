import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resetResolveRepoCache } from '../../../packages/aeg-forge-state/src/resolve-repo'
import {
  FALLBACK_PORT,
  parsePortFlag,
  PortFlagError,
  PRIMARY_PORT,
  resolveStudioTarget,
  runStudio
} from '../src/commands/studio.js'

describe('resolveStudioTarget', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = join(tmpdir(), `vinaya-studio-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('finds the workspace web dir from a nested cwd', () => {
    const webDir = join(tmpDir, 'apps', 'vinaya-studio', 'web')
    mkdirSync(webDir, { recursive: true })
    writeFileSync(join(webDir, 'package.json'), JSON.stringify({ name: '@atta/vinaya-studio-web' }))

    const nestedCwd = join(tmpDir, 'apps', 'vinaya', 'cli', 'src', 'commands')
    mkdirSync(nestedCwd, { recursive: true })

    const target = resolveStudioTarget(nestedCwd)

    expect(target.kind).toBe('workspace')
    if (target.kind === 'workspace') {
      expect(realpathSync(target.webDir)).toBe(realpathSync(webDir))
    }
  })

  it('returns missing when no workspace root is above cwd and no bundle at the (fake) install root', () => {
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'fake-pkg-no-bundle' }))
    const fakeModuleUrl = pathToFileURL(join(tmpDir, 'dist', 'index.js')).href

    const target = resolveStudioTarget(tmpDir, fakeModuleUrl)

    expect(target).toEqual({ kind: 'missing' })
  })

  it('finds the bundled standalone build relative to the installed package root', () => {
    const fakeInstallRoot = join(tmpDir, 'node_modules', '@attalabs', 'vinaya')
    const standaloneWebDir = join(fakeInstallRoot, 'studio-standalone', 'apps', 'vinaya-studio', 'web')
    mkdirSync(standaloneWebDir, { recursive: true })
    writeFileSync(join(fakeInstallRoot, 'package.json'), JSON.stringify({ name: '@attalabs/vinaya' }))
    writeFileSync(join(standaloneWebDir, 'server.js'), '// fixture\n')

    const fakeModuleUrl = pathToFileURL(join(fakeInstallRoot, 'dist', 'index.js')).href
    const target = resolveStudioTarget(tmpDir, fakeModuleUrl)

    expect(target.kind).toBe('package')
    if (target.kind === 'package') {
      expect(realpathSync(target.packageDir)).toBe(realpathSync(standaloneWebDir))
    }
  })

  it('does not resolve a workspace planted above the enclosing git repository', () => {
    // Security review, PR #94 finding 3: the upward walk must stop at the
    // enclosing repo's root. A planted `apps/vinaya-studio/web` in an ancestor
    // OUTSIDE the repo the user is standing in (e.g. a world-writable /tmp)
    // must never resolve — the workspace branch executes the resolved
    // directory's own dev script, so resolving it is code execution.
    const plantedWebDir = join(tmpDir, 'apps', 'vinaya-studio', 'web')
    mkdirSync(plantedWebDir, { recursive: true })
    writeFileSync(join(plantedWebDir, 'package.json'), JSON.stringify({ name: '@atta/vinaya-studio-web' }))

    const innerRepo = join(tmpDir, 'inner-repo')
    const nestedCwd = join(innerRepo, 'deep', 'dir')
    mkdirSync(nestedCwd, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: innerRepo })

    const fakeModuleUrl = pathToFileURL(join(tmpDir, 'dist', 'index.js')).href
    const target = resolveStudioTarget(nestedCwd, fakeModuleUrl)

    expect(target).toEqual({ kind: 'missing' })
  })

  it('still resolves a workspace whose root carries both .git and apps/vinaya-studio/web', () => {
    const repoRoot = join(tmpDir, 'monorepo')
    const webDir = join(repoRoot, 'apps', 'vinaya-studio', 'web')
    mkdirSync(webDir, { recursive: true })
    writeFileSync(join(webDir, 'package.json'), JSON.stringify({ name: '@atta/vinaya-studio-web' }))
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot })

    const nestedCwd = join(repoRoot, 'apps', 'vinaya', 'cli')
    mkdirSync(nestedCwd, { recursive: true })

    const target = resolveStudioTarget(nestedCwd)

    expect(target.kind).toBe('workspace')
    if (target.kind === 'workspace') {
      expect(realpathSync(target.webDir)).toBe(realpathSync(webDir))
    }
  })

  it('returns missing when the installed package root has no studio-standalone bundle', () => {
    const fakeInstallRoot = join(tmpDir, 'node_modules', '@attalabs', 'vinaya')
    mkdirSync(fakeInstallRoot, { recursive: true })
    writeFileSync(join(fakeInstallRoot, 'package.json'), JSON.stringify({ name: '@attalabs/vinaya' }))

    const fakeModuleUrl = pathToFileURL(join(fakeInstallRoot, 'dist', 'index.js')).href
    const target = resolveStudioTarget(tmpDir, fakeModuleUrl)

    expect(target).toEqual({ kind: 'missing' })
  })
})

describe('runStudio', () => {
  let tmpDir: string
  // `resolveRepo()` (`@attalabs/aeg-forge-state`) honors an explicit
  // `AEG_REPO` env value AHEAD of any git-remote derivation, by design — an
  // operator-set repo always wins. The AEG_REPO-derivation test below asserts
  // the git-remote path specifically, so it must run with AEG_REPO unset, or
  // an ambient value silently short-circuits the very derivation it checks and
  // the assertion reads that ambient value back. A CI runner that exports
  // AEG_REPO into the test process (as this repo's own CI now does) made the
  // test fail for exactly that reason while it passed on a developer box with
  // no such var; stripping it here makes the test hermetic either way, the
  // same guard `packages/aeg-forge-state/src/resolve-repo.test.ts` already
  // applies to its own AEG_REPO-sensitive cases.
  let savedAegRepo: string | undefined

  beforeEach(() => {
    resetResolveRepoCache()
    tmpDir = join(tmpdir(), `vinaya-studio-run-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    mkdirSync(tmpDir, { recursive: true })
    savedAegRepo = process.env.AEG_REPO
    delete process.env.AEG_REPO
    // `resolveRepo()` caches at module scope and returns that cache BEFORE it
    // reads the env (`resolve-repo.ts`), so deleting AEG_REPO above is not
    // enough on its own: `bun test` runs a whole shard's files in ONE process,
    // and an earlier shard-3 file that called `resolveRepo()` (with the CI
    // runner's own AEG_REPO set, or against the CI checkout's own origin)
    // leaves the cache holding a value the derivation test below would read
    // back instead of the guest repo it set up. Clearing the cache here makes
    // this file's derivation assertion independent of whatever ran before it
    // in the same process — the poisoning the file's own header comment (the
    // "latent footgun if that ever changes") warned about, now realised by CI
    // exporting AEG_REPO into the test process.
    resetResolveRepoCache()
  })

  afterEach(() => {
    resetResolveRepoCache()
    rmSync(tmpDir, { recursive: true, force: true })
    if (savedAegRepo === undefined) delete process.env.AEG_REPO
    else process.env.AEG_REPO = savedAegRepo
    // Leave no poisoned cache behind for a later file in the same shard run.
    resetResolveRepoCache()
  })

  it('names the install and returns 1 when the target is missing', async () => {
    writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'fake-pkg-no-bundle' }))
    const fakeModuleUrl = pathToFileURL(join(tmpDir, 'dist', 'index.js')).href

    const errorSpy = mock((..._args: unknown[]) => {})
    const originalError = console.error
    console.error = errorSpy

    try {
      const code = await runStudio(tmpDir, [], fakeModuleUrl)
      expect(code).toBe(1)
      expect(errorSpy).toHaveBeenCalledTimes(1)
      expect(errorSpy.mock.calls[0]?.[0]).toContain('@attalabs/vinaya')
    } finally {
      console.error = originalError
    }
  })

  // Security review, PR #855, Finding 2 (MINOR): `resolveRepo()` (from
  // `@attalabs/aeg-forge-state`) caches its result at MODULE scope for the
  // process lifetime, by that module's own design — correct for a real CLI
  // invocation (one `studio` command per process), but any OTHER caller of
  // the shared `resolveRepo()` that runs earlier in this same `bun test`
  // process would poison the two tests below via that cache, silently. This
  // file is currently the only in-process (non-spawned-subprocess) caller
  // of `resolveRepo()` in the `apps/vinaya/cli` test run — a latent footgun
  // if that ever changes, not an active bug.
  it('spawns the bundled server.js with the CALLER cwd and a derived AEG_REPO, not the package dir', async () => {
    const fakeInstallRoot = join(tmpDir, 'node_modules', '@attalabs', 'vinaya')
    const standaloneWebDir = join(fakeInstallRoot, 'studio-standalone', 'apps', 'vinaya-studio', 'web')
    mkdirSync(standaloneWebDir, { recursive: true })
    writeFileSync(join(fakeInstallRoot, 'package.json'), JSON.stringify({ name: '@attalabs/vinaya' }))

    // A REAL git repo with a REAL origin remote — this is the regression
    // case: Next's generated server.js does `process.chdir(__dirname)` as
    // its own first line, so by the time app code reads `process.cwd()` for
    // its own `git remote get-url origin` call, it's back on the installed
    // package (not a git repo at all) rather than this guest repo. Without
    // studio.ts resolving AEG_REPO here — BEFORE that chdir happens — and
    // forcing it into the child's env, the chdir would silently break the
    // exact "your repo's real tranches/board" promise this task exists for.
    const guestRepo = join(tmpDir, 'guest-repo')
    mkdirSync(guestRepo, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: guestRepo })
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/fixture-owner/fixture-repo.git'], {
      cwd: guestRepo
    })

    const cwdProofFile = join(tmpDir, 'cwd-proof.txt')
    // A fake server.js: proves what cwd/env it was actually spawned with,
    // then exits with a recognizable non-zero code — no real Next server
    // needed to test the spawn contract itself.
    writeFileSync(
      join(standaloneWebDir, 'server.js'),
      `require('fs').writeFileSync(${JSON.stringify(cwdProofFile)}, JSON.stringify({ cwd: process.cwd(), port: process.env.PORT, aegRepo: process.env.AEG_REPO, hostname: process.env.HOSTNAME }))\nprocess.exit(42)\n`
    )

    const fakeModuleUrl = pathToFileURL(join(fakeInstallRoot, 'dist', 'index.js')).href
    const code = await runStudio(guestRepo, [], fakeModuleUrl)

    expect(code).toBe(42)
    const proof = JSON.parse(readFileSync(cwdProofFile, 'utf-8'))
    expect(realpathSync(proof.cwd)).toBe(realpathSync(guestRepo))
    expect(proof.aegRepo).toBe('fixture-owner/fixture-repo')
    // Security review, PR #855: the bundled server.js binds
    // process.env.HOSTNAME || '0.0.0.0' — unset, it's reachable by anything
    // on the local network. Loopback-only must be the default.
    expect(proof.hostname).toBe('127.0.0.1')
    // 3008 unless something else on the machine already holds it, in which
    // case the same fallback dev.ts already relies on kicks in — either is
    // a correct result, not just an acceptable one.
    expect(['3008', '3108']).toContain(proof.port)
  })

  it('preserves an operator-set HOSTNAME instead of forcing loopback', async () => {
    const fakeInstallRoot = join(tmpDir, 'node_modules', '@attalabs', 'vinaya')
    const standaloneWebDir = join(fakeInstallRoot, 'studio-standalone', 'apps', 'vinaya-studio', 'web')
    mkdirSync(standaloneWebDir, { recursive: true })
    writeFileSync(join(fakeInstallRoot, 'package.json'), JSON.stringify({ name: '@attalabs/vinaya' }))

    const guestRepo = join(tmpDir, 'guest-repo')
    mkdirSync(guestRepo, { recursive: true })

    const hostnameProofFile = join(tmpDir, 'hostname-proof.txt')
    writeFileSync(
      join(standaloneWebDir, 'server.js'),
      `require('fs').writeFileSync(${JSON.stringify(hostnameProofFile)}, process.env.HOSTNAME || '')\nprocess.exit(0)\n`
    )

    const fakeModuleUrl = pathToFileURL(join(fakeInstallRoot, 'dist', 'index.js')).href
    const originalHostname = process.env.HOSTNAME
    process.env.HOSTNAME = '0.0.0.0'
    try {
      const code = await runStudio(guestRepo, [], fakeModuleUrl)
      expect(code).toBe(0)
      expect(readFileSync(hostnameProofFile, 'utf-8')).toBe('0.0.0.0')
    } finally {
      if (originalHostname === undefined) {
        delete process.env.HOSTNAME
      } else {
        process.env.HOSTNAME = originalHostname
      }
    }
  })
})

describe('vinaya studio --port', () => {
  it('parses an explicit port, in both spellings', () => {
    expect(parsePortFlag(['--port', '3208'])).toBe(3208)
    // `--port=3208` returning null would bind the DEFAULT port — the exact
    // collision the flag exists to prevent, reached silently (review, PR #185).
    expect(parsePortFlag(['--port=3208'])).toBe(3208)
  })

  it('refuses two different ports rather than silently picking one', () => {
    expect(() => parsePortFlag(['--port', '3208', '--port', '4000'])).toThrow(PortFlagError)
    expect(() => parsePortFlag(['--port=3208', '--port=4000'])).toThrow(PortFlagError)
    // The same value twice is not ambiguous, so it is not an error.
    expect(parsePortFlag(['--port', '3208', '--port=3208'])).toBe(3208)
  })

  it('refuses a leading zero instead of normalising a probable typo', () => {
    expect(() => parsePortFlag(['--port', '03208'])).toThrow(PortFlagError)
    expect(() => parsePortFlag(['--port=03208'])).toThrow(PortFlagError)
  })

  it('refuses an empty value in the = spelling', () => {
    expect(() => parsePortFlag(['--port='])).toThrow(PortFlagError)
  })

  it('returns null when the flag is absent — the default 3008/3108 dance still applies', () => {
    expect(parsePortFlag([])).toBeNull()
    expect(parsePortFlag(['--something', 'else'])).toBeNull()
  })

  it('refuses a missing, non-numeric, or out-of-range value rather than binding something unintended', () => {
    expect(() => parsePortFlag(['--port'])).toThrow(PortFlagError)
    expect(() => parsePortFlag(['--port', '--other'])).toThrow(PortFlagError)
    expect(() => parsePortFlag(['--port', 'abc'])).toThrow(PortFlagError)
    expect(() => parsePortFlag(['--port', '0'])).toThrow(PortFlagError)
    expect(() => parsePortFlag(['--port', '70000'])).toThrow(PortFlagError)
  })

  // The whole reason the flag exists: this repo's `dev:vinaya-studio` must not
  // land on the port attalabs' Studio dev server already owns. Measured live —
  // with one server on `*:3008` and one on `127.0.0.1:3008`, a 200 from
  // `/studio` proved nothing about which process served it.
  it('the root dev script pins a port rather than relying on the fallback', () => {
    const root = JSON.parse(readFileSync(join(import.meta.dirname, '../../../package.json'), 'utf8'))
    const script = root.scripts['dev:vinaya-studio'] as string
    expect(script).toContain('--port')
    const pinned = parsePortFlag(script.split(/\s+/))
    expect(pinned).not.toBeNull()
    expect(pinned).not.toBe(PRIMARY_PORT)
    expect(pinned).not.toBe(FALLBACK_PORT)
  })
})
