/**
 * Milestone-shape validation for `vinaya milestone create`. Pure — no `fs`, no `gh`. The command calls `checkMilestoneShape` before
 * any forge write, so a malformed body never reaches GitHub.
 *
 * A Milestone's description carries three independent things, each parsed and
 * removed from the remainder in turn: an optional `Release:` field (the sole
 * authority for the milestone's version — never the title), an optional
 * `### Tranche intents` section (one bullet per tranche this milestone will
 * eventually hold, `- <slug>: <intent text>`), and the goal (whatever prose is
 * left once both are removed). The goal is mandatory; `Release:` and the
 * intents section are each optional but must parse if present.
 */

import { stripCode } from '@attalabs/aeg-forge-state'

export type MilestoneIntent = { slug: string; goal: string }

export type ReleaseField = {
  /** A `Release:` field line exists outside code. Says nothing about whether its value parsed. */
  declared: boolean
  /** The parsed version string, or `null` when absent or malformed. */
  value: string | null
}

export type MilestoneShapeResult =
  | { status: 'pass'; goal: string; release: string | null; intents: MilestoneIntent[] }
  | { status: 'fail'; errors: string[] }

/**
 * Line-anchored, `**`-optional on both sides, same shape as `PROJECT_FIELD`
 * (`@attalabs/aeg-forge-state`'s `list-tasks.ts`) — the reference grammar this
 * field is deliberately matched against rather than approximated. Un-global
 * and `.exec`'d once: first match wins.
 */
const RELEASE_FIELD = /^\s*(?:\*\*)?Release(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+)$/im

/** Peels the markup/punctuation a field value carries in prose — same edge set as `unwrapValue`. */
const VALUE_EDGE_MARKUP = /^[`.;\s]+|[`.;\s]+$/g

function unwrapValue(raw: string): string {
  return raw.replace(/\*\*/g, '').replace(VALUE_EDGE_MARKUP, '')
}

/** A semver-shaped version: optional `v` prefix, `MAJOR.MINOR.PATCH`, optional pre-release/build. */
const RELEASE_VALUE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/

/** Text with code fences/indented blocks stripped, inline spans kept — same reading `PROJECT_FIELD` uses. */
function pathText(body: string): string {
  return stripCode(body, { inlineSpans: 'keep' })
}

/** The actual reader, over already-stripped text — shared so `checkMilestoneShape` (which already holds `text`) never pays for a second `stripCode` pass over the same body. */
function releaseFieldFromText(text: string): ReleaseField {
  const m = text.match(RELEASE_FIELD)
  if (!m) return { declared: false, value: null }
  const raw = unwrapValue(m[1] ?? '')
  return { declared: true, value: RELEASE_VALUE.test(raw) ? raw : null }
}

/**
 * Reads the `Release:` field. `declared: true, value: null` is the malformed
 * case — the field exists but its value isn't a version — distinct from
 * `declared: false` (no field at all, which is a valid, versionless milestone).
 */
export function releaseFieldFromBody(body: string): ReleaseField {
  return releaseFieldFromText(pathText(body))
}

const INTENTS_HEADING = /^#{1,6}\s*Tranche intents\s*$/im
const NEXT_HEADING = /^#{1,6}\s+\S/m
const INTENT_BULLET = /^-\s+([a-z0-9][a-z0-9-]*)\s*:\s*(.+)$/i

/** The intents heading's own span plus its section body — `null` when there is no heading at all. */
function intentsBlock(text: string): { start: number; end: number; section: string } | null {
  const start = text.match(INTENTS_HEADING)
  if (!start || start.index === undefined) return null
  const rest = text.slice(start.index + start[0].length)
  const next = rest.match(NEXT_HEADING)
  const sectionEnd = next && next.index !== undefined ? next.index : rest.length
  return { start: start.index, end: start.index + start[0].length + sectionEnd, section: rest.slice(0, sectionEnd) }
}

/** Slices the intents section out of `pathText(body)` — from just after the heading to the next heading or end. */
function intentsSectionText(text: string): string | null {
  return intentsBlock(text)?.section ?? null
}

/**
 * Parses the `### Tranche intents` section, if present. `null` means no
 * heading at all (a valid, intent-less milestone). A heading whose non-blank
 * lines don't all match the bullet grammar is malformed — reported via
 * `malformed: true` rather than silently dropping the bad line, mirroring
 * `ProjectField.unparsed`'s fail-closed discipline.
 */
function parseIntents(text: string): { intents: MilestoneIntent[]; malformed: boolean } {
  const section = intentsSectionText(text)
  if (section === null) return { intents: [], malformed: false }

  const intents: MilestoneIntent[] = []
  for (const line of section.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    const m = trimmed.match(INTENT_BULLET)
    if (!m) return { intents: [], malformed: true }
    intents.push({ slug: (m[1] ?? '').toLowerCase(), goal: (m[2] ?? '').trim() })
  }
  return { intents, malformed: false }
}

/** Removes the first `Release:` line and the whole intents section (heading included) from `pathText(body)`. */
function goalRemainder(text: string): string {
  const withoutRelease = text.replace(RELEASE_FIELD, '')
  const block = intentsBlock(withoutRelease)
  const remainder = block ? withoutRelease.slice(0, block.start) + withoutRelease.slice(block.end) : withoutRelease
  return remainder.trim()
}

/**
 * Refuses a milestone body before any forge write: the goal absent, `Release:`
 * present but malformed, or the intents section unparseable. Shape-guarded
 * only — like `checkIssueRationale`, this checks presence/well-formedness,
 * never whether the content is right.
 */
export function checkMilestoneShape(body: string): MilestoneShapeResult {
  const errors: string[] = []
  const text = pathText(body)

  const release = releaseFieldFromText(text)
  if (release.declared && release.value === null) {
    errors.push(
      'milestone-validation Release: the `Release:` field is present but is not a version — ' +
        'write a semver value (e.g. `Release: 1.2.0`), or omit the field entirely for a milestone that declares no version.'
    )
  }

  const { intents, malformed } = parseIntents(text)
  if (malformed) {
    errors.push(
      'milestone-validation intents: the `### Tranche intents` section does not parse — every non-blank ' +
        'line under it must read `- <slug>: <intent text>`.'
    )
  }

  const goal = goalRemainder(text)
  if (goal.length === 0) {
    errors.push(
      'milestone-validation goal: no goal text — a milestone description must carry prose beyond its ' +
        '`Release:` field and `### Tranche intents` section.'
    )
  }

  if (errors.length > 0) return { status: 'fail', errors }
  return { status: 'pass', goal, release: release.value, intents }
}

// ---------------------------------------------------------------------------
// `vinaya milestone adopt` — checkAdoptable
// ---------------------------------------------------------------------------

/**
 * One requested slug's forge facts, gathered by the CLI before any write.
 * `checkAdoptable` never fetches — the caller does one bounded round of
 * reads (the repo's label list, the repo's Milestone list, and one
 * `vinaya/tranche:<slug>`-labeled Issue list per requested slug) and hands
 * the results in as plain data.
 */
export type AdoptSlugFacts = {
  slug: string
  /** Whether `vinaya/tranche:<slug>` exists as a real label in this repo. */
  labelExists: boolean
  /** Issue numbers currently carrying the label, any state. */
  issueNumbers: number[]
  /**
   * Native-milestone titles this slug's Issues are CURRENTLY attached to,
   * excluding `null` (unattached — the ordinary state for a label-only
   * tranche that has never been adopted), the slug itself (its own legacy
   * 1:1 tranche-Milestone — the ordinary pre-adopt state for a
   * legacy-titled tranche), and the requested target (already adopted here,
   * a harmless no-op re-run). What remains is exactly "attached to some
   * OTHER Milestone" — evidence of a prior `adopt` into a different target.
   * Empty when none.
   */
  adoptedElsewhere: string[]
}

/** The target Milestone's forge facts. */
export type AdoptTargetFacts = {
  title: string
  exists: boolean
  state: 'open' | 'closed' | null
}

export type AdoptFacts = {
  target: AdoptTargetFacts
  slugs: AdoptSlugFacts[]
}

export type AdoptResult = { status: 'pass' } | { status: 'fail'; errors: string[] }

/**
 * Refuses an `adopt` invocation before any forge write. Four independent
 * checks — an unknown slug, a slug whose label carries no Issues, a target
 * that does not exist or is closed, and a slug already adopted into a
 * different Milestone — evaluated over the WHOLE batch of requested slugs at
 * once, so one bad slug in a multi-slug invocation blocks every slug in that
 * invocation, not just its own: a half-applied adopt leaves Issues split
 * across two Milestones with no undo. Pure: takes already-gathered facts,
 * fetches nothing, writes nothing.
 */
export function checkAdoptable(facts: AdoptFacts): AdoptResult {
  const errors: string[] = []

  if (!facts.target.exists) {
    errors.push(
      `milestone-adopt target: Milestone "${facts.target.title}" does not exist — create it first with \`vinaya milestone create\`.`
    )
  } else if (facts.target.state === 'closed') {
    errors.push(`milestone-adopt target: Milestone "${facts.target.title}" is closed — adopt requires an open target.`)
  }

  for (const s of facts.slugs) {
    if (!s.labelExists) {
      errors.push(`milestone-adopt unknown-slug: no \`vinaya/tranche:${s.slug}\` label exists in this repo.`)
      continue
    }
    if (s.issueNumbers.length === 0) {
      errors.push(`milestone-adopt no-issues: \`vinaya/tranche:${s.slug}\` carries no Issues — nothing to adopt.`)
      continue
    }
    if (s.adoptedElsewhere.length > 0) {
      errors.push(
        `milestone-adopt already-adopted: "${s.slug}" is already adopted into "${s.adoptedElsewhere.join('", "')}" — adopt it from there, not from here.`
      )
    }
  }

  if (errors.length > 0) return { status: 'fail', errors }
  return { status: 'pass' }
}
