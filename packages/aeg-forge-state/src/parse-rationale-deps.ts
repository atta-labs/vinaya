export type ParsedRationaleDeps = {
  dependsOn: string[]
  conflictsWith: string[]
}

/**
 * The one grammar. These four constants ARE the "Dependency rationale"
 * grammar; `parseRationaleDeps` (reader) and `amendRationaleDeps` (writer, in
 * `amend-rationale-deps.ts`) are the only two functions allowed to read them —
 * never a second copy of the regexes. Exported so the writer shares this exact
 * grammar rather than duplicating it.
 */
export const SECTION_HEADER = /\*\*Dependency rationale\*\*/i
export const NEXT_HEADER = /\*\*[A-Z][^*]*\*\*/
export const FIELD_LABEL = /^(Depends-on|Conflicts-with)\s*:\s*(.*)$/i

/** A valid edge id: a bare task id (`1`, `7a`), a bare Issue ref (`#372`), or
 * a cross-tranche reference (`<slug> #372` / `<slug> 25`). Rejects plain
 * prose that happens to share a backtick span with a labeled field — e.g. a
 * `` `vinaya check` `` command-name mention inside the same "Dependency
 * rationale" paragraph (found in Issue #384's real body). */
export const ID_TOKEN = /^(?:[\w.-]+\s+)?#?\d+[a-z]?$/i

/** Splits a qualified id (`aeg-governance-hardening #368`) into its slug and
 * the bare remainder (`#368`); `null` slug for an already-bare id (`#372`,
 * `3`). */
const SLUG_QUALIFIED_ID = /^([\w.-]+)\s+(#?\d+[a-z]?)$/i

export type SlugQualifiedEdge = { slug: string; bareId: string }

/**
 * Splits a raw `Depends-on`/`Conflicts-with` edge string against
 * `SLUG_QUALIFIED_ID` — `null` for an edge with no slug qualifier (a bare
 * task id or a bare `#NNN`). Exported so every resolver of a cross-tranche
 * edge (`verify-dispatch.ts`'s `resolveDependsOn`/`resolveConflictsWith`,
 * `apps/cli`'s `edge-resolve.ts`) reuses this exact split instead of
 * re-deriving a second copy of the regex — one grammar, N consumers (#196).
 * Does not change what the grammar accepts; only exposes the existing split.
 */
export function splitSlugQualifiedEdge(edge: string): SlugQualifiedEdge | null {
  const m = edge.trim().match(SLUG_QUALIFIED_ID)
  if (!m) return null
  return { slug: m[1] as string, bareId: m[2] as string }
}

function isEmptyMarker(s: string): boolean {
  const t = s.trim()
  return t === '' || t === '—' || t === '-' || t === '–'
}

/** Appends only ids not already present — a labeled span's own comma list can
 * legitimately repeat an id (`` `Depends-on: 1, 1` ``), and the repeat carries
 * no new edge. Fixed on Issue #569, when a bare continuation span re-mentioning
 * an already-captured id still reached this list: the duplicate propagated all
 * the way to a React key collision in Vinaya Studio's task table. Issue #347
 * removed that path — no bare span reaches an edge list any more — so this now
 * guards only the within-span repeat. */
function pushUnique(arr: string[], ids: string[]): void {
  for (const id of ids) {
    if (!arr.includes(id)) arr.push(id)
  }
}

function splitIds(raw: string): string[] {
  if (isEmptyMarker(raw)) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !isEmptyMarker(s) && ID_TOKEN.test(s))
}

/**
 * Resolves each id in ONE labeled span's comma-joined list: a bare id (no slug
 * of its own) inherits the slug qualifier of the id immediately before it,
 * then that inheritance resets — a plain bare id (same-tranche reference) must
 * not silently pick up a stale cross-tranche slug from several ids back.
 * Confirmed real shape: Issue #388's body qualified its first id
 * (`aeg-governance-hardening #368`) and left the next one bare (`#372`) while
 * meaning the same slug — dropping the qualifier could misresolve `#372` as
 * this tranche's own issue instead of `aeg-governance-hardening`'s.
 *
 * Inheritance is scoped to a single span (Issue #347). It used to be carried
 * across spans by the caller, because bare continuation spans were parsed as
 * further values for the last-labeled field; they no longer are, so there is
 * no cross-span state left to carry. Issue #388's own body expressed that
 * sequence as separate spans and now declares only its labeled span's ids —
 * the qualified-then-bare shape survives here in its comma-joined form
 * (`` `Depends-on: aeg-governance-hardening #368, #372` ``), which is what
 * `amendRationaleDeps` writes.
 */
function resolveIds(raw: string): string[] {
  const ids = splitIds(raw)
  const resolved: string[] = []
  let lastSlug: string | null = null
  for (const id of ids) {
    const qualified = id.match(SLUG_QUALIFIED_ID)
    if (qualified) {
      lastSlug = qualified[1] ?? null
      resolved.push(id)
    } else if (lastSlug) {
      resolved.push(`${lastSlug} ${id}`)
      lastSlug = null
    } else {
      resolved.push(id)
    }
  }
  return resolved
}

/** Slices the "Dependency rationale" paragraph out of a full Issue body — up
 * to (not including) the next `**Bold Header**` marker, or end of body. Every
 * AEG Issue template section is a bold header at the start of its own
 * paragraph, never inline mid-sentence emphasis, so this boundary is safe. */
function extractSection(body: string): string {
  const start = body.match(SECTION_HEADER)
  if (!start || start.index === undefined) return ''
  const rest = body.slice(start.index + start[0].length)
  const next = rest.match(NEXT_HEADER)
  const end = next && next.index !== undefined ? next.index : rest.length
  return rest.slice(0, end)
}

/**
 * Parses `Depends-on`/`Conflicts-with` edges out of an Issue body's
 * "Dependency rationale" section. Edges come from a LABELED span only — a
 * single comma-joined backtick span carrying the field name, the topology
 * file's own cell convention and the form `amendRationaleDeps` writes:
 *
 *     `Depends-on: 1, 2`   `Conflicts-with: aeg-governance-hardening 25`
 *
 * Every other backtick span in the section is prose and contributes nothing.
 *
 * Narrowed on Issue #347. The reader previously scanned spans left-to-right
 * carrying forward whichever field was last labeled, so a bare span was
 * attributed to that field however far back the label sat. That tolerated a
 * multi-span writing convention — a labeled first span, then bare continuation
 * spans holding further values, with prose between them (found in Issue #383's
 * and Issue #429's real bodies; Issue #388's added a slug qualifier the bare
 * span had to inherit). It also meant any id-shaped span in the paragraph
 * became a declared edge: Issue #243's body, whose fields both read `—`,
 * parsed as conflicting with the three task ids its prose merely named. The
 * multi-span convention is no longer read; those bodies declare only their
 * labeled span's ids, and a body needing more edges states them in that span,
 * comma-separated — which is what the one sanctioned writer emits, so an
 * `amend-deps` rewrite of such a body round-trips unchanged.
 *
 * Each field is still assigned by its FIRST labeled span only. A later labeled
 * span for an already-assigned field is a prose re-mention — e.g. an Amendment
 * citing a removed historical value in backticks for readability
 * (`` `Depends-on: 2` `` describing a dropped edge) — not a fresh
 * re-declaration, and is ignored rather than resetting or extending that
 * field. Fixed on Issue #509: without this, the reader treated the historical
 * citation as a live edge, producing a self-referencing dependency once the
 * Issue was renumbered to that same task id.
 */
export function parseRationaleDeps(body: string): ParsedRationaleDeps {
  const section = extractSection(body)
  const dependsOn: string[] = []
  const conflictsWith: string[] = []
  const assignedFields = new Set<'dependsOn' | 'conflictsWith'>()

  const spanPattern = /`([^`]*)`/g
  let match: RegExpExecArray | null = spanPattern.exec(section)
  while (match !== null) {
    const content = (match[1] ?? '').trim()
    const labelMatch = content.match(FIELD_LABEL)
    if (labelMatch) {
      const field = labelMatch[1]?.toLowerCase() === 'conflicts-with' ? 'conflictsWith' : 'dependsOn'
      if (!assignedFields.has(field)) {
        assignedFields.add(field)
        const ids = resolveIds(labelMatch[2] ?? '')
        pushUnique(field === 'dependsOn' ? dependsOn : conflictsWith, ids)
      }
    }
    match = spanPattern.exec(section)
  }

  return { dependsOn, conflictsWith }
}
