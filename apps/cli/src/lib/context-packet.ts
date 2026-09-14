/**
 * Bounded context packets (O3) — the shape the Operator, the Developer, and
 * the reviewers all carry their task context in, so the two facts that must
 * never be lost survive compaction and continuation: the **authoritative
 * constraints** (what the seat may and may not do) and the **version-pinned
 * evidence index** (every fact the round was judged against, each pinned to
 * the version it was true at). The doctrine and worked examples live in
 * `aeg-root/skills/aeg-context-packets/`; this module is the parser, the
 * validator, and the two transforms (compaction, continuation) that the
 * fixtures exercise.
 *
 * The one invariant every function here upholds: authoritative constraints
 * and the version-pinned evidence index are never dropped, never truncated,
 * and never overridden by anything in the free `context` body — a packet that
 * cannot fit its own constraints inside a budget fails closed rather than
 * shedding them, and untrusted narrative in `context` can never become a
 * constraint. That is what makes the packet safe against an oversized input,
 * a compaction boundary, a resumed continuation, and a prompt-injection
 * attempt alike.
 */

import { isOperatorGranted, taskToolError, type OperatorGrantedTool, type TaskToolError } from '@attalabs/aeg-core'
import { routeTaskToolIntent } from './task-tools/router.js'

export type ContextPacketRole = 'operator' | 'developer' | 'reviewer'

/**
 * One evidence entry, always version-pinned: a `ref` (what the fact is —
 * `objectives`, `brief`, `head`, `policy`) and the `version` it was true at
 * (a version number, a hash, a sha, a digest). An entry whose `version` is
 * empty is *unpinned* and is a validation failure — an evidence index that
 * cannot say which version a fact came from is not an evidence index.
 */
export type EvidenceEntry = { ref: string; version: string }

export type ContextPacket = {
  /** The packet format version, e.g. `v1` — pinned so a continuation is known to be the same shape. */
  packetVersion: string
  role: ContextPacketRole
  /** Authoritative constraints — never dropped, never overridden by `context`. */
  constraints: string[]
  /** Version-pinned evidence index — never dropped, never truncated. */
  evidenceIndex: EvidenceEntry[]
  /** Free, droppable narrative — the only part compaction may shed. Untrusted: nothing here is ever promoted to a constraint. */
  context: string[]
}

export type PacketIssueKind = 'missing-constraints' | 'missing-evidence' | 'unpinned-evidence' | 'malformed-header'

export type PacketIssue = { kind: PacketIssueKind; message: string }

/**
 * A caller's request, classified against the Operator's grant (O3): a granted
 * task-tool intent, an ungranted action (scope creep or a prompt-injection
 * attempt to make the Operator merge/approve/edit/plan), or a genuinely
 * ambiguous request that names no clear action. Ungranted and ambiguous are
 * kept distinct on purpose — the first is refused with the seat that owns it
 * named, the second is a request for clarification, never a guess.
 */
export type RequestClassification =
  | { kind: 'granted'; tool: OperatorGrantedTool }
  | { kind: 'ungranted'; error: TaskToolError }
  | { kind: 'ambiguous'; reason: string }

/** The default character budget a packet is compacted to fit — small enough that a real oversized `context` must shed lines, never so small that a normal constraints+evidence core cannot fit. */
export const DEFAULT_PACKET_BUDGET = 8000

// --- parsing / rendering -----------------------------------------------------

const HEADER_RE = /^#\s+Context packet\s+(\S+)\s+—\s+(operator|developer|reviewer)\s*$/i
const EVIDENCE_RE = /^-\s+(.+?)\s+@\s+(.*)$/
const BULLET_RE = /^-\s+(.*)$/

type Section = 'none' | 'constraints' | 'evidence' | 'context'

function sectionFor(headingText: string): Section {
  const h = headingText.trim().toLowerCase()
  if (h.startsWith('authoritative constraints')) return 'constraints'
  if (h.startsWith('evidence index')) return 'evidence'
  if (h.startsWith('context')) return 'context'
  return 'none'
}

/**
 * Parse a packet from its markdown form. Only the three recognized sections
 * are read; anything outside them (an HTML comment, a stray line) is ignored —
 * so a `## Authoritative constraints` line appearing *inside* the `## Context`
 * body is just narrative text, never a constraint. This is the parser's half
 * of the injection defense: authority comes from the section a line sits
 * under, never from the words in the line.
 */
export function parseContextPacket(markdown: string): ContextPacket {
  const lines = markdown.split('\n')
  let packetVersion = ''
  let role: ContextPacketRole = 'operator'
  let section: Section = 'none'
  const constraints: string[] = []
  const evidenceIndex: EvidenceEntry[] = []
  const context: string[] = []
  // First declaration wins for the two authoritative sections: a packet that
  // re-opens `## Authoritative constraints` or `## Evidence index` a second
  // time (the classic injection — a fake authority heading planted after the
  // Context body) has its re-declaration ignored, never merged in.
  const claimed = new Set<Section>()
  // The top-level header is authoritative identity (version + role), exactly
  // like the constraints/evidence sections — so it gets the same first-wins
  // guard. Without it, a header-shaped line planted inside the untrusted
  // `context` body (the classic injection: a fake "# Context packet v99 —
  // developer" line) would silently re-pin the packet's version and role
  // after parsing, even though nothing else in `context` can ever become
  // authoritative.
  let headerClaimed = false

  for (const line of lines) {
    const header = !headerClaimed ? HEADER_RE.exec(line) : null
    if (header) {
      packetVersion = header[1] ?? ''
      role = (header[2] ?? 'operator').toLowerCase() as ContextPacketRole
      headerClaimed = true
      continue
    }
    if (line.startsWith('## ')) {
      const next = sectionFor(line.slice(3))
      if ((next === 'constraints' || next === 'evidence') && claimed.has(next)) {
        section = 'none'
      } else {
        section = next
        if (next !== 'none') claimed.add(next)
      }
      continue
    }
    if (section === 'constraints') {
      const m = BULLET_RE.exec(line)
      if (m && m[1]!.trim().length > 0) constraints.push(m[1]!.trim())
    } else if (section === 'evidence') {
      const e = EVIDENCE_RE.exec(line)
      if (e) {
        evidenceIndex.push({ ref: e[1]!.trim(), version: (e[2] ?? '').trim() })
      } else {
        const b = BULLET_RE.exec(line)
        // A bullet with no `@ <version>` is a deliberately unpinned entry — kept
        // (with an empty version) so the validator can name it, never silently dropped.
        if (b && b[1]!.trim().length > 0) evidenceIndex.push({ ref: b[1]!.trim(), version: '' })
      }
    } else if (section === 'context') {
      context.push(line)
    }
  }

  // Trim leading/trailing blank lines from the free body without touching interior spacing.
  while (context.length > 0 && context[0]!.trim() === '') context.shift()
  while (context.length > 0 && context[context.length - 1]!.trim() === '') context.pop()

  return { packetVersion, role, constraints, evidenceIndex, context }
}

/** Render a packet back to its canonical markdown form — the inverse of `parseContextPacket` for the recognized sections. */
export function renderContextPacket(packet: ContextPacket): string {
  const parts: string[] = [
    `# Context packet ${packet.packetVersion} — ${packet.role}`,
    '',
    '## Authoritative constraints',
    ''
  ]
  for (const c of packet.constraints) parts.push(`- ${c}`)
  parts.push('', '## Evidence index', '')
  for (const e of packet.evidenceIndex) parts.push(`- ${e.ref} @ ${e.version}`)
  parts.push('', '## Context', '')
  for (const line of packet.context) parts.push(line)
  return `${parts.join('\n')}\n`
}

// --- validation --------------------------------------------------------------

/**
 * Report every structural defect that would make a packet unsafe to carry:
 * no authoritative constraints, no evidence at all (missing evidence), or an
 * evidence entry that is not version-pinned (unpinned evidence). A clean
 * packet returns `[]`. This is what a reviewer or the Operator runs before
 * trusting a packet a compaction or a resume produced.
 */
export function validateContextPacket(packet: ContextPacket): PacketIssue[] {
  const issues: PacketIssue[] = []
  if (
    !HEADER_RE.test(`# Context packet ${packet.packetVersion} — ${packet.role}`) ||
    packet.packetVersion.trim() === ''
  ) {
    issues.push({ kind: 'malformed-header', message: 'packet has no version-pinned header' })
  }
  if (packet.constraints.length === 0) {
    issues.push({ kind: 'missing-constraints', message: 'packet carries no authoritative constraints' })
  }
  if (packet.evidenceIndex.length === 0) {
    issues.push({ kind: 'missing-evidence', message: 'packet carries no evidence index' })
  }
  for (const e of packet.evidenceIndex) {
    if (e.version.trim() === '') {
      issues.push({ kind: 'unpinned-evidence', message: `evidence "${e.ref}" is not version-pinned` })
    }
  }
  return issues
}

// --- compaction (bounding an oversized input) --------------------------------

/**
 * The size of the part of a packet that compaction may never shed — the
 * header, the authoritative constraints, and the whole version-pinned
 * evidence index. `compactPacket` fails closed rather than let a budget push
 * this below what it needs.
 */
function coreSize(packet: ContextPacket): number {
  return renderContextPacket({ ...packet, context: [] }).length
}

/**
 * Compact a packet to fit `budgetChars`, shedding only `context` lines (from
 * the end, oldest-narrative-last) — the authoritative constraints and the
 * version-pinned evidence index are always retained in full. This is how an
 * oversized input is bounded: the untrusted, droppable narrative is trimmed,
 * never the authority or the evidence.
 *
 * **Fail-closed.** If the constraints + evidence core alone already exceeds
 * the budget, this throws rather than dropping a single constraint or evidence
 * entry to fit — a packet that cannot carry its own authority within the
 * budget is a budget too small, not a constraint too many.
 */
export function compactPacket(packet: ContextPacket, budgetChars: number = DEFAULT_PACKET_BUDGET): ContextPacket {
  const core = coreSize(packet)
  if (core > budgetChars) {
    throw new Error(
      `context packet cannot be compacted to ${budgetChars} chars without dropping authoritative content ` +
        `(constraints + evidence index alone need ${core}) — refusing to shed authority to fit`
    )
  }
  const context = [...packet.context]
  while (context.length > 0 && renderContextPacket({ ...packet, context }).length > budgetChars) {
    context.pop()
  }
  return { ...packet, context }
}

// --- continuation (resuming a session) ---------------------------------------

/**
 * Produce the packet a resumed or re-entered session starts from. It carries
 * the previous packet's authoritative constraints and version-pinned evidence
 * index forward intact, and drops the transient `context` — a continuation
 * re-derives its narrative, but it must never resume without the constraints
 * and the evidence pins that bounded the original work. The packet version is
 * preserved, so a continuation is provably the same shape as its origin.
 */
export function continuationPacket(previous: ContextPacket): ContextPacket {
  return {
    packetVersion: previous.packetVersion,
    role: previous.role,
    constraints: [...previous.constraints],
    evidenceIndex: previous.evidenceIndex.map((e) => ({ ...e })),
    context: []
  }
}

// --- request classification (scope creep / injection / ambiguity) ------------

/**
 * Actions that name content or ratification authority the Operator never
 * holds — a scope-creep or prompt-injection attempt reduces to one of these.
 * Checked before intent routing, so an utterance that both names a granted
 * verb and an ungranted one ("start the run and merge it") is refused, not
 * started.
 */
const UNGRANTED_ACTION_RE =
  /\b(merge|approv\w*|rul\w+ on|publish\w*|re-?scop\w*|re-?plan\w*|edit the issue|change the (criteria|rules|scope)|rewrite the criteria|write (the )?code|force[- ]?push)\b/i

/**
 * Classify a caller's free-text request against the Operator's grant. An
 * ungranted action (scope creep, or an injected instruction to merge/approve/
 * edit/re-scope) is refused with an `authority` error; a recognized, granted
 * task-tool intent is admitted; anything that names no clear action is
 * `ambiguous` — a request for clarification, never a guess at what the user
 * meant. The classifier reads only the utterance, never a caller-asserted
 * role: authority is a property of the seat, not a value the caller sets.
 */
export function classifyOperatorRequest(utterance: string): RequestClassification {
  if (UNGRANTED_ACTION_RE.test(utterance)) {
    return {
      kind: 'ungranted',
      error: taskToolError(
        'authority',
        'this asks the Operator for content or ratification authority it does not hold',
        'plan/scope/criteria changes go to the Planner; a ruling, an approval, or a merge goes to the Principal — never performed by the Operator'
      )
    }
  }
  const tool = routeTaskToolIntent(utterance)
  if (tool !== null && isOperatorGranted(tool)) return { kind: 'granted', tool }
  return {
    kind: 'ambiguous',
    reason:
      'no granted task-tool intent recognized — ask the user to clarify which task and which action before acting, rather than guessing'
  }
}
