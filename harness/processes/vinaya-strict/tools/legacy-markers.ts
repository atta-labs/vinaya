/**
 * The one module that spells the retired marker names.
 *
 * Pull-request bodies, archive comments and forge comment markers written
 * before the rename carry the old region prefix, the old provenance heading and
 * the old comment-marker prefix, and closed history is never
 * rewritten, so every reader accepts both spellings while every writer emits
 * only the new one. The kernel's region grammar names no spelling of its own —
 * its callers pass the prefixes they accept, and they take them from here.
 *
 * Each marker family exports its old spelling paired with its new one, so a
 * later program that rewrites old markers takes its old-to-new mapping from
 * this module and restates no old spelling.
 */

/** A marker family's retired spelling and the spelling every writer emits now. */
export type MarkerSpelling = { readonly old: string; readonly current: string }

/** The prefix of a pull-request body region: `<!-- <PREFIX>:<FIELD>:START -->`. */
export const REGION_PREFIX: MarkerSpelling = { old: 'AEG', current: 'VINAYA' }

/** The heading of the archive's provenance comment. */
export const PROVENANCE_HEADING: MarkerSpelling = {
  old: '### AEG provenance',
  current: '### Vinaya provenance'
}

/** The documentation claim anchor: `<!-- <ANCHOR>: <path> contains:<literal> -->`. */
export const CLAIM_ANCHOR: MarkerSpelling = { old: 'AEG:CLAIM', current: 'VINAYA:CLAIM' }

/** The quotes-file anchor pair: `<!-- <ANCHOR>:START:<path> -->` … `<!-- <ANCHOR>:END -->`. */
export const QUOTES_FILE_ANCHOR: MarkerSpelling = { old: 'AEG:QUOTES-FILE', current: 'VINAYA:QUOTES-FILE' }

/** The vendor-example anchor pair: `<!-- <ANCHOR>:START -->` … `<!-- <ANCHOR>:END -->`. */
export const VENDOR_EXAMPLE_ANCHOR: MarkerSpelling = {
  old: 'AEG:VENDOR-EXAMPLE',
  current: 'VINAYA:VENDOR-EXAMPLE'
}

/**
 * The prefix of a forge comment marker: `<!-- <prefix>:<family>… -->` on a
 * comment's, or a tracker Issue body's, first line. Rulings, round records and
 * frozen briefs on closed history keep the old prefix, so every reader matches
 * both, and every ordinal or version counted from those comments counts both
 * spellings together.
 */
export const COMMENT_MARKER_PREFIX: MarkerSpelling = { old: 'aeg', current: 'vinaya' }

function commentMarkerFamily(name: string): MarkerSpelling {
  return { old: `${COMMENT_MARKER_PREFIX.old}:${name}`, current: `${COMMENT_MARKER_PREFIX.current}:${name}` }
}

/** The frozen brief on a task Issue: `<!-- …:brief:v<k> -->`. */
export const FROZEN_BRIEF_MARKER: MarkerSpelling = commentMarkerFamily('brief')
/** The Developer's round record: `<!-- …:developer:round-<n> -->`. */
export const DEVELOPER_ROUND_MARKER: MarkerSpelling = commentMarkerFamily('developer:round')
/** The Developer's stop record: `<!-- …:developer:stop -->`. */
export const DEVELOPER_STOP_MARKER: MarkerSpelling = commentMarkerFamily('developer:stop')
/** The loop's published record: `<!-- …:loop:published head=<sha> confidence=<…> -->`. */
export const LOOP_PUBLISHED_MARKER: MarkerSpelling = commentMarkerFamily('loop:published')
/** The loop's paused record: `<!-- …:loop:paused:<reason> -->`. */
export const LOOP_PAUSED_MARKER: MarkerSpelling = commentMarkerFamily('loop:paused')
/** The loop's unpushed-work-resume record: `<!-- …:loop:unpushed-work-resume -->`. */
export const LOOP_UNPUSHED_WORK_RESUME_MARKER: MarkerSpelling = commentMarkerFamily('loop:unpushed-work-resume')
/** The Principal's ruling: `<!-- …:principal:ruling:<pr>-<k> -->`. */
export const PRINCIPAL_RULING_MARKER: MarkerSpelling = commentMarkerFamily('principal:ruling')
/** An objectives version: `<!-- …:objectives:v<k> -->`. */
export const OBJECTIVES_VERSION_MARKER: MarkerSpelling = commentMarkerFamily('objectives')
/** The deferred-findings tracker Issue's first body line: `<!-- …:deferred-findings:pr-<n> -->`. */
export const DEFERRED_FINDINGS_MARKER: MarkerSpelling = commentMarkerFamily('deferred-findings')

/** Every marker family and its old-to-new pair, for a program that rewrites old markers. */
export const MARKER_FAMILIES = {
  regionPrefix: REGION_PREFIX,
  provenanceHeading: PROVENANCE_HEADING,
  claimAnchor: CLAIM_ANCHOR,
  quotesFileAnchor: QUOTES_FILE_ANCHOR,
  vendorExampleAnchor: VENDOR_EXAMPLE_ANCHOR,
  commentMarkerPrefix: COMMENT_MARKER_PREFIX,
  frozenBrief: FROZEN_BRIEF_MARKER,
  developerRound: DEVELOPER_ROUND_MARKER,
  developerStop: DEVELOPER_STOP_MARKER,
  loopPublished: LOOP_PUBLISHED_MARKER,
  loopPaused: LOOP_PAUSED_MARKER,
  loopUnpushedWorkResume: LOOP_UNPUSHED_WORK_RESUME_MARKER,
  principalRuling: PRINCIPAL_RULING_MARKER,
  objectivesVersion: OBJECTIVES_VERSION_MARKER,
  deferredFindings: DEFERRED_FINDINGS_MARKER
} as const

/** The prefix a comment-marker writer emits. */
export const COMMENT_MARKER_PREFIX_CURRENT: string = COMMENT_MARKER_PREFIX.current

/** The comment-marker prefixes a reader accepts: the current one first, then the retired one. */
export const COMMENT_MARKER_PREFIXES: readonly string[] = [COMMENT_MARKER_PREFIX.current, COMMENT_MARKER_PREFIX.old]

/**
 * A non-capturing regular-expression alternation of every accepted
 * comment-marker prefix — `(?:vinaya|aeg)` — for a reader's marker pattern. It
 * captures nothing, so a pattern that adopts it keeps its own group numbers.
 */
export const COMMENT_MARKER_PREFIX_PATTERN: string = `(?:${COMMENT_MARKER_PREFIXES.join('|')})`

/** Both spellings of one marker family, the current one first — for a reader matching by literal text (a `startsWith`, an `includes`, a search phrase). */
export function markerSpellings(family: MarkerSpelling): readonly string[] {
  return [family.current, family.old]
}

/** The prefix a region writer emits. */
export const REGION_PREFIX_CURRENT: string = REGION_PREFIX.current

/** The prefixes a region reader accepts: the current one first, then the retired one. */
export const REGION_PREFIXES: readonly string[] = [REGION_PREFIX.current, REGION_PREFIX.old]

/** The provenance headings a reader accepts: the current one first, then the retired one. */
export const PROVENANCE_HEADINGS: readonly string[] = [PROVENANCE_HEADING.current, PROVENANCE_HEADING.old]

/** The claim anchors a reader accepts: the current one first, then the retired one. */
export const CLAIM_ANCHORS: readonly string[] = [CLAIM_ANCHOR.current, CLAIM_ANCHOR.old]

/** The quotes-file anchors a reader accepts: the current one first, then the retired one. */
export const QUOTES_FILE_ANCHORS: readonly string[] = [QUOTES_FILE_ANCHOR.current, QUOTES_FILE_ANCHOR.old]

/** The vendor-example anchors a reader accepts: the current one first, then the retired one. */
export const VENDOR_EXAMPLE_ANCHORS: readonly string[] = [VENDOR_EXAMPLE_ANCHOR.current, VENDOR_EXAMPLE_ANCHOR.old]

/** A regular-expression alternation, with no capture group, matching any one of the given anchor spellings. */
export function anchorAlternation(spellings: readonly string[]): string {
  return `(?:${spellings.map((spelling) => spelling.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`
}
