import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

// Task `vinaya-adopter-portability-v1` 2 (Issue #232): `reader-resolvable-prose`
// and `retired-vocabulary` both defaulted an unconfigured `proseGates.doctrineRoot`
// to the bare literal `'aeg-root'`, resolved relative to the caller's cwd —
// permanently empty for every `vinaya init` adopter, none of whom ever gets a
// repo-relative `aeg-root/` (settled by experiment). The fix changes only the
// UNCONFIGURED default, via `resolveDoctrineRoot()` (`../commands/doctrine.js`
// — the same "package's own copy" resolution `vinaya doctrine` already uses).
// An explicit `proseGates.doctrineRoot` in `vinaya.config.json` must still win
// outright — this suite proves that priority holds.

const READER_BIN = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-reader-resolvable-prose.ts')
const RETIRED_BIN = join(import.meta.dir, '..', '..', 'src', 'checks', 'bin', 'check-retired-vocabulary.ts')
const INDEX_TS = join(import.meta.dir, '..', '..', 'src', 'index.ts')

function initFixture(name: string): string {
  const root = join(tmpdir(), `vinaya-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(root, { recursive: true })
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
  writeFileSync(join(root, 'README.md'), '# fixture\n')
  execFileSync('git', ['add', 'README.md'], { cwd: root })
  execFileSync('git', ['commit', '-q', '-m', 'Chore: initial commit'], { cwd: root })
  return root
}

describe('reader-resolvable-prose/retired-vocabulary doctrineRoot default — task vinaya-adopter-portability-v1 2', () => {
  it('both bins call resolveDoctrineRoot() as the unconfigured fallback, not a bare cwd-relative literal', () => {
    for (const bin of [READER_BIN, RETIRED_BIN]) {
      const source = readFileSync(bin, 'utf8')
      expect(source).toContain('resolveDoctrineRoot()')
      expect(source).not.toContain("proseGates?.doctrineRoot ?? 'aeg-root'")
      expect(source).not.toContain("loadConfig()?.proseGates?.doctrineRoot ?? 'aeg-root'")
    }
  })

  it('an explicit proseGates.doctrineRoot in vinaya.config.json still wins over resolveDoctrineRoot() — configured beats the package default', () => {
    const root = initFixture('prose-gates-config-wins')
    try {
      mkdirSync(join(root, 'configured-doctrine', 'roles'), { recursive: true })
      writeFileSync(
        join(root, 'configured-doctrine', 'glossary.md'),
        '## Glossary\n\n**Widget** — a fixture term, defined right here.\n'
      )
      writeFileSync(
        join(root, 'configured-doctrine', 'roles', 'x.md'),
        '---\nrole_id: x\n---\nThis page uses Widget correctly, since it is defined in the glossary.\n'
      )
      writeFileSync(
        join(root, 'vinaya.config.json'),
        JSON.stringify({ checks: {}, proseGates: { doctrineRoot: 'configured-doctrine' } }, null, 2)
      )
      execFileSync('git', ['add', '-A'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Chore: add fixture doctrine'], { cwd: root })

      const result = Bun.spawnSync(['bun', INDEX_TS, 'check', 'reader-resolvable-prose'], {
        cwd: root,
        env: { ...process.env, PR_BODY: undefined }
      })
      expect(result.exitCode).toBe(0)
      // Positive proof it read the CONFIGURED root, not the package default:
      // a finding (if any) would name a path under `configured-doctrine/`,
      // never this monorepo's own `aeg-root/`.
      expect(result.stderr.toString()).not.toContain('/aeg-root/')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// Code review, PR #290 MINOR (round 2): `tests/diff-evidence.test.ts`
// unit-tests `resolveChangedFiles()` in isolation, but nothing exercised the
// two real consumers (`check-reader-resolvable-prose.ts`/
// `check-retired-vocabulary.ts`) end-to-end against a fixture with a genuine
// doctrine finding. This suite spawns each real bin against one — BOTH
// consumers (code review, round 3: the first version of this suite only
// covered `retired-vocabulary`, leaving `reader-resolvable-prose` — which
// carries the identical `repoRoot()`/diff-scoping pattern — asymmetrically
// untested for diff-scoped filtering specifically).
//
// A relative `proseGates.doctrineRoot`, invoked from a SUBDIRECTORY, was
// also tried here and deliberately dropped: it does not exercise this PR's
// fix at all. `collect(DOCTRINE_ROOT)` — unchanged by this PR, pre-existing —
// calls plain `readdirSync(DOCTRINE_ROOT)` on the raw config string with no
// anchoring whatsoever, so a relative `doctrineRoot` finds nothing from a
// subdirectory regardless of `repoRoot()`-anchored comparison; the sweep
// itself is empty before comparison ever runs. This PR's `repoRoot()`
// anchoring closes the gap on the COMPARISON side only, which is what it
// set out to fix — the collection side is a separate, pre-existing defect,
// out of scope here the same way `check-doc-coverage.ts`'s own fail-open
// class was flagged out of scope for this PR by the code-reviewer pass.
for (const check of [
  {
    name: 'retired-vocabulary',
    // A real, deterministic `RETIRED_PATTERNS` hit (`@attalabs/aeg-core`'s
    // retired decision-id format, `D` dash three digits) — not a guessed
    // heuristic. Built via concatenation, not a literal in this file's own
    // source: `packages/aeg-core/src/retired-vocabulary.test.ts`'s own
    // repo-wide meta-check (`PRODUCT = ['.']`, deliberately unscoped —
    // see that file's own module doc for why an enumerated exemption list
    // is the exact blind-spot shape it exists to avoid) bans that literal
    // string appearing ANYWHERE in this repo's tracked source, including
    // this test file's own comments and string literals — found live when
    // this fixture's first version shipped it as a plain literal and broke
    // Vinaya CI, a suite this branch's own `bun test` (scoped to `apps/cli`
    // only) never runs.
    mention: `See D-${100 + 23} for the historical rationale.\n`,
    // The message states the offending pattern's SOURCE regex, not a
    // literal echo of the matched substring.
    findingContains: ['retired-vocabulary', 'retired AEG mechanism']
  },
  {
    name: 'reader-resolvable-prose',
    /** `#123`-shaped — a real, deterministic `FORGE_NUMBER_PATTERN` hit (`checkUnresolvableReferences`, `@attalabs/aeg-core`), not a guessed heuristic. */
    mention: 'See #123 for the historical rationale.\n',
    findingContains: ['reader-resolvable-prose', 'a forge number']
  }
] as const) {
  describe(`${check.name} — diff-scoped filtering, end to end, with a relative doctrineRoot (PR #290 review)`, () => {
    function fixtureWithRelativeDoctrineRoot(name: string): string {
      const root = initFixture(name)
      writeFileSync(
        join(root, 'vinaya.config.json'),
        JSON.stringify({ checks: {}, proseGates: { doctrineRoot: 'docs' } }, null, 2)
      )
      mkdirSync(join(root, 'docs'), { recursive: true })
      writeFileSync(join(root, 'docs', 'unrelated.md'), '# Nothing to flag here\n')
      execFileSync('git', ['add', '-A'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Chore: base doctrine, no findings'], { cwd: root })
      execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root })
      return root
    }

    function run(cwd: string): { exitCode: number; stderr: string } {
      const result = Bun.spawnSync(['bun', INDEX_TS, 'check', check.name], {
        cwd,
        env: { ...process.env, BASE_SHA: 'main', PR_BODY: undefined }
      })
      return { exitCode: result.exitCode, stderr: result.stderr.toString() }
    }

    it('a touched doctrine file with a real finding is reported, from the repo root', () => {
      const root = fixtureWithRelativeDoctrineRoot(`${check.name}-e2e-root`)
      try {
        writeFileSync(join(root, 'docs', 'note.md'), check.mention)
        execFileSync('git', ['add', '-A'], { cwd: root })
        execFileSync('git', ['commit', '-q', '-m', 'Docs: add a note with a real finding'], { cwd: root })

        const { exitCode, stderr } = run(root)
        expect(exitCode).toBe(0) // report-only — never fails CI
        expect(stderr).toContain('docs/note.md')
        for (const fragment of check.findingContains) expect(stderr).toContain(fragment)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    // Named for what it actually proves (code review, round 3: the prior
    // name/comment here claimed this discriminates the `repoRoot()` reuse
    // fix specifically — it doesn't. `DOCTRINE_ROOT` on this path is already
    // absolute via `resolveDoctrineRoot()`, so `resolve(pathBase, f.file)`
    // and the pre-fix `resolve(f.file)` are identical for every finding
    // regardless of `pathBase` — reverting the fix and re-running this test
    // still passes, confirmed by the round-3 reviewer. Discriminating the
    // fix itself needs a RELATIVE `finding.file`, which requires a relative
    // `doctrineRoot` — and that combination is blocked by the separate,
    // out-of-scope `collect()` cwd-relative bug documented above.
    // `tests/diff-evidence.test.ts`'s own cwd-independence test is the one
    // that genuinely discriminates `resolveChangedFiles()`'s `repoRoot()`
    // fix. What THIS test proves instead: real, valuable, just different —
    // invoking the installed/unconfigured shape from a subdirectory doesn't
    // crash and produces byte-identical output to invoking it from the repo
    // root, for the path every real adopter install actually takes.
    it('subdirectory invocation is a safe no-op for the unconfigured/default doctrineRoot shape: identical output either way', () => {
      const root = initFixture(`${check.name}-e2e-subdir-no-crash`)
      execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root })
      writeFileSync(join(root, 'b.md'), '# b\n')
      execFileSync('git', ['add', '-A'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Chore: add b'], { cwd: root })

      const subdir = join(root, 'some', 'nested', 'dir')
      mkdirSync(subdir, { recursive: true })

      try {
        const fromRoot = run(root)
        const fromSubdir = run(subdir)
        expect(fromRoot.exitCode).toBe(0)
        expect(fromSubdir.exitCode).toBe(fromRoot.exitCode)
        expect(fromSubdir.stderr).toBe(fromRoot.stderr)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })

    it('a diff that never touches the doctrine root reports nothing, even though a real backlog exists elsewhere in it', () => {
      // Deliberately does NOT use `fixtureWithRelativeDoctrineRoot` — the
      // backlog finding needs to live in the BASE commit itself (present,
      // unchanged, on both `main` and `feature`) so the sweep genuinely
      // finds it on disk while diff-scoping still excludes it, rather than
      // a file that simply doesn't exist in this checkout at all.
      const root = initFixture(`${check.name}-e2e-unrelated-diff`)
      writeFileSync(
        join(root, 'vinaya.config.json'),
        JSON.stringify({ checks: {}, proseGates: { doctrineRoot: 'docs' } }, null, 2)
      )
      mkdirSync(join(root, 'docs'), { recursive: true })
      // The pre-existing backlog — real, on disk, present in BOTH branches.
      writeFileSync(join(root, 'docs', 'old-note.md'), check.mention)
      execFileSync('git', ['add', '-A'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Chore: base doctrine, carries a pre-existing backlog finding'], {
        cwd: root
      })
      try {
        execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: root })
        // This diff's own change: unrelated to docs/ entirely.
        writeFileSync(join(root, 'unrelated-outside-docs.md'), '# not doctrine\n')
        execFileSync('git', ['add', '-A'], { cwd: root })
        execFileSync('git', ['commit', '-q', '-m', 'Chore: unrelated repo-root file'], { cwd: root })

        const { exitCode, stderr } = run(root)
        expect(exitCode).toBe(0)
        // docs/old-note.md's finding is real and on disk — the sweep finds
        // it — but it's identical on `main` and `feature` (never touched by
        // this diff), so diff-scoping must exclude it from what's printed.
        expect(stderr).toBe('')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    })
  })
}

// Issue #314: `resolveDoctrineRoot()`'s own default resolves relative to
// wherever ITS OWN calling module physically sits on disk — the right anchor
// for `vinaya doctrine`'s "my own package" lookup, but the wrong one for a
// check sweeping the repo actually under check. Whether that default finds a
// real doctrine root depended on whether the checkout's ancestor path
// happened to contain a directory literally named `node_modules` (which
// gates `resolveDoctrineRoot`'s internal fallback candidate) — a fact with no
// relation to whether the checkout's own `aeg-root/` exists. Measured live:
// the same commit, checked out one directory deeper under a `node_modules`-
// named ancestor, silently swept zero files instead of its real backlog.
//
// The fix anchors both checks' unconfigured default to `repoRoot()` (`git
// rev-parse --show-toplevel`) first — deterministic regardless of checkout
// shape — falling back to `resolveDoctrineRoot()`'s package-relative
// resolution only when the repo under check has no local `aeg-root/` of its
// own. These tests exercise both halves of that fix against the REAL bins,
// not a unit test of the resolution logic in isolation, because the bug was
// specifically about what the real subprocess does under a real checkout
// shape.
describe('doctrine-root checkout-location independence (Issue #314)', () => {
  function fixtureWithOwnDoctrine(root: string, checkName: 'reader-resolvable-prose' | 'retired-vocabulary'): void {
    mkdirSync(join(root, 'aeg-root', 'skills', 'aeg'), { recursive: true })
    writeFileSync(join(root, 'aeg-root', 'skills', 'aeg', 'SKILL.md'), '# entry\n')
    // A real, deterministic finding for each check — same patterns the rest
    // of this suite uses (a live `FORGE_NUMBER_PATTERN`/retired-decision-id
    // hit), not a guessed heuristic.
    const mention =
      checkName === 'retired-vocabulary'
        ? `See D-${100 + 23} for the historical rationale.\n`
        : 'See #123 for the historical rationale.\n'
    writeFileSync(join(root, 'aeg-root', 'note.md'), mention)
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
    execFileSync('git', ['add', '-A'], { cwd: root })
    execFileSync('git', ['commit', '-q', '-m', 'Chore: fixture doctrine with one real finding'], { cwd: root })
  }

  // The raw bin, not the `vinaya check <name>` wrapper — the wrapper reformats
  // stdout into its own `✓ <name>: pass` summary and drops the bin's own
  // "N finding(s) swept" line, which this test needs to compare sweep counts.
  function run(cwd: string, checkName: string): { exitCode: number; stdout: string } {
    const binPath = join(
      import.meta.dir,
      '..',
      '..',
      'src',
      'checks',
      'bin',
      checkName === 'reader-resolvable-prose' ? 'check-reader-resolvable-prose.ts' : 'check-retired-vocabulary.ts'
    )
    const result = Bun.spawnSync(['bun', binPath], {
      cwd,
      env: { ...process.env, PR_BODY: undefined, BASE_SHA: undefined }
    })
    return { exitCode: result.exitCode, stdout: result.stdout.toString() }
  }

  /**
   * Pulls the total finding count out of the check's own stdout summary
   * line — `reader-resolvable-prose` prints `N finding(s) swept, ...`,
   * `retired-vocabulary` prints `... M file(s) swept; N finding(s), ...`;
   * both name the total (pre-diff-scoping) count as `N finding(s)`.
   */
  function sweptCount(stdout: string): number {
    const match = stdout.match(/(\d+) finding\(s\)/)
    if (!match) throw new Error(`no "finding(s)" summary line in stdout: ${stdout}`)
    return Number(match[1])
  }

  /**
   * Pulls the resolved doctrine root path out of the check's own stdout
   * summary line (`doctrine root "<path>"`). A matching finding COUNT alone
   * does not prove checkout-independence: with the fix reverted, both
   * fixtures' `resolveDoctrineRoot()` fallback resolves relative to wherever
   * `doctrine.ts` itself physically sits (this dev repo), so both runs
   * silently escape to the SAME real `aeg-root/` and can coincidentally
   * report the same count without ever having swept the fixture at all —
   * caught live in review by reverting the three fixed source files and
   * re-running this suite unmodified. Asserting the reported path actually
   * points INTO the fixture directory closes that gap.
   */
  function doctrineRootPath(stdout: string): string {
    const match = stdout.match(/doctrine root "([^"]+)"/)
    if (!match) throw new Error(`no doctrine-root summary line in stdout: ${stdout}`)
    return match[1] as string
  }

  for (const checkName of ['reader-resolvable-prose', 'retired-vocabulary'] as const) {
    it(`${checkName}: identical finding count from a plain checkout and one nested several directories deeper`, () => {
      const rand = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const plainRoot = join(tmpdir(), `vinaya-checkout-plain-${checkName}-${rand}`)
      // Nested under an unrelated multi-level ancestor — deliberately NOT
      // literally named `node_modules`: `retired-vocabulary`'s own scanner
      // (`packages/aeg-core/src/retired-vocabulary.ts`) exempts any file
      // whose path contains `/node_modules/` as vendored/third-party code —
      // a real, correct, unrelated exemption. Nesting the fixture itself
      // under that literal name would make its own finding vanish for a
      // reason that has nothing to do with THIS fix, confounding the test.
      // Depth/shape (not that one specific name) is what the checkout-
      // independence property under test actually needs to vary.
      const deepParent = join(tmpdir(), `vinaya-checkout-deep-${checkName}-${rand}`, 'linked', 'vendored-checkout')
      const nestedRoot = join(deepParent, 'nested-repo')
      try {
        mkdirSync(plainRoot, { recursive: true })
        mkdirSync(nestedRoot, { recursive: true })
        fixtureWithOwnDoctrine(plainRoot, checkName)
        fixtureWithOwnDoctrine(nestedRoot, checkName)

        const plain = run(plainRoot, checkName)
        const nested = run(nestedRoot, checkName)

        expect(plain.exitCode).toBe(0)
        expect(nested.exitCode).toBe(0)
        // Each run actually resolved INTO its own fixture, not (with the fix
        // reverted) both silently escaping to this dev repo's own real
        // `aeg-root/` — see `doctrineRootPath`'s doc comment for why a
        // finding-count match alone cannot prove this.
        expect(doctrineRootPath(plain.stdout)).toStartWith(realpathSync(plainRoot))
        expect(doctrineRootPath(nested.stdout)).toStartWith(realpathSync(nestedRoot))
        const plainCount = sweptCount(plain.stdout)
        const nestedCount = sweptCount(nested.stdout)
        // Non-zero: proves both actually swept the fixture's real doctrine
        // content, not both coincidentally reporting nothing.
        expect(plainCount).toBeGreaterThan(0)
        expect(nestedCount).toBe(plainCount)
      } finally {
        rmSync(plainRoot, { recursive: true, force: true })
        rmSync(join(tmpdir(), `vinaya-checkout-deep-${checkName}-${rand}`), { recursive: true, force: true })
      }
    })
  }

  // The exact historical trigger (Issue #314's own measured incident):
  // `resolveDoctrineRoot()`'s internal fallback candidate is gated on whether
  // the resolved package path contains a literal `node_modules` segment —
  // reader-resolvable-prose's own scanner carries no equivalent path
  // exemption (unlike retired-vocabulary's, see above), so this is safe to
  // reproduce literally for this one check.
  it('reader-resolvable-prose: identical finding count nested under a literal "node_modules" ancestor specifically', () => {
    const rand = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const plainRoot = join(tmpdir(), `vinaya-checkout-plain-nm-${rand}`)
    const nmParent = join(tmpdir(), `vinaya-checkout-nm-${rand}`, 'node_modules')
    const nestedRoot = join(nmParent, 'nested-repo')
    try {
      mkdirSync(plainRoot, { recursive: true })
      mkdirSync(nestedRoot, { recursive: true })
      fixtureWithOwnDoctrine(plainRoot, 'reader-resolvable-prose')
      fixtureWithOwnDoctrine(nestedRoot, 'reader-resolvable-prose')

      const plain = run(plainRoot, 'reader-resolvable-prose')
      const nested = run(nestedRoot, 'reader-resolvable-prose')

      expect(plain.exitCode).toBe(0)
      expect(nested.exitCode).toBe(0)
      expect(doctrineRootPath(plain.stdout)).toStartWith(realpathSync(plainRoot))
      expect(doctrineRootPath(nested.stdout)).toStartWith(realpathSync(nestedRoot))
      const plainCount = sweptCount(plain.stdout)
      const nestedCount = sweptCount(nested.stdout)
      expect(plainCount).toBeGreaterThan(0)
      expect(nestedCount).toBe(plainCount)
    } finally {
      rmSync(plainRoot, { recursive: true, force: true })
      rmSync(join(tmpdir(), `vinaya-checkout-nm-${rand}`), { recursive: true, force: true })
    }
  })
})

// Issue #314's second acceptance criterion: where the doctrine root
// genuinely cannot be resolved (no local `aeg-root/`, and no bundled copy
// findable relative to the check's own install either), the check must
// report that as its own distinct outcome — never silently as a clean,
// zero-finding pass, which is structurally indistinguishable from "ran and
// found nothing."
//
// Constructing this for real means defeating BOTH resolution paths: the
// `repoRoot()`-anchored candidate (no local `aeg-root/`) AND
// `resolveDoctrineRoot()`'s own package-relative fallback (no bundled copy
// reachable from the check bin's own install location). Every real caller
// in this dev monorepo's own tree finds ITS OWN `aeg-root/` via that second
// path, so the only way to exercise genuine unresolvability for real is a
// separate checkout with its `aeg-root/` actually removed — a fixture
// clone, not the shared dev tree these tests run inside of. `git clone`
// (local, same filesystem) hardlinks objects, so this is fast; `node_modules`
// is symlinked in from THIS run's own real install rather than reinstalled,
// since only `aeg-root`'s absence is under test here, not dependency
// resolution.
describe('doctrine root genuinely unresolvable (Issue #314)', () => {
  const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()

  function cloneWithoutAegRoot(name: string): string {
    const dest = join(tmpdir(), `vinaya-no-aeg-root-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    execFileSync('git', ['clone', '--quiet', REPO_ROOT, dest])
    execFileSync('git', ['checkout', '-q', '-b', 'test-no-aeg-root'], { cwd: dest })
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(dest, 'node_modules'))
    execFileSync('git', ['rm', '-rq', '--', 'aeg-root'], { cwd: dest })
    execFileSync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-q', '-m', 'Chore: remove aeg-root'],
      {
        cwd: dest
      }
    )
    return dest
  }

  for (const checkName of ['reader-resolvable-prose', 'retired-vocabulary'] as const) {
    it(`${checkName}: reports doctrine-root-unresolvable as a distinct outcome, never a silent clean pass`, () => {
      const clone = cloneWithoutAegRoot(checkName)
      const binPath = join(
        clone,
        'apps',
        'cli',
        'src',
        'checks',
        'bin',
        checkName === 'reader-resolvable-prose' ? 'check-reader-resolvable-prose.ts' : 'check-retired-vocabulary.ts'
      )
      try {
        const result = Bun.spawnSync(['bun', binPath], { cwd: clone })
        const exitCode = result.exitCode
        const stderr = result.stderr.toString()

        // Never 0 (a clean/empty sweep) — a distinct code so the runner's
        // own generic exit-code mapping (0 → pass, 1 → fail, else → error)
        // marks this run `status: 'error'`, never `status: 'pass'` with
        // zero findings.
        expect(exitCode).not.toBe(0)
        const errors = stderr
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
        expect(errors).toHaveLength(1)
        expect(errors[0].severity).toBe('error')
        expect(errors[0].check).toBe(checkName)
        expect(errors[0].message).toContain('doctrine root unresolvable')
      } finally {
        rmSync(clone, { recursive: true, force: true })
      }
    })
  }
})

// Regression: an explicit `proseGates.doctrineRoot` must still win outright
// over both the `repoRoot()`-anchored candidate and `resolveDoctrineRoot()`'s
// fallback, for BOTH checks. The reader-resolvable-prose half of this is
// already covered above (task `vinaya-adopter-portability-v1` 2); this adds
// the retired-vocabulary half, which that earlier suite never exercised.
describe('explicit proseGates.doctrineRoot still wins — retired-vocabulary (Issue #314 regression)', () => {
  it('a configured doctrineRoot is read even when a real repo-root aeg-root/ also exists', () => {
    const root = join(tmpdir(), `vinaya-retired-config-wins-${Date.now()}-${Math.random().toString(36).slice(2)}`)
    try {
      // A real `aeg-root/` at the repo root too, so this test actually
      // discriminates "configured wins" from "repoRoot() candidate would
      // have won anyway" — the two must differ for the assertion to mean
      // anything.
      mkdirSync(join(root, 'aeg-root', 'skills', 'aeg'), { recursive: true })
      writeFileSync(join(root, 'aeg-root', 'skills', 'aeg', 'SKILL.md'), '# entry\n')
      writeFileSync(join(root, 'aeg-root', 'note.md'), `See D-${100 + 23} for the historical rationale.\n`)

      mkdirSync(join(root, 'configured-doctrine'), { recursive: true })
      writeFileSync(join(root, 'configured-doctrine', 'note.md'), '# nothing retired here\n')
      writeFileSync(
        join(root, 'vinaya.config.json'),
        JSON.stringify({ checks: {}, proseGates: { doctrineRoot: 'configured-doctrine' } }, null, 2)
      )
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root })
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root })
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root })
      execFileSync('git', ['add', '-A'], { cwd: root })
      execFileSync('git', ['commit', '-q', '-m', 'Chore: add fixture doctrine'], { cwd: root })

      const result = Bun.spawnSync(['bun', INDEX_TS, 'check', 'retired-vocabulary'], {
        cwd: root,
        env: { ...process.env, PR_BODY: undefined }
      })
      expect(result.exitCode).toBe(0)
      // Positive proof it read the CONFIGURED root, not the repo-root
      // aeg-root/: the real D-123 finding in aeg-root/note.md never surfaces.
      expect(result.stderr.toString()).not.toContain('retired AEG mechanism')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
