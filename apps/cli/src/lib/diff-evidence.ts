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

/**
 * The full changed-file list for the PR's diff — `[]`, never a throw, when
 * git cannot answer (no `origin/main`, a shallow clone, a local run outside
 * any repo). `check-doc-coverage.ts` originated this exact function inline;
 * `check-reader-resolvable-prose.ts`/`check-retired-vocabulary.ts` need the
 * identical list to filter a full-doctrine-tree sweep's findings down to
 * files the PR actually touched (both checks otherwise reprint this
 * package's entire shipped-doctrine backlog on every PR regardless of what
 * changed — found live, atta-labs/vinaya#289). Shared here rather than a
 * third inline copy, for the same drift reason `fileDiffAgainst` already is.
 */
export function changedFiles(base: string): string[] {
  try {
    return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
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
 * `changedFiles(base)`, re-resolving to `main` when the requested base
 * yields nothing (no `origin/main` remote-tracking ref locally, a shallow
 * clone) — same fallback `check-doc-coverage.ts` already applies to its own
 * copy of this exact logic. Returns `null` — never `[]` — when NEITHER base
 * resolves to a commit genuinely distinct from `HEAD`: a bare/single-commit
 * fixture (this package's own `RC3` test suite: `git init` + one commit, no
 * `origin` remote at all) has `main` resolve successfully but equal to
 * `HEAD` itself, which `git diff main...HEAD` reports as a real, empty diff
 * — indistinguishable from "a genuine PR with nothing changed" by output
 * alone. Conflating the two would make a diff-scoped filter downstream
 * suppress a full-doctrine-tree sweep's findings in exactly the case where
 * no diff boundary could be established at all, rather than only when one
 * was established and found empty. Callers that receive `null` should keep
 * their pre-diff-scoping behavior (report every finding the sweep found),
 * not silence themselves.
 */
export function resolveChangedFiles(base = process.env.BASE_SHA || 'origin/main'): string[] | null {
  const head = revParse('HEAD')
  for (const ref of [base, 'main']) {
    const resolved = revParse(ref)
    if (resolved === null || resolved === head) continue
    return changedFiles(ref)
  }
  return null
}
