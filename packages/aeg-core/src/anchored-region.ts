/**
 * AEG anchored-region grammar. Pure —
 * no `fs`, no `gh`/`git`.
 *
 * One anchor syntax for every gate-read field: an HTML comment pair
 * `<!-- AEG:<FIELD>:START -->` … `<!-- AEG:<FIELD>:END -->` delimiting the
 * field's one canonical home inside a PR/Issue body. HTML comments render
 * invisibly on the forge, survive inside `<details>` blocks, and can never be
 * produced accidentally by freeform prose — which is exactly the failure class
 * this closes (a real pasted reference brief duplicated its own Test Plan
 * inside the PR body; other real PRs hit the same shape of bug).
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
 *     `archive-task.ts`'s `stripCode`, after a real regression).
 *
 * The field line/block goes on its own line(s) INSIDE the pair — e.g.
 *
 *     <!-- AEG:TIER:START -->
 *     **Tier:** 1
 *     <!-- AEG:TIER:END -->
 *
 * Deliberately minimal: seven field names, one shape. This is a delimiting
 * convention, not a metadata DSL; resist adding structure to it.
 *
 * `EVIDENCE` (fix/pr-report-emitter) differs from the other six in one way:
 * it is never hand-typed. `vinaya pr report --write` is the only writer, and
 * `check-evidence-fresh` is the only reader — no prose-fallback recognition
 * exists or is planned for this field, unlike the anchor-optional grammar
 * described above for the other five.
 */

import { maskCode } from '@attalabs/aeg-forge-state/strip-code'

/**
 * The seven gate-read fields with an anchored home. `TOKENS`
 * joined here rather than through a second, parallel field list —
 * `pr-report.ts`'s own `AEG:TOKENS:START`/`:END` markers already use this
 * exact grammar, so the registry is the fix, not a workaround beside it.
 */
export const ANCHOR_FIELDS = ['CLOSES', 'PROJECT', 'TIER', 'PREMISE', 'TEST-PLAN', 'EVIDENCE', 'TOKENS'] as const

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
 * The START/END markers' positions in `body`, found the same code-blind way
 * `anchoredRegion` finds its content — `null` under the identical conditions
 * `anchoredRegion` returns `null`. `outerStart`/`outerEnd` span the markers
 * themselves; `innerStart`/`innerEnd` span the content between them (what
 * `anchoredRegion` returns as a string).
 *
 * Exists so a WRITER (`vinaya pr report --write`'s `replaceEvidenceBlock`)
 * can target the same real, non-fenced pair a reader would — a naive
 * `body.indexOf(START)` finds whichever copy comes first in raw text, fenced
 * decoy included, and a body that quotes a worked example of its own anchor
 * (exactly what this task's own PR body does, in its Test Plan evidence)
 * would get ITS OWN replacement written into the quoted example instead of
 * the real field. One masked search, shared by the reader and the writer,
 * closes that by construction rather than by convention.
 */
export function anchoredRegionBounds(
  body: string,
  field: AnchorField
): { outerStart: number; outerEnd: number; innerStart: number; innerEnd: number } | null {
  const masked = maskCode(body)
  const start = new RegExp(`<!--\\s*AEG:${field}:START\\s*-->`).exec(masked)
  if (!start) return null
  const innerStart = start.index + start[0].length
  const end = new RegExp(`<!--\\s*AEG:${field}:END\\s*-->`).exec(masked.slice(innerStart))
  if (!end) return null
  const innerEnd = innerStart + end.index
  return { outerStart: start.index, outerEnd: innerEnd + end[0].length, innerStart, innerEnd }
}

/**
 * The text between the first `<!-- AEG:<field>:START -->` and the first
 * `<!-- AEG:<field>:END -->` after it, or `null` when the body carries no
 * (well-formed, non-code) pair for this field. `null` is the signal for
 * consumers to run their unchanged prose/heading recognition.
 */
export function anchoredRegion(body: string, field: AnchorField): string | null {
  const bounds = anchoredRegionBounds(body, field)
  if (!bounds) return null
  return body.slice(bounds.innerStart, bounds.innerEnd)
}
