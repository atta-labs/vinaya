/**
 * Test plan proof. Pure — no `fs`, no `fetch`, no `process.env`.
 *
 * A task Issue's objectives and its `## Test plan` refer to each other:
 *
 *   - a fenced line names the objective ids it proves after its expected
 *     observable — `<command> → <observable> (O1, O2)`. The ids sit AFTER the
 *     arrow because the evidence step cuts a line at the first `→` and runs
 *     what is before it; ids before the arrow would become part of the command.
 *   - a `**[principal]**` or `**[live]**` item names them inside one code span
 *     — `` `(O2)` `` — because the item is copied into the pull request body,
 *     where a digit outside code is refused.
 *
 * The rule refuses an objective nothing proves, a line or item that proves
 * nothing or cites an id the Issue does not define, a fenced line with no
 * expected observable, and the `unit-tests-only` sentinel (it names no proof).
 *
 * It passes when the Objectives section or the Test plan section does not
 * parse: other rules report those.
 */

import { extractFencedBlocks } from './brief-validation'
import { objectivesOf } from './objectives'
import { locateTestPlanSection } from './test-plan-section'

export type TestPlanProofResult = { status: 'pass' | 'fail'; errors: string[] }

const PRINCIPAL_LINE_RE = /^-\s*\[[ xX]\]\s*\*{2}\[principal\]\*{2}(.*)$/gim
const LIVE_LINE_RE = /^-\s*\*{2}\[live\]\*{2}(.*)$/gim
const SENTINEL_RE = /(?:\*\*)?Test plan(?:\*\*)?\s*:\s*(?:\*\*)?\s*unit-tests-only/i

/** `O1, O2` — the id list, without its parentheses. */
const ID_LIST = String.raw`O\d+(?:\s*,\s*O\d+)*`
/** A fenced line's trailing `(O1, O2)`. */
const LINE_IDS_RE = new RegExp(String.raw`\(\s*(${ID_LIST})\s*\)\s*$`)
/** One code span holding only an id list, parentheses optional: `` `(O2)` ``. */
const ITEM_IDS_SPAN_RE = new RegExp(String.raw`(?<!\`)(\`+)\s*\(?\s*(${ID_LIST})\s*\)?\s*\1(?!\`)`, 'g')

function idsOf(list: string): string[] {
  return [...list.matchAll(/O\d+/g)].map((m) => m[0])
}

/** `text` with every id-list code span removed — an item's command, without the objectives it proves. */
export function stripObjectiveIdSpans(text: string): string {
  return text.replace(ITEM_IDS_SPAN_RE, '').trim()
}

/** The objective ids an item names inside code spans. */
function itemIds(text: string): string[] {
  return [...text.matchAll(ITEM_IDS_SPAN_RE)].flatMap((m) => idsOf(m[2] as string))
}

type Proof = { quoted: string; ids: string[] }

/** One fenced line cut at its first arrow: its observable and the ids it names. */
function readLine(line: string): { observable: string | null; ids: string[] } {
  const arrow = line.indexOf('→')
  if (arrow === -1) return { observable: null, ids: [] }
  const after = line.slice(arrow + 1).trim()
  const match = LINE_IDS_RE.exec(after)
  const observable = (match === null ? after : after.slice(0, match.index)).trim()
  const hasContent = /[\p{L}\p{N}]/u.test(observable)
  return { observable: hasContent ? observable : null, ids: match === null ? [] : idsOf(match[1] as string) }
}

export function checkTestPlanProof(body: string): TestPlanProofResult {
  const located = locateTestPlanSection(body)
  const objectives = objectivesOf(body)
  if (!located.found || !objectives.ok) return { status: 'pass', errors: [] }

  const region = located.section
  const blocks = extractFencedBlocks(region)
  const errors: string[] = []
  const prefix = 'issue-validation Test plan/proof:'

  if (SENTINEL_RE.test(region)) {
    // Both forms together is the exclusivity rule's finding, not this one's.
    if (blocks.length > 0) return { status: 'pass', errors: [] }
    errors.push(
      `${prefix} the \`unit-tests-only\` sentinel names no proof for any objective — name the test files as fenced \`## Test plan\` lines, each \`<command> → <observable> (O1, O2)\` ending in the objective ids it proves.`
    )
    return { status: 'fail', errors }
  }

  const defined = new Set(objectives.objectives.map((o) => o.id))
  const proven = new Set<string>()
  const proofs: Proof[] = []

  const lines = blocks.flatMap((b) =>
    b.content
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
  )
  for (const line of lines) {
    const read = readLine(line)
    if (read.observable === null) {
      errors.push(
        `${prefix} \`${line}\` has no expected observable — write \`<command> → <observable> (O1)\`, the observable after the arrow and the objective ids after the observable.`
      )
      continue
    }
    proofs.push({ quoted: line, ids: read.ids })
  }

  for (const [re, label] of [
    [PRINCIPAL_LINE_RE, '[principal]'],
    [LIVE_LINE_RE, '[live]']
  ] as const) {
    for (const m of region.matchAll(re)) {
      const text = (m[1] ?? '').trim()
      if (text.length === 0) continue
      proofs.push({ quoted: `${label} ${text}`, ids: itemIds(text) })
    }
  }

  for (const proof of proofs) {
    if (proof.ids.length === 0) {
      errors.push(
        `${prefix} \`${proof.quoted}\` names no objective id — a fenced line ends with \`(O1, O2)\` after its observable; a \`**[principal]**\` or \`**[live]**\` item carries its ids in one code span, such as \`(O1)\` in backticks.`
      )
      continue
    }
    for (const id of proof.ids) {
      if (!defined.has(id)) {
        errors.push(
          `${prefix} \`${proof.quoted}\` names ${id}, which the Issue's own \`## Objectives\` section does not define.`
        )
      } else {
        proven.add(id)
      }
    }
  }

  for (const objective of objectives.objectives) {
    if (!proven.has(objective.id)) {
      errors.push(
        `${prefix} ${objective.id} is proven by no fenced \`## Test plan\` line, no \`**[principal]**\` item and no \`**[live]**\` item — add its id to a line that proves it, or add the line.`
      )
    }
  }

  return { status: errors.length > 0 ? 'fail' : 'pass', errors }
}
