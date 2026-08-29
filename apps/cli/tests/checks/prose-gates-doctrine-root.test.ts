import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    /** `D-123`-shaped — a real, deterministic `RETIRED_PATTERNS` hit (`@attalabs/aeg-core`'s retired decision-id format), not a guessed heuristic. */
    mention: 'See D-123 for the historical rationale.\n',
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
