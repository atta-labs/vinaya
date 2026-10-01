/**
 * `Measured<T>` — the answer type every Vinaya Log reader returns: a known
 * value, or unknown with the reason it cannot be stated
 * (`apps/cli/specs/log-sync.md`). An unknown is never collapsed into a
 * default such as `0`, `''` or `false`: a question the log cannot answer
 * says so, and says why.
 */
export type Measured<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly reason: string }

/** A value the log states. */
export function known<T>(value: T): Measured<T> {
  return { known: true, value }
}

/** A value the log cannot state, and why. */
export function unknownBecause<T = never>(reason: string): Measured<T> {
  return { known: false, reason }
}
