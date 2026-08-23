/**
 * Milestone-shape validation for `vinaya milestone create` (vinaya-milestone-model-v1
 * task 2). Pure — no `fs`, no `gh`. The command calls `checkMilestoneShape` before
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

/**
 * Reads the `Release:` field. `declared: true, value: null` is the malformed
 * case — the field exists but its value isn't a version — distinct from
 * `declared: false` (no field at all, which is a valid, versionless milestone).
 */
export function releaseFieldFromBody(body: string): ReleaseField {
  const m = pathText(body).match(RELEASE_FIELD)
  if (!m) return { declared: false, value: null }
  const raw = unwrapValue(m[1] ?? '')
  return { declared: true, value: RELEASE_VALUE.test(raw) ? raw : null }
}

const INTENTS_HEADING = /^#{1,6}\s*Tranche intents\s*$/im
const NEXT_HEADING = /^#{1,6}\s+\S/m
const INTENT_BULLET = /^-\s+([a-z0-9][a-z0-9-]*)\s*:\s*(.+)$/i

/** Slices the intents section out of `pathText(body)` — from just after the heading to the next heading or end. */
function intentsSectionText(text: string): string | null {
  const start = text.match(INTENTS_HEADING)
  if (!start || start.index === undefined) return null
  const rest = text.slice(start.index + start[0].length)
  const next = rest.match(NEXT_HEADING)
  const end = next && next.index !== undefined ? next.index : rest.length
  return rest.slice(0, end)
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
  let remainder = text.replace(RELEASE_FIELD, '')
  const start = remainder.match(INTENTS_HEADING)
  if (start && start.index !== undefined) {
    const rest = remainder.slice(start.index + start[0].length)
    const next = rest.match(NEXT_HEADING)
    const end = next && next.index !== undefined ? next.index : rest.length
    remainder = remainder.slice(0, start.index) + rest.slice(end)
  }
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

  const release = releaseFieldFromBody(body)
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
