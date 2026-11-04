/** One section's raw text, from its `## <name>` heading to the next `##` heading or the end — `null` when the heading is absent. Parametrized on the heading name. */
export function topLevelSectionText(body: string, headingName: string): string | null {
  const headingRe = new RegExp(`^##[ \\t]*${headingName}[ \\t]*$`, 'im')
  const heading = headingRe.exec(body)
  if (!heading) return null
  const afterHeading = body.slice(heading.index + heading[0].length)
  const next = /^##[ \t]/m.exec(afterHeading)
  return next ? afterHeading.slice(0, next.index) : afterHeading
}

export type ParsedIssueSection<T> = { ok: true; value: T } | { ok: false; errors: string[] }

export type IssueDocumentationSource = { source: string; mechanism: string; objectiveIds: number[] }
export type IssueDocumentation = { kind: 'none' } | { kind: 'sources'; sources: IssueDocumentationSource[] }

/** The explicit opt-out for a task with no externally-normative source — same sentinel shape as `Test Plan: unit-tests-only`/"No doc updates required". */
const NO_DOCUMENTATION_SENTINEL_RE = /^none\b/i

/**
 * One well-formed `## Documentation` line: a source, then the mechanism it
 * governs, split on an em/en-dash (optional surrounding whitespace — those
 * two characters never appear inside a real URL/path, so they are
 * unambiguous) or an ASCII hyphen with MANDATORY whitespace on both sides.
 * The mandatory-whitespace form is deliberate, not `## Parts`'s own looser
 * `\s*[-—–]\s*` (`ISSUE_PART_LINE_RE`): Parts' literal `Part <n> (<refs>)`
 * prefix already anchors where its separator falls, so a hyphen anywhere
 * else in the line is never ambiguous there. A Documentation line has no
 * such anchor — its source is very often a URL — and a real doc-page path
 * routinely contains an unspaced hyphen (`agent-sdk`, `cost-tracking`);
 * against the old `\s*[-—–]\s*` shape, the lazy source capture stopped at
 * the FIRST such in-URL hyphen, truncating the source and corrupting the
 * mechanism text (round 2 review, BLOCKER, O1/O2 — verified live:
 * `https://code.claude.com/docs/en/agent-sdk/cost-tracking` split at
 * `.../agent`). Requiring `\s+-\s+` for the hyphen form specifically closes
 * that gap: no URL contains a literal space, so an in-path hyphen can never
 * satisfy it, while a real hand-written ` - ` separator still does. An
 * OPTIONAL trailing `(O<n>[, O<m>])` citation follows — same grammar Parts
 * cites Objectives with, moved to the end here since a source/mechanism pair
 * reads naturally before the citation that grades it (O3). The
 * citation group only ever matches a real `O<digits>` list, so a mechanism
 * whose own prose ends in an ordinary parenthetical (never shaped like
 * `(O2)`) is never mistaken for one — it stays part of the mechanism capture
 * instead.
 */
const ISSUE_DOCUMENTATION_LINE_RE = /^[-*]\s+(.+?)(?:\s+-\s+|\s*[—–]\s*)(.+?)(?:\s*\((O\d+(?:\s*,\s*O\d+)*)\))?$/i

/**
 * `## Documentation` — one bullet per normative source (a doc URL or an
 * in-repo path) against the mechanism it governs: `- <source> — <mechanism>
 * (O<n>)`. A task with no externally-documented mechanism states the
 * explicit `None` sentinel instead of an empty section — silence is never
 * read as "nothing to cite" (the failure this section closes is
 * a source assumed read, never verified). `topLevelSectionText`/the
 * dash-split grammar mirror `parseIssueParts`'s own shape, so this reads as
 * one more judgment section, not a bespoke grammar.
 */
export function parseIssueDocumentation(body: string): ParsedIssueSection<IssueDocumentation> {
  const section = topLevelSectionText(body, 'Documentation')
  if (section === null) return { ok: false, errors: ['no `## Documentation` heading found in the body.'] }

  const lines = section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (lines.length > 0 && lines.every((l) => NO_DOCUMENTATION_SENTINEL_RE.test(l))) {
    return { ok: true, value: { kind: 'none' } }
  }

  const sources: IssueDocumentationSource[] = []
  const errors: string[] = []
  for (const line of lines) {
    const m = ISSUE_DOCUMENTATION_LINE_RE.exec(line)
    if (!m) {
      errors.push(
        `"${line}" is not a well-formed Documentation line — expected \`- <source> — <mechanism it governs>\` (or the \`None\` sentinel).`
      )
      continue
    }
    const source = (m[1] as string).trim()
    const mechanism = (m[2] as string).trim()
    if (source.length === 0 || mechanism.length === 0) {
      errors.push(`"${line}" is missing a source or a mechanism — a Documentation line needs both.`)
      continue
    }
    const objectiveIds = m[3]
      ? [...(m[3] as string).matchAll(/O(\d+)/gi)].map((r) => Number.parseInt(r[1] as string, 10))
      : []
    sources.push({ source, mechanism, objectiveIds })
  }
  if (sources.length === 0 && errors.length === 0) {
    errors.push(
      'the `## Documentation` section has no well-formed `- <source> — <mechanism>` lines, and no `None` sentinel.'
    )
  }
  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, value: { kind: 'sources', sources } }
}

/** A source carrying a URL scheme (`https://`, `file://`, …) is never read as a repository path. */
export const DOCUMENTATION_SOURCE_SCHEME_RE = /[a-z][a-z0-9+.-]*:\/\//i

/** A repository-path source's path: its first inline code span when it has one, else the whole source, with a `#fragment` dropped. */
export function documentationSourcePath(source: string): string {
  const span = /`([^`]+)`/.exec(source)
  return (span ? (span[1] as string) : source).trim().replace(/#.*$/, '')
}

/**
 * Where a required source is read from, decided from its `## Documentation`
 * text alone: a public `https://` or `http://` page, a path in this
 * repository, or neither. A source with any other scheme, an absolute path,
 * or a path climbing out of the repository (`..`) names nothing that can
 * be prepared, so it is `unresolvable` with the reason spelled out.
 */
export type RequiredSourceLocator =
  | { kind: 'url'; url: string }
  | { kind: 'repository'; path: string }
  | { kind: 'unresolvable'; detail: string }

export function classifyDocumentationSource(source: string): RequiredSourceLocator {
  const trimmed = source.trim()
  if (/^https?:\/\//i.test(trimmed)) return { kind: 'url', url: trimmed }
  if (DOCUMENTATION_SOURCE_SCHEME_RE.test(trimmed)) {
    return {
      kind: 'unresolvable',
      detail: `\`${trimmed}\` carries a scheme that is neither a web page nor a repository path`
    }
  }
  const path = documentationSourcePath(trimmed)
  if (path.length === 0) return { kind: 'unresolvable', detail: 'the source names no page and no repository path' }
  if (path.startsWith('/') || path.split('/').includes('..')) {
    return { kind: 'unresolvable', detail: `\`${path}\` is not a path inside this repository` }
  }
  return { kind: 'repository', path: path.replace(/^\.\//, '') }
}

/**
 * Why a required source could not be prepared before the task's work starts —
 * the typed reason a `missing_source` pause carries for each one.
 *
 * - `login_required` — the page asked for credentials (HTTP 401, 403 or 407)
 *   or redirected to a sign-in page; a private document is never read.
 * - `other_host` — the page answered from a different host than the one the
 *   task names, so what would be read is not the named source.
 * - `not_a_document` — the answer was an error status, too little text to be
 *   the document, or a body whose end was never declared.
 * - `fetch_refused` — the fetch itself was refused: not https, a non-public
 *   address, a disallowed content type, an oversized body, too many redirects.
 * - `unreachable` — a timeout or a dropped connection, still failing after
 *   the provider's bounded retries.
 * - `missing_in_repository` — the repository path does not exist at the
 *   frozen base revision.
 * - `unresolvable` — the source names neither a page nor a repository path.
 */
export const REQUIRED_SOURCE_MISSING_REASONS = [
  'login_required',
  'other_host',
  'not_a_document',
  'fetch_refused',
  'unreachable',
  'missing_in_repository',
  'unresolvable'
] as const
export type RequiredSourceMissingReason = (typeof REQUIRED_SOURCE_MISSING_REASONS)[number]
