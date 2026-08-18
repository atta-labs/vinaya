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
