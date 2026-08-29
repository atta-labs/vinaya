/**
 * The per-file diff `evaluateC5` reads to verify a `Doc-neutral:` declaration
 * (atta-labs/vinaya#122). Shared by both doc-coverage check bins so the two
 * cannot drift; `packages/aeg-core/bin/verify-docs.ts` carries its own copy
 * because it lives in a different package and aeg-core's `src/` is zero-I/O
 * by charter — that boundary, not an oversight, is why there are two.
 *
 * The caller passes the ref that actually produced the changed-file list, not
 * the requested base: both bins re-resolve to `main` when `origin/main` yields
 * nothing, and diffing against a ref that resolves nothing returns `null`,
 * which `evaluateC5` reads as "no evidence" — failing the declaration for a
 * reason unrelated to the declaration.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

/** `null` when the file has no diff against `ref`, or when git cannot answer. */
export function fileDiffAgainst(ref: string, path: string): string | null {
  let out: string
  try {
    out = execFileSync('git', ['diff', `${ref}...HEAD`, '--', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
  return out === '' ? null : out
}

function revParse(ref: string): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--verify', ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
}

/**
 * The real repo root, independent of the caller's `process.cwd()` — a check
 * bin spawned from a different cwd than the repo root (a subdirectory, a
 * differently-configured runner) must not silently compare paths against the
 * wrong base. `null` only when this process is not inside a git worktree at
 * all, which every other function here already treats as "cannot answer."
 *
 * Exported (review finding, PR #290 MINOR): a caller that ALSO builds
 * cwd-relative paths of its own — `check-reader-resolvable-prose.ts`/
 * `check-retired-vocabulary.ts` do, when `DOCTRINE_ROOT` is a relative
 * `proseGates.doctrineRoot` config value or the bare `'aeg-root'` fallback —
 * needs the SAME anchor `resolveChangedFiles()` uses to resolve its own
 * paths against, not a second, independent assumption that `process.cwd()`
 * happens to equal it. Anchoring both sides to this one function is what
 * makes them agree regardless of invocation cwd, closing the gap that
 * remained even after the MAJOR fix: the two absolute-path shapes were each
 * internally consistent but could still diverge from EACH OTHER outside the
 * common case.
 */
export function repoRoot(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
}

/**
 * `null` — never `[]` — when git's diff computation itself failed (not the
 * same as "succeeded with zero files"). `git diff --name-only base...HEAD`
 * throws when `base` and `HEAD` share no merge base — a shallow clone (CI's
 * default `fetch-depth: 1`), or a genuinely orphaned/unrelated-history
 * commit — which is a REAL, reproduced failure mode (review finding, PR
 * #290): the previous version of this function caught that throw and
 * returned `[]`, which every caller read as "confirmed: nothing changed,"
 * silently dropping a real 169-finding backlog to zero. A thrown diff must
 * propagate as "I don't know," never collapse into "I checked and it's
 * clean" — those are different facts and only one of them licenses
 * suppressing a finding.
 */
function changedFiles(base: string): string[] | null {
  let out: string
  try {
    out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  } catch {
    return null
  }
  return out === ''
    ? []
    : out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
}

/**
 * The full changed-file list for the PR's diff, as ABSOLUTE paths — `null`
 * when no diff could be established at all, `[]` when one was established
 * and is genuinely empty. Absolute, not repo-relative: a caller comparing
 * against its own already-absolute paths (e.g. a doctrine-tree sweep whose
 * `finding.file` comes from `resolveDoctrineRoot()`) must not additionally
 * assume its own `process.cwd()` equals the repo root to make a relative
 * comparison work — that assumption breaks (review finding, PR #290 MAJOR)
 * the instant a check bin runs from any other cwd. Resolving against the
 * real repo root (`git rev-parse --show-toplevel`) sidesteps the assumption
 * entirely rather than documenting around it.
 *
 * `null` propagates from three distinct "cannot answer" cases, tried in
 * order: no repo root at all; a candidate base ref (`base`, then `main`)
 * that never resolves to a commit distinct from `HEAD` (a bare/single-commit
 * fixture — this package's own `RC3` test suite shape: `git init` + one
 * commit, no `origin` remote); or a resolved base whose diff computation
 * itself fails (`changedFiles` above — the shallow-clone/no-merge-base
 * case). Only when EVERY candidate is exhausted does this return `null`.
 * A caller receiving `null` must report every finding unfiltered — the
 * pre-diff-scoping behavior — never treat indeterminate as "confirmed
 * clean."
 *
 * **The same-SHA skip (`resolved === head`) is a deliberate false-negative,
 * not an oversight.** A real feature branch that legitimately carries zero
 * new commits against its base is structurally indistinguishable — by
 * commit SHA alone, with no `origin` remote to consult — from the RC3 bare-
 * fixture shape this skip exists to catch (see `tests/diff-evidence.test.ts`
 * for both cases exercised side by side, and for why a resolvable-but-
 * genuinely-empty diff needs a real, distinct SHA — e.g. an empty commit —
 * to test at all). Given that ambiguity, treating it as indeterminate (report
 * everything) rather than confirmed-empty (report nothing) is the correct
 * direction to guess wrong in for a report-only check: unnecessary noise on
 * a genuinely-empty real branch, never a silently dropped backlog.
 */
export function resolveChangedFiles(base = process.env.BASE_SHA || 'origin/main'): string[] | null {
  const root = repoRoot()
  if (root === null) return null

  const head = revParse('HEAD')
  for (const ref of [base, 'main']) {
    const resolved = revParse(ref)
    if (resolved === null || resolved === head) continue
    const relPaths = changedFiles(ref)
    if (relPaths === null) continue // this ref resolved, but its diff didn't — try the next candidate
    return relPaths.map((p) => join(root, p))
  }
  return null
}
