/**
 * Objectives grammar (dev-review-loop-v1 task 1, Issue #411). Pure — no `fs`,
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

export type Objective = { id: string; text: string }

export type ParsedObjectives = { ok: true; objectives: Objective[] } | { ok: false; errors: string[] }

const HEADING_RE = /^##[ \t]*Objectives[ \t]*$/im
const NEXT_HEADING_RE = /^##[ \t]/m
const OBJECTIVE_LINE_RE = /^O(\d+)\.[ \t]*(.*)$/

/** A path-shaped token inside backticks — one signal an objective may be little more than a bare path. */
const BACKTICKED_PATH_RE = /`[^`\n]*\/[^`\n]*`/

/**
 * How many non-path words an objective needs to count as a real sentence
 * rather than a dressed-up path reference. Mentioning a runtime path as
 * supporting detail inside an otherwise complete observable sentence is
 * fine — live task Issues do this routinely (Issue #404's own O1 names an
 * outbox path, O2 and O3 each name a source/spec path) — what the grammar
 * refuses is an objective that, once its backticked spans are removed, is
 * left with next to nothing: a path standing in for a sentence.
 */
const MIN_WORDS_OUTSIDE_BACKTICKS = 3

/** `text` with every backticked span removed — what remains is the sentence, if any, that isn't the path itself. */
function stripBackticks(text: string): string {
  return text.replace(/`[^`\n]*`/g, ' ')
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[a-z]/i.test(w)).length
}

/** The `## Objectives` section's raw text (from its heading line to the next `##` heading, or the end), or `null` when no heading is found. */
function objectivesSectionText(body: string): string | null {
  const heading = HEADING_RE.exec(body)
  if (!heading) return null
  const afterHeading = body.slice(heading.index + heading[0].length)
  const next = NEXT_HEADING_RE.exec(afterHeading)
  return next ? afterHeading.slice(0, next.index) : afterHeading
}

/**
 * Parses a `## Objectives` section into its numbered lines. Refuses — never
 * silently drops — a missing heading, a line that isn't `O<n>. <sentence>`
 * shaped (an `O1:` or `1.` line), an objective with no sentence, a sentence
 * naming a file path in backticks, or numbering that isn't contiguous from
 * `O1`.
 */
export function parseObjectives(body: string): ParsedObjectives {
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
    const [, n, rawText] = m as [string, string, string]
    const text = rawText.trim()
    if (text.length === 0) {
      errors.push(`O${n} has no sentence — every objective is one observable sentence.`)
      continue
    }
    if (BACKTICKED_PATH_RE.test(text) && wordCount(stripBackticks(text)) < MIN_WORDS_OUTSIDE_BACKTICKS) {
      errors.push(
        `O${n} is little more than a file path — an objective states an observable outcome, never a bare path (the Brief Author maps it to files).`
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
 * `parseObjectives`, used by `brief-render.ts` to copy the Issue's list into
 * a brief verbatim.
 */
export function renderObjectives(objectives: Objective[]): string {
  return ['## Objectives', '', ...objectives.map((o) => `${o.id}. ${o.text}`)].join('\n')
}
