/**
 * AEG anchored-region grammar (aeg-governance-hardening task 30, #393). Pure —
 * no `fs`, no `gh`/`git`.
 *
 * One anchor syntax for every gate-read field: an HTML comment pair
 * `<!-- AEG:<FIELD>:START -->` … `<!-- AEG:<FIELD>:END -->` delimiting the
 * field's one canonical home inside a PR/Issue body. HTML comments render
 * invisibly on the forge, survive inside `<details>` blocks, and can never be
 * produced accidentally by freeform prose — which is exactly the failure class
 * this closes (PR #392's pasted reference brief duplicated its own Test Plan
 * inside the PR body; #363/#377 were the same shape as real bugs).
 *
 * Recognition semantics, shared by every consumer
 * (`pr-tier.ts`, `test-plan-section.ts`, `premise-check.ts`,
 * `brief-validation.ts`/`archive-task.ts`'s Project read, and the `Closes #N`
 * reads in `coherence-checks.ts`/`archive-task.ts`):
 *
 *   - **Anchors are additive, never required.** A body with no anchor pair for
 *     a field parses byte-identically to the pre-anchor behavior — every
 *     already-merged PR/Issue keeps reading exactly as today.
 *   - **When a pair is present, it is authoritative.** The consumer reads the
 *     field exclusively from inside the pair and ignores identical-looking
 *     text anywhere else in the body — there is deliberately no fallback to
 *     body-wide search, since falling back would resurrect the decoy problem
 *     the anchor exists to solve.
 *   - **First pair wins** when a field is (incorrectly) anchored twice —
 *     mirroring the first-match-wins philosophy of the existing prose parsers.
 *   - **A `START` with no following `END` is treated as no anchor at all**
 *     (prose fallback) — a malformed half-pair must not be able to hide a
 *     field from the gates.
 *   - **Markers inside fenced code blocks or inline code spans do not count**
 *     — example/quoted anchor syntax in documentation or evidence output is
 *     never mistaken for a real anchor (same code-stripping philosophy as
 *     `archive-task.ts`'s `stripCode`, #311 regression).
 *
 * The field line/block goes on its own line(s) INSIDE the pair — e.g.
 *
 *     <!-- AEG:TIER:START -->
 *     **Tier:** 1
 *     <!-- AEG:TIER:END -->
 *
 * Deliberately minimal: five field names, one shape. This is a delimiting
 * convention, not a metadata DSL; resist adding structure to it.
 */

import { maskCode } from '@attalabs/aeg-forge-state'

/** The five gate-read fields with an anchored home. */
export const ANCHOR_FIELDS = ['CLOSES', 'PROJECT', 'TIER', 'PREMISE', 'TEST-PLAN'] as const

export type AnchorField = (typeof ANCHOR_FIELDS)[number]

/**
 * The code-recognition grammar — `stripCode`, `maskCode` and their fence /
 * indented-block / inline-span scanners — moved down to
 * `@attalabs/aeg-forge-state` (`strip-code.ts`) so `projectFieldFromBody` can
 * read a body "minus its examples" through the SAME implementation rather than
 * a second copy of it. `aeg-core` already depends on `aeg-forge-state`, so the
 * grammar could only be shared by moving it down; importing upward would close
 * a cycle. It is re-exported here because `anchored-region` remains this
 * package's documented home for body-parsing primitives and every existing
 * `import { stripCode } from './anchored-region'` call site is unchanged.
 */
export { stripCode } from '@attalabs/aeg-forge-state'
export type { StripCodeOptions } from '@attalabs/aeg-forge-state'

/**
 * The text between the first `<!-- AEG:<field>:START -->` and the first
 * `<!-- AEG:<field>:END -->` after it, or `null` when the body carries no
 * (well-formed, non-code) pair for this field. `null` is the signal for
 * consumers to run their unchanged prose/heading recognition.
 */
export function anchoredRegion(body: string, field: AnchorField): string | null {
  const masked = maskCode(body)
  const start = new RegExp(`<!--\\s*AEG:${field}:START\\s*-->`).exec(masked)
  if (!start) return null
  const afterStart = start.index + start[0].length
  const end = new RegExp(`<!--\\s*AEG:${field}:END\\s*-->`).exec(masked.slice(afterStart))
  if (!end) return null
  return body.slice(afterStart, afterStart + end.index)
}
