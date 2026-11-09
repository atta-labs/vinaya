/**
 * The one module that spells the retired marker names.
 *
 * Pull-request bodies and archive comments written before the rename carry the
 * old region prefix and the old provenance heading, and closed history is never
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

/** Every marker family and its old-to-new pair, for a program that rewrites old markers. */
export const MARKER_FAMILIES = {
  regionPrefix: REGION_PREFIX,
  provenanceHeading: PROVENANCE_HEADING
} as const

/** The prefix a region writer emits. */
export const REGION_PREFIX_CURRENT: string = REGION_PREFIX.current

/** The prefixes a region reader accepts: the current one first, then the retired one. */
export const REGION_PREFIXES: readonly string[] = [REGION_PREFIX.current, REGION_PREFIX.old]

/** The provenance headings a reader accepts: the current one first, then the retired one. */
export const PROVENANCE_HEADINGS: readonly string[] = [PROVENANCE_HEADING.current, PROVENANCE_HEADING.old]
