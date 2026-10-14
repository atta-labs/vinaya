/**
 * The pull request's record of its `[live]` Test plan lines — the commands
 * that need real signed-in agent sessions, which the review loop runs on its
 * own host between a green gate and review (`apps/cli/specs/loop.md`, "The
 * live check"). Pure: a body in, a body or the record's lines out.
 *
 * The record is an `AEG:LIVE` anchored region the driver owns, like
 * `AEG:BEYOND-SURFACE`: rewritten by the driver after each live run, and
 * carried over from the live body on every other body write, so an agent's
 * edit to it never survives. One checkbox line per `[live]` command:
 *
 * - passed — ticked, naming the head it passed at and its pass count;
 * - failed — unticked, naming the head and the exit;
 * - unverified — unticked, naming the head and why the host could not run
 *   it. The Principal may run it and tick the box, exactly as for a
 *   `[principal]` item; the driver keeps that tick while the head and the
 *   command are unchanged.
 *
 * `evaluateTestPlanGate` reads each unticked line as it reads an unticked
 * `[principal]` item, so the merge gate stays red while one remains. Every
 * digit sits inside a code span, so the body's bare-digit rule never sees one.
 */

import { maskCode } from '@attalabs/aeg-forge-state/strip-code'
import { anchoredRegion, anchoredRegionBounds } from './anchored-region'
import { locateTestPlanSection } from './test-plan-section'

export type LiveRecordEntry =
  | { command: string; head: string; outcome: 'passed'; passCount: number | null }
  | { command: string; head: string; outcome: 'failed'; detail: string }
  | { command: string; head: string; outcome: 'unverified'; reason: string; ticked: boolean }

const LIVE_RECORD_LEAD =
  '**Live checks** — recorded by the review-loop driver after each run on its own host; never edit it:'

/** `text` as a code span one backtick longer than any run inside it, padded when it starts or ends with a backtick. */
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const ticks = '`'.repeat(longest + 1)
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${ticks}${pad}${text}${pad}${ticks}`
}

/** One entry's line. */
export function renderLiveRecordLine(entry: LiveRecordEntry): string {
  const at = `at ${codeSpan(entry.head)}`
  const cmd = codeSpan(entry.command)
  switch (entry.outcome) {
    case 'passed':
      return `- [x] **[live]** ${cmd} — passed ${at}, ${
        entry.passCount === null ? 'its output naming no pass count' : `${codeSpan(String(entry.passCount))} passing`
      }`
    case 'failed':
      return `- [ ] **[live]** ${cmd} — failed ${at}: ${entry.detail}`
    case 'unverified':
      return `- [${entry.ticked ? 'x' : ' '}] **[live]** ${cmd} — unverified ${at}: ${entry.reason}; the Principal runs it and ticks this box`
  }
}

/** The whole marked block — the `AEG:LIVE` pair around the lead line and one line per entry, or around nothing when there is none. */
export function renderLiveRecordBlock(entries: readonly LiveRecordEntry[]): string {
  const inner = entries.length === 0 ? '' : `${[LIVE_RECORD_LEAD, ...entries.map(renderLiveRecordLine)].join('\n')}\n`
  return `<!-- AEG:LIVE:START -->\n${inner}<!-- AEG:LIVE:END -->`
}

const RECORD_LINE_RE =
  /^-\s*\[([ xX])\]\s*\*\*\[live\]\*\*\s+(`+) ?(.+?) ?\2(?!`)\s+—\s+(passed|failed|unverified)\s+at\s+`([^`]+)`/

/** One line the record carries, as the gate and the driver read it back. */
export type LiveRecordLine = {
  line: string
  ticked: boolean
  command: string
  outcome: 'passed' | 'failed' | 'unverified'
  head: string
}

/** Every `AEG:LIVE` start or end marker outside code, by position — the driver writes exactly one of each. */
function liveMarkers(body: string): { start: number; end: number }[] {
  const masked = maskCode(body)
  return [...masked.matchAll(/<!--\s*AEG:LIVE:(?:START|END)\s*-->/g)].map((m) => ({
    start: m.index as number,
    end: (m.index as number) + m[0].length
  }))
}

/** The line read back from a body whose `AEG:LIVE` markers are not exactly one pair: unticked, so the merge gate holds and no run is skipped. */
const AMBIGUOUS_RECORD_LINE: LiveRecordLine = {
  line: "- [ ] **[live]** the pull request body carries more than one `AEG:LIVE` marker pair, so the driver's record cannot be told apart",
  ticked: false,
  command: '',
  outcome: 'failed',
  head: ''
}

/**
 * Every checkbox line inside the body's `AEG:LIVE` block — `[]` when the body
 * carries none. Fails closed: a body with any marker beyond the driver's one
 * pair reads as a single unticked line, never as the first pair's lines.
 */
export function readLiveRecord(body: string): LiveRecordLine[] {
  const markers = liveMarkers(body).length
  if (markers === 0) return []
  if (markers !== 2) return [AMBIGUOUS_RECORD_LINE]
  const region = anchoredRegion(body, 'LIVE')
  if (region === null) return []
  const lines: LiveRecordLine[] = []
  for (const raw of region.split('\n')) {
    const line = raw.trim()
    const m = RECORD_LINE_RE.exec(line)
    if (!m) continue
    lines.push({
      line,
      ticked: (m[1] as string).toLowerCase() === 'x',
      command: m[3] as string,
      outcome: m[4] as LiveRecordLine['outcome'],
      head: m[5] as string
    })
  }
  return lines
}

/**
 * `body` with its `AEG:LIVE` block rewritten to `entries` — only that marked
 * region is replaced. A body with no such block gets one at the end of its
 * Test Plan section (after an `AEG:TEST-PLAN` pair when the body has one),
 * else appended.
 */
export function withLiveRecord(body: string, entries: readonly LiveRecordEntry[]): string {
  const block = renderLiveRecordBlock(entries)
  const existing = anchoredRegionBounds(body, 'LIVE')
  if (existing) return body.slice(0, existing.outerStart) + block + body.slice(existing.outerEnd)
  const anchoredPlan = anchoredRegionBounds(body, 'TEST-PLAN')
  if (anchoredPlan) return insertAt(body, anchoredPlan.outerEnd, block)
  const located = locateTestPlanSection(body)
  const at = located.found ? body.indexOf(located.section) : -1
  if (located.found && at >= 0) return insertAt(body, at + located.section.length, block)
  return `${body.replace(/\s*$/, '')}\n\n${block}\n`
}

function insertAt(body: string, at: number, block: string): string {
  const before = body.slice(0, at).replace(/\s*$/, '')
  const after = body.slice(at).replace(/^\s*/, '')
  return `${before}\n\n${block}\n${after.length > 0 ? `\n${after}` : ''}`
}

/**
 * `next` with its `AEG:LIVE` block replaced by `current`'s — the driver's own
 * record survives an agent body write, and a block the agent wrote itself
 * never does: with no record on `current`, any block on `next` is removed.
 */
export function carryLiveRecord(next: string, current: string | null): string {
  const stripped = withoutAgentLiveRecord(next)
  const kept = current === null || liveMarkers(current).length !== 2 ? null : anchoredRegionBounds(current, 'LIVE')
  if (kept === null) return stripped
  return withLiveRecordBlockText(stripped, (current as string).slice(kept.outerStart, kept.outerEnd))
}

/**
 * `body` with every `AEG:LIVE` pair an agent wrote removed, contents and all,
 * then every leftover lone marker removed — so no number of forged pairs, and
 * no stray marker pairing with the driver's own, survives.
 */
function withoutAgentLiveRecord(body: string): string {
  let out = body
  for (let pair = anchoredRegionBounds(out, 'LIVE'); pair !== null; pair = anchoredRegionBounds(out, 'LIVE')) {
    const before = out.slice(0, pair.outerStart).replace(/\s*$/, '')
    const after = out.slice(pair.outerEnd).replace(/^\s*/, '')
    out = after.length > 0 ? `${before}\n\n${after}` : `${before}\n`
  }
  for (const marker of liveMarkers(out).reverse()) out = out.slice(0, marker.start) + out.slice(marker.end)
  return out
}

function withLiveRecordBlockText(body: string, block: string): string {
  const placeholder = withLiveRecord(body, [])
  const bounds = anchoredRegionBounds(placeholder, 'LIVE') as NonNullable<ReturnType<typeof anchoredRegionBounds>>
  return placeholder.slice(0, bounds.outerStart) + block + placeholder.slice(bounds.outerEnd)
}
