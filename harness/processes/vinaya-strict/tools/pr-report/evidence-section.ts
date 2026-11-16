/**
 * Adds the `## Evidence` section to a pull request body that has none.
 *
 * The loop writes a run's evidence between the `VINAYA:EVIDENCE` anchors after
 * the pull request opens, and that writer refuses a live body with no pair. The
 * Developer composes the body and may skip the section, so the two body-writing
 * tools call this before the body gate: a body with no real pair gets one, a
 * body with a real pair is returned byte for byte.
 *
 * Pure, and independent of the evidence writer: it imports the shared anchor
 * lookup, the marker prefix and the placeholder text, never the report engine.
 */

import { anchoredRegionBounds } from '../../../../kernel/gates/checks/anchored-region'
import { maskCode } from '../../../../kernel/adapters/code-host/github/strip-code'
import { ScanContext } from '../../../../kernel/gates/checks/scan-context'
import { EVIDENCE_PLACEHOLDER_TEXT } from '../../checks/evidence-fresh-logic'
import { REGION_PREFIX_CURRENT, REGION_PREFIXES } from '../legacy-markers'

const EVIDENCE_START = `<!-- ${REGION_PREFIX_CURRENT}:EVIDENCE:START -->`
const EVIDENCE_END = `<!-- ${REGION_PREFIX_CURRENT}:EVIDENCE:END -->`

/** The block a body with no evidence yet receives: both markers around the placeholder line. */
const PLACEHOLDER_BLOCK = `${EVIDENCE_START}\n${EVIDENCE_PLACEHOLDER_TEXT}\n${EVIDENCE_END}`

/**
 * The whole real `VINAYA:EVIDENCE` block of `body` — markers and content — or
 * `null` when it has no real pair, or when the raw and the normalised
 * resolutions of the pair disagree.
 */
export function realEvidenceBlock(body: string): string | null {
  if (!ScanContext.from(body, REGION_PREFIXES).rawResolutionAgrees('EVIDENCE')) return null
  const bounds = anchoredRegionBounds(body, 'EVIDENCE', REGION_PREFIXES)
  return bounds ? body.slice(bounds.outerStart, bounds.outerEnd) : null
}

/**
 * Returns `body` with an Evidence section when it has no real anchor pair.
 *
 * - A real pair already there, or raw and normalised resolutions that disagree:
 *   `body` unchanged (the evidence writer's own refusal then names the cause).
 * - Otherwise the block is `liveBlock` when given (the live body's own pair), else
 *   the placeholder pair. It goes directly under an existing level-two
 *   `## Evidence` heading, else under a new one placed before the first level-two
 *   `## Scope` heading, else at the end. Headings count only outside fenced code.
 */
export function addEvidenceSection(body: string, liveBlock: string | null = null): string {
  if (!ScanContext.from(body, REGION_PREFIXES).rawResolutionAgrees('EVIDENCE')) return body
  if (anchoredRegionBounds(body, 'EVIDENCE', REGION_PREFIXES) !== null) return body

  const block = liveBlock ?? PLACEHOLDER_BLOCK
  const masked = maskCode(body)

  const evidenceHeading = /^## Evidence[ \t]*(?=\r?$)/m.exec(masked)
  if (evidenceHeading) {
    const headingEnd = evidenceHeading.index + evidenceHeading[0].length
    const tail = body.slice(headingEnd).replace(/^(?:\r?\n)+/, '')
    return `${body.slice(0, headingEnd)}\n\n${block}${tail === '' ? '\n' : `\n\n${tail}`}`
  }

  const section = `## Evidence\n\n${block}\n`
  const scopeHeading = /^## Scope[ \t]*(?=\r?$)/m.exec(masked)
  if (scopeHeading) {
    return `${body.slice(0, scopeHeading.index)}${section}\n${body.slice(scopeHeading.index)}`
  }
  const head = body.replace(/(?:\r?\n)+$/, '')
  return `${head === '' ? '' : `${head}\n\n`}${section}`
}
