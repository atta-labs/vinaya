import { anchoredRegion, stripCode } from '../../../gates/checks/anchored-region'

function closesRefs(text: string): number[] {
  return [...new Set([...text.matchAll(/Closes #(\d+)/gi)].map((m) => Number(m[1] as string)))]
}

/**
 * Primary Issue = first `Closes #N` in the header block (canonical placement),
 * falling back to the first anywhere in the body (flagged, not lost). Extras
 * are scanned body-wide so a real second closing reference in prose is still
 * flagged — but always fence-stripped, so example text like a Test Plan's
 * `Closes #NNN` fixture never counts (a real regression).
 *
 * When the body carries an `AEG:CLOSES` anchor pair (`anchored-region.ts`,
 * task 30), the pair replaces the header block as the canonical placement:
 * the primary Issue is the first `Closes #N` inside the pair (never flagged
 * `outsideHeader` — anchored IS canonical), and extras are still scanned
 * body-wide so stray closing references stay flagged. Bodies without the
 * pair parse exactly as before.
 */
export function extractIssue(body: string): { issue: number | null; extraIssues: number[]; outsideHeader: boolean } {
  // Strip ONCE over the whole body, then slice — never strip a slice. The
  // strip's block rules read context a fragment no longer carries: an anchor
  // indented inside a list item is list content in the full body (kept, and
  // GitHub *does* auto-close it) but looks like a bare 4-space indented code
  // block once sliced, so stripping the region blanked the reference and
  // returned `issue: null` — the Issue then goes unclosed on merge, the exact
  // stranding this exists to eliminate, reintroduced along the over-strip
  // axis (a MAJOR review finding). Stripping first also subsumes the decoy
  // protection rather than trading against it: `AEG:*` markers are HTML
  // comments and survive the strip, while a decoy anchor inside code does not
  // survive to be sliced in the first place.
  const stripped = stripCode(body)
  const bodyNums = closesRefs(stripped)
  const anchored = anchoredRegion(stripped, 'CLOSES')
  if (anchored !== null) {
    const anchorNums = closesRefs(anchored)
    if (anchorNums.length === 0) return { issue: null, extraIssues: bodyNums, outsideHeader: false }
    const issue = anchorNums[0] as number
    return { issue, extraIssues: bodyNums.filter((n) => n !== issue), outsideHeader: false }
  }
  const headerNums = closesRefs(headerRegion(stripped))
  if (bodyNums.length === 0) return { issue: null, extraIssues: [], outsideHeader: false }
  const issue = headerNums.length > 0 ? (headerNums[0] as number) : (bodyNums[0] as number)
  return { issue, extraIssues: bodyNums.filter((n) => n !== issue), outsideHeader: headerNums.length === 0 }
}

function headerRegion(prBody: string): string {
  const m = prBody.match(/^##\s/m)
  return m?.index !== undefined ? prBody.slice(0, m.index) : prBody
}
