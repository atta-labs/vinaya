/**
 * The process terms a neutral task statement must not contain. A layer-`G`
 * case states its task in the Development Process vocabulary only, so the
 * same statement can be handed to any process; a word that belongs to
 * Vinaya's own artifacts — its brief, its Surface, its objectives and their
 * ids, its reviewers' verdicts, severities and finding ids, its role names —
 * would make the case readable only by that process.
 *
 * This module is the one place the term list lives. Every caller, the neutral
 * case validator among them, asks `findBannedTerms` or `checkTaskStatement`.
 */

import type { ContractRefusal, Validated } from './contracts'

/** One banned term: the name a refusal reports, and the pattern that finds it. */
export interface BannedTerm {
  term: string
  pattern: RegExp
}

const word = (term: string, plural = true): BannedTerm => ({
  term,
  pattern: new RegExp(`\\b${term}${plural ? 's?' : ''}\\b`, 'i')
})

/**
 * Reviewer severity names are matched as the scales write them, in capitals,
 * so ordinary English ("a high-traffic route", "low latency") stays allowed.
 */
const severity = (term: string): BannedTerm => ({ term, pattern: new RegExp(`\\b${term}\\b`) })

export const BANNED_TERMS: readonly BannedTerm[] = [
  word('Surface'),
  word('objective'),
  word('brief'),
  word('verdict'),
  // The code reviewer's scale, then the security reviewer's.
  severity('BLOCKER'),
  severity('MAJOR'),
  severity('MINOR'),
  severity('CRITICAL'),
  severity('HIGH'),
  severity('MEDIUM'),
  severity('LOW'),
  // An objective id: `O1`, `O12`.
  { term: 'objective id', pattern: /\bO\d+\b/ },
  // A finding id: a reviewer's own `F3`, or the round-qualified `R2-CR-3` and `R2-SEC-1`.
  { term: 'finding id', pattern: /\bR\d+-(?:CR|SEC)-\d+\b|\bF\d+\b/ },
  // Role names. A hyphenated or two-word role (`code-reviewer`,
  // `tranche archivist`) is found by its last word.
  word('principal'),
  word('planner'),
  word('architect'),
  word('archivist'),
  word('developer'),
  word('reviewer'),
  word('operator')
]

/** Where one banned term was found in a statement. */
export interface BannedTermHit {
  term: string
  match: string
  index: number
}

/** The marker an Interface block opens with. */
const INTERFACE_MARKER = ' Interface: '

/** The kinds an Interface item is labelled with, in the order the block lists them. */
export const INTERFACE_ITEM_KINDS = ['export', 'file', 'env', 'flag', 'event', 'field', 'key', 'string'] as const

/**
 * An item's text as an Interface code span: fenced by one backtick more than
 * the longest run of backticks the text holds, so the text cannot close its
 * own span, and padded with a space on each side when it starts or ends with
 * a backtick, as a Markdown code span is written.
 */
export function interfaceCodeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/**
 * Where the text of each code span of a whole Interface block lies, between
 * its fences: the block is the marker, then items `<kind> <code span>`
 * separated by `; `, and a full stop that ends the statement. A span closes at
 * the first run of exactly as many backticks as opened it. `null` when the
 * block is not well formed.
 */
function interfaceSpans(block: string): { from: number; to: number }[] | null {
  if (!block.startsWith(INTERFACE_MARKER)) return null
  const spans: { from: number; to: number }[] = []
  let at = INTERFACE_MARKER.length
  for (;;) {
    const kind = INTERFACE_ITEM_KINDS.find((k) => block.startsWith(`${k} \``, at))
    if (kind === undefined) return null
    at += kind.length + 1
    const fence = (/^`+/.exec(block.slice(at)) as RegExpExecArray)[0]
    const from = at + fence.length
    const runs = /`+/g
    runs.lastIndex = from
    let close: RegExpExecArray | null = runs.exec(block)
    while (close !== null && close[0].length !== fence.length) close = runs.exec(block)
    if (close === null || close.index === from) return null
    spans.push({ from, to: close.index })
    at = close.index + fence.length
    if (at === block.length - 1 && block[at] === '.') return spans
    if (!block.startsWith('; ', at)) return null
    at += 2
  }
}

/**
 * The statement with the code spans of a closing Interface block blanked out:
 * a span names an identifier the task's tests use, which may hold a process
 * word (a `--surface-*` flag) without stating the task in process terms. Only
 * a block after the last marker that ends the statement counts; the rest of
 * the statement is checked as written, and each index stays where it was.
 */
function withoutInterfaceSpans(statement: string): string {
  const at = statement.lastIndexOf(INTERFACE_MARKER)
  if (at < 0) return statement
  const block = statement.slice(at)
  const spans = interfaceSpans(block)
  if (spans === null) return statement
  let blanked = block
  for (const { from, to } of spans) blanked = blanked.slice(0, from) + ' '.repeat(to - from) + blanked.slice(to)
  return statement.slice(0, at) + blanked
}

/** Every banned term the statement contains, in the order the list names them. */
export function findBannedTerms(statement: string): BannedTermHit[] {
  const checked = withoutInterfaceSpans(statement)
  const hits: BannedTermHit[] = []
  for (const { term, pattern } of BANNED_TERMS) {
    const found = pattern.exec(checked)
    if (found !== null) hits.push({ term, match: found[0], index: found.index })
  }
  return hits
}

/**
 * Accepts a task statement free of every banned term, or refuses it as
 * `banned_term`, naming the first term found and the text that matched it.
 */
export function checkTaskStatement(statement: string, path = 'taskStatement'): Validated<string> {
  const [first] = findBannedTerms(statement)
  if (first === undefined) return { ok: true, value: statement }
  const refusal: ContractRefusal = {
    code: 'banned_term',
    path,
    detail: `${path} contains the process term "${first.term}" (${JSON.stringify(first.match)})`
  }
  return { ok: false, refusal }
}
