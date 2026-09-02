/**
 * PR-report density (aeg-governance-hardening, dogfooding finding 2026-09-02).
 * Pure — no `fs`, no `fetch`, no `process.env`.
 *
 * `aeg-root/roles/developer.md` § "PR body — canonical form" and
 * `aeg-root/templates/pr-report-template.md` both require `## Summary` and
 * `## Scope` to be exactly one paragraph — narrative root-cause detail
 * belongs in a section of its own below the canonical four, a commit
 * message, or the changeset, never padded into the report itself and never
 * hand-typed into the AEG:EVIDENCE block. Nothing enforced that rule
 * mechanically:
 * confirmed live, three real PRs (`atta-labs/vinaya#343`, `#346`, `#354`)
 * shipped multi-paragraph Summary/Scope sections and nothing caught it,
 * neither at `vinaya pr create`/`pr edit` time nor in CI. Longer, denser
 * prose is also strictly more surface for every other body-text gate
 * (`body-bare-digits`, `reader-resolvable-prose`'s glossary rule) — the same
 * class of gap `#341` hit in code, just in prose instead.
 *
 * Deterministic and structural only, matching `brief-validation.ts`'s own
 * "presence-only" philosophy: this counts blank-line-delimited text blocks,
 * never judges whether the prose itself is good.
 *
 * The rule is literal — one paragraph, full stop — so a `### subsection`, a
 * bullet list, or a markdown table under Summary/Scope all fail too, same as
 * a second prose paragraph would (confirmed by probe, PR review on #358).
 * That is intentional, not an oversight: `developer.md`'s own escape hatch
 * for exactly this case is "Add anything you want beneath the four
 * sections" — structured detail belongs in a section of its own below
 * Summary/Scope/Test-plan/Evidence, not folded into one of the four. A
 * multi-line blockquote is the one shape this rule does NOT split on (its
 * `\n>\n` continuation lines are never blank), so it is the sanctioned way
 * to carry a short structured aside inside Summary/Scope itself, if one is
 * genuinely needed there rather than in its own section.
 */

import { anchoredRegionBounds, stripCode } from './anchored-region'

export type DensityResult = { status: 'pass' | 'fail'; errors: string[] }

/**
 * The named `## <heading>` section's raw body text — from just after the
 * heading line to the next `##`-or-shallower heading, or end of body.
 * `null` when the heading itself is absent (a different check's job to
 * require it — this one is silent on presence, per the module's scope).
 */
function headingSectionBody(prBody: string, heading: string): string | null {
  const headingRe = new RegExp(`^##\\s+${heading}\\s*$`, 'im')
  const m = headingRe.exec(prBody)
  if (!m) return null
  const start = m.index + m[0].length
  const rest = prBody.slice(start)
  const nextHeading = /^#{1,2}\s/m.exec(rest)
  return nextHeading ? rest.slice(0, nextHeading.index) : rest
}

/**
 * `headingSectionBody`'s text with every well-formed `AEG:*` anchor block removed
 * outright (not just unwrapped) — an anchored field (Scope's trailing
 * `AEG:TIER` block, in the canonical template) is a field, not a second
 * prose paragraph, and must not count as one. Reuses `anchoredRegionBounds`
 * (the same span `vinaya pr report --write` targets) rather than a second,
 * drifting regex for "what an anchor block looks like."
 */
function stripAnchorBlocks(sectionText: string): string {
  let result = sectionText
  for (const field of ['CLOSES', 'PROJECT', 'TIER', 'PREMISE', 'TEST-PLAN', 'EVIDENCE'] as const) {
    for (;;) {
      const bounds = anchoredRegionBounds(result, field)
      if (!bounds) break
      result = result.slice(0, bounds.outerStart) + result.slice(bounds.outerEnd)
    }
  }
  return result
}

/** Non-empty, blank-line-delimited text blocks, code-blind (a fenced example inside the section is not a second paragraph). */
function paragraphCount(sectionText: string): number {
  const stripped = stripCode(stripAnchorBlocks(sectionText)).trim()
  if (stripped.length === 0) return 0
  return stripped
    .split(/\n[ \t]*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0).length
}

function checkSectionDensity(prBody: string, heading: string): DensityResult {
  const body = headingSectionBody(prBody, heading)
  if (body === null) return { status: 'pass', errors: [] }
  const count = paragraphCount(body)
  if (count <= 1) return { status: 'pass', errors: [] }
  return {
    status: 'fail',
    errors: [
      `pr-report-density ${heading}: "## ${heading}" holds ${count} paragraphs — the canonical PR-report form (aeg-root/roles/developer.md § PR body) requires exactly one. Collapse it to one paragraph; move the rest into a section of your own below the canonical four ("Add anything you want beneath the four sections", developer.md), a commit message, or the changeset — never into the AEG:EVIDENCE block, which is emitted only, never hand-typed.`
    ]
  }
}

export function checkSummaryDensity(prBody: string): DensityResult {
  return checkSectionDensity(prBody, 'Summary')
}

export function checkScopeDensity(prBody: string): DensityResult {
  return checkSectionDensity(prBody, 'Scope')
}

/** Aggregates both section checks — one error line per over-dense section. */
export function checkPrReportDensity(prBody: string): { errors: string[] } {
  const results = [checkSummaryDensity(prBody), checkScopeDensity(prBody)]
  return { errors: results.flatMap((r) => r.errors) }
}
