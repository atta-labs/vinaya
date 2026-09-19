/**
 * Objectives grammar. Pure — no `fs`,
 * no `fetch`, no `process.env`.
 *
 * A task Issue's `## Objectives` section: numbered `O<n>. <sentence>` lines,
 * one observable outcome each, contiguous from `O1`. This module is the one
 * parser and the one version hash every later consumer reads — the Issue
 * gate (`issue-validation.ts`'s `checkIssueObjectives`), the brief-side
 * copy/coverage gates (`brief-validation.ts`'s `checkObjectivesCopy`/
 * `checkObjectivesCoverage`), and the brief renderer (`brief-render.ts`,
 * copying the Issue's list into a brief via `renderObjectives`).
 *
 * An objective states an observable outcome, never a file path — the Brief
 * Author maps it to files in the brief's own surface map, not here.
 */

import { createHash } from 'node:crypto'
import { maskCode, maskDetailsBlocks } from '@attalabs/aeg-forge-state/strip-code'

export type Objective = { id: string; text: string }

export type ParsedObjectives = { ok: true; objectives: Objective[] } | { ok: false; errors: string[] }

const HEADING_RE = /^##[ \t]*Objectives[ \t]*$/im
const NEXT_HEADING_RE = /^##[ \t]/m
const OBJECTIVE_LINE_RE = /^O(\d+)\.[ \t]*(.*)$/

/**
 * `body` with every fenced/inline code span and collapsed `<details>` block
 * blanked to same-length filler — index-preserving, so a position found here
 * maps 1:1 onto `body` itself. Composed as `maskDetailsBlocks(maskCode(body))`
 * per `maskDetailsBlocks`'s own documented call order (`strip-code.ts`).
 *
 * Every heading search in this module runs against this masked view, never
 * the raw body: a pull request following this repo's own deliverable
 * template (`aeg-root/templates/pr-report-template.md`) pastes the full,
 * frozen brief — which, for a task with `O<n>.` objectives, always carries
 * its OWN `## Objectives` heading — inside a collapsed `<details>`
 * reference-copy block below the live report. Searching the raw body let
 * that reference-copy heading be mistaken for a live objectives section
 * (found live, security review: `hasObjectivesHeading`/`resolveObjectivesSource`
 * returned true/`{kind:'body'}` for a no-Issue PR carrying only the
 * reference copy, and `objectivesOf` then failed to parse the `</details>`
 * line it hit, refusing a verdict `review post` should have rendered with no
 * objectives block at all). One masked view, used everywhere this module
 * looks for a heading, closes the class rather than the one instance.
 */
function maskedForHeadingSearch(body: string): string {
  return maskDetailsBlocks(maskCode(body))
}

/**
 * True iff `text` contains a backticked span with a `/` inside it — one
 * signal an objective may be little more than a bare path. A manual
 * single-pass scan, not a regex: the natural regex shape for this,
 * `` /`[^`\n]*\/[^`\n]*`/ ``, is two unanchored wildcards separated by a
 * literal — quadratic on a line dense with backticks and no closing pair,
 * since the engine restarts the inner scan from every backtick position
 * (a MEDIUM security-review finding). This scan advances past each
 * checked span exactly once, so it stays linear in `text`'s length
 * regardless of how many backtick-shaped characters an attacker packs in.
 */
function hasBacktickedPath(text: string): boolean {
  let i = 0
  while (i < text.length) {
    const start = text.indexOf('`', i)
    if (start === -1) return false
    const end = text.indexOf('`', start + 1)
    if (end === -1) return false
    if (text.slice(start + 1, end).includes('/')) return true
    i = end + 1
  }
  return false
}

/**
 * How many non-path words an objective needs to count as a real sentence
 * rather than a dressed-up path reference. Mentioning a runtime path as
 * supporting detail inside an otherwise complete observable sentence is
 * fine — live task Issues do this routinely (a real Issue's own first
 * objective names an outbox path, later ones each name a source/spec path) — what the grammar
 * refuses is an objective that, once its backticked spans are removed, is
 * left with next to nothing: a path standing in for a sentence.
 */
const MIN_WORDS_OUTSIDE_BACKTICKS = 3

/** `text` with every backticked span removed — what remains is the sentence, if any, that isn't the path itself. */
function stripObjectiveBackticks(text: string): string {
  return text.replace(/`[^`\n]*`/g, ' ')
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length
}

/**
 * `[start, end)` char offsets of the `## Objectives` section — from its
 * heading line to the next `##` heading, or the end of `body` — or `null`
 * when no heading is found. `objectivesSectionText` and
 * `body-bare-digits-logic.ts`'s `O<n>.`-prefix exemption (task-run-v1, O2)
 * both locate the identical span through this one function, so the two
 * can never disagree on where the section starts or ends.
 */
export function objectivesSectionBounds(body: string): { start: number; end: number } | null {
  const masked = maskedForHeadingSearch(body)
  const heading = HEADING_RE.exec(masked)
  if (!heading) return null
  const start = heading.index + heading[0].length
  const afterHeading = masked.slice(start)
  const next = NEXT_HEADING_RE.exec(afterHeading)
  return { start, end: next ? start + next.index : body.length }
}

/** The `## Objectives` section's raw text (from its heading line to the next `##` heading, or the end), or `null` when no heading is found. */
function objectivesSectionText(body: string): string | null {
  const bounds = objectivesSectionBounds(body)
  return bounds === null ? null : body.slice(bounds.start, bounds.end)
}

/**
 * True when `body` carries a `## Objectives` heading at all, regardless of
 * whether the section under it parses. Callers that decide WHETHER the
 * objectives checks apply at all (a standalone brief with no task Issue to
 * compare against, `verify-brief.ts`/`check-brief-shape.ts`) use this to
 * distinguish "no section attempted — not required" from "a section exists
 * and must parse" — `objectivesOf` alone conflates the two into one
 * `ok: false`.
 */
export function hasObjectivesHeading(body: string): boolean {
  return HEADING_RE.test(maskedForHeadingSearch(body))
}

/**
 * Parses a `## Objectives` section into its numbered lines. Refuses — never
 * silently drops — a missing heading, a line that isn't `O<n>. <sentence>`
 * shaped (an `O1:` or `1.` line), an objective with no sentence, a sentence
 * naming a file path in backticks, or numbering that isn't contiguous from
 * `O1`.
 */
export function objectivesOf(body: string): ParsedObjectives {
  const section = objectivesSectionText(body)
  if (section === null) {
    return { ok: false, errors: ['no `## Objectives` heading found in the body.'] }
  }

  const lines = section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (lines.length === 0) {
    return { ok: false, errors: ['the `## Objectives` section has no `O<n>.` lines.'] }
  }

  const objectives: Objective[] = []
  const errors: string[] = []

  for (const line of lines) {
    const m = OBJECTIVE_LINE_RE.exec(line)
    if (!m) {
      errors.push(`"${line}" is not a well-formed objective line — expected \`O<n>. <sentence>\`, e.g. \`O1. …\`.`)
      continue
    }
    const n = m[1] as string
    const text = (m[2] as string).trim()
    if (text.length === 0) {
      errors.push(`O${n} has no sentence — every objective is one observable sentence.`)
      continue
    }
    if (hasBacktickedPath(text) && wordCount(stripObjectiveBackticks(text)) < MIN_WORDS_OUTSIDE_BACKTICKS) {
      errors.push(
        `O${n} is little more than a file path — an objective states an observable outcome, never a bare path (the Planner maps it to files).`
      )
      continue
    }
    objectives.push({ id: `O${n}`, text })
  }

  for (let i = 0; i < objectives.length; i++) {
    const expected = i + 1
    const actual = Number.parseInt((objectives[i] as Objective).id.slice(1), 10)
    if (actual !== expected) {
      errors.push(
        `numbering is not contiguous from O1 — expected O${expected}, found ${(objectives[i] as Objective).id}.`
      )
      break
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return { ok: true, objectives }
}

/** Normalises one objective's text for hashing/comparison: trimmed, internal whitespace collapsed to single spaces — an editor's reflow must not move the version. */
function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ')
}

/**
 * A stable hash of an objectives list's TEXT — normalised lines, never the
 * rendered markdown, so whitespace an editor reflows does not move the
 * version. Two lists with the same ids and normalised text hash identically;
 * changing one word, or the list itself, changes the hash.
 */
export function objectivesVersion(objectives: Objective[]): string {
  const normalized = objectives.map((o) => `${o.id} ${normalizeText(o.text)}`).join('\n')
  return createHash('sha256').update(normalized).digest('hex')
}

/**
 * Renders a `## Objectives` section from a parsed list — the inverse of
 * `objectivesOf`, used by `brief-render.ts` to copy the Issue's list into
 * a brief verbatim.
 */
export function renderObjectives(objectives: Objective[]): string {
  return ['## Objectives', '', ...objectives.map((o) => `${o.id}. ${o.text}`)].join('\n')
}

/**
 * Is a `gh issue view` failure just "the Issue number doesn't resolve" — a
 * fixture's placeholder `Closes #NNN`, a deleted Issue — as opposed to a
 * real network/auth/rate-limit failure? Only the first is safe for a
 * caller to treat as "nothing to compare"; the second means the comparison
 * was SKIPPED, not that it passed, and a caller that conflates the two
 * silently stops enforcing whenever enforcement is hardest to verify (a
 * flaky network, an expiring token) — exactly the gap review round 1
 * found independently in both `verify-brief.ts` and `check-brief-shape.ts`
 * (review finding 4). One shared, tested classifier — not a second
 * hand-written copy per caller — is what keeps the two from silently
 * drifting apart on which error strings mean which case (review round 2,
 * MINOR).
 *
 * Pure: takes the already-caught error, never runs `gh` itself — each
 * caller keeps its own tiny `execFileSync` invocation (this module stays
 * `fs`/`fetch`/`process.env`-free, same as every other function here), and
 * passes the resulting error into this one shared decision.
 *
 * Inspects the WHOLE error (message + stderr), since `execFileSync` puts
 * `gh`'s actual GraphQL text on a line that is rarely the first — the same
 * discipline `apps/cli/src/lib/config.ts`'s `isMissingFileError` uses.
 */
export function isIssueNotFoundError(err: unknown): boolean {
  const stderr = (err as { stderr?: Buffer | string })?.stderr
  const haystack = [
    (err as Error)?.message ?? '',
    typeof stderr === 'string' ? stderr : (stderr?.toString() ?? '')
  ].join('\n')
  return /could not resolve to an (?:issue|pull request)|\b404\b|not found/i.test(haystack)
}

/**
 * WHERE a pull request's objectives come from — before anything is fetched
 * or parsed. `check-review-gate.ts`'s
 * `resolveObjectivesVersion` and `review-post.ts`'s `resolveObjectivesForPr`
 * had each hand-rolled this identical three-way branch — an Issue at/above
 * the cutover wins, then the PR body's own `## Objectives` heading, then
 * neither — with the Issue-vs-cutover branch order kept in sync by hand
 * between the two files (a real history: a missing early pre-cutover
 * return in one of them let a pre-cutover Issue fall through to the body's
 * section). One function, one place the three-way decision is made; both
 * callers switch on its result instead of re-deriving it.
 *
 * Pure and I/O-free by design — it takes the already-extracted Issue number
 * and the PR body text, never fetches either. Fetching the Issue body,
 * parsing it, and turning a parse failure into a refusal are each caller's
 * OWN concern (a check-run emits `emitCheckError`+`process.exit`, the CLI
 * command calls `refuseCmd`) and stay out of this function on purpose: this resolver
 * decides the SOURCE, not what the gate requires once a source exists, and
 * the loop's own principal-gated Issue read
 * substitutes its own fetcher for the `'issue'` case rather than this
 * function reading anything itself.
 *
 * `cutoverIssue` is `OBJECTIVES_SINCE_ISSUE` (`issue-validation.ts`) — passed
 * in, not imported, because `issue-validation.ts` already imports FROM this
 * module (`objectivesOf`); importing the constant back would be circular.
 */
export type ObjectivesSource = { kind: 'issue'; issue: number } | { kind: 'body' } | { kind: 'none' }

export function resolveObjectivesSource(prBody: string, issue: number | null, cutoverIssue: number): ObjectivesSource {
  // Checked first and unconditionally: a pre-cutover Issue is `'none'`
  // regardless of what the PR body itself carries — a pre-cutover PR must
  // keep passing unchanged, never picking up a body-level objectives list
  // the Issue-linked case was never subject to.
  if (issue !== null && issue < cutoverIssue) return { kind: 'none' }
  if (issue !== null) return { kind: 'issue', issue }
  if (hasObjectivesHeading(prBody)) return { kind: 'body' }
  return { kind: 'none' }
}
