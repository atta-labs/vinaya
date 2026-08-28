/**
 * registry-scaffold.ts — pure insertion logic that turns a G2 "orphan
 * hook/CLI" finding into a stub row, instead of leaving it a drift warning a
 * human has to notice and fix by hand.
 *
 * Purity contract identical to `registry-checks.ts`'s: no fs/git/gh here.
 * The caller (`bin/verify-registry.ts`) supplies the parsed rows, the
 * already-globbed candidate files, and the raw `enforcement.md` content to
 * rewrite; this module only ever reads `GATE_AUDIENCE` (a same-package,
 * aeg-core-local data table — see its own doc comment for why aeg-core
 * cannot instead import `apps/cli`'s `CORE_CHECK_RING` directly).
 *
 * Two derivation classes, per Issue #104's Principal decision:
 *   - a `packages/aeg-core/bin/*.ts` candidate that IS a registered check
 *     (its basename resolves in `GATE_AUDIENCE` to a `ShippedGate`) gets a
 *     stub in the ring `GATE_AUDIENCE` names for it;
 *   - a `.husky/*` or `.claude/hooks/*.sh` candidate is a managed hook by
 *     construction — ring 0, no registry lookup needed.
 * Anything else (an aeg-core bin with no registry entry — `internal`,
 * `NON_GATE_BINS`, or simply undeclared) gets NO stub: ring is genuinely
 * underivable there, and guessing is exactly what this task's Stop-and-
 * escalate condition forbids. It stays a plain G2 finding, same as today.
 *
 * Never touches an existing row: stubs are computed only for candidates
 * whose path is absent from every parsed row's `implementation` — the
 * identical predicate `checkG2` itself uses — so a candidate already
 * documented (including every row `#67` wrote by hand) is left alone, and
 * running the scaffold twice inserts nothing the second time (the first
 * run's own stubs are now present, so the same predicate excludes them).
 *
 * Only mechanical facts are filled: the check name / candidate path
 * (`Action`/`CI check`/`Mechanism`), `Category` (fixed per ring — matches
 * every existing row: ring 0 is `hook`, ring 1 is `ci`, ring 2 is `event`),
 * `Audience` (`product` for a registered check, `repo-own` for a bare hook
 * script), and `implementation` (the path itself). A ring-0 stub also gets a
 * mechanical `Gate` cell naming the check/its invocation — never the
 * substantive "what must be true"/"re-verifies"/"catches" reasoning, which
 * (along with `Summary`/`Description`) is the placeholder marker, verbatim,
 * on every stub this module ever produces.
 */

import { GATE_AUDIENCE, isShipped } from './gate-audience'
import { findHeadingLine, findTable } from './markdown-table'
import type { GateRing, GateRow } from './registry-parse'

/** The literal marker a stub's every non-mechanical cell carries. Never
 * synthesized reasoning — `checkG2`'s placeholder scan (registry-checks.ts)
 * looks for this exact string. */
export const PLACEHOLDER = '[undocumented — fill in why]'

const HUSKY_PREFIX = '.husky/'
const CLAUDE_HOOKS_PREFIX = '.claude/hooks/'
const AEG_CORE_BIN_PREFIX = 'packages/aeg-core/bin/'

const RING_CATEGORY: Record<GateRing, string> = { ring0: 'hook', ring1: 'ci', ring2: 'event' }

const RING_HEADING_PATTERN: Record<GateRing, RegExp> = {
  ring0: /^##\s+Ring 0\b/,
  ring1: /^##\s+Ring 1\b/,
  ring2: /^##\s+Ring 2\b/
}

export type ScaffoldStub = {
  ring: GateRing
  path: string
  checkName?: string
  /** Ordered cell values, matching that ring table's own column count/order. */
  cells: string[]
}

export type ScaffoldSkip = { path: string; reason: string }

export type ScaffoldPlan = {
  stubs: ScaffoldStub[]
  skipped: ScaffoldSkip[]
}

function ringFromNumber(n: 0 | 1 | 2): GateRing {
  if (n === 0) return 'ring0'
  if (n === 1) return 'ring1'
  return 'ring2'
}

/** Classifies one G2-orphan candidate path. Returns null when no ring is
 * derivable — the candidate must remain a plain G2 finding, never guessed. */
function classify(path: string): { ring: GateRing; checkName?: string } | null {
  if (path.startsWith(HUSKY_PREFIX) || path.startsWith(CLAUDE_HOOKS_PREFIX)) {
    return { ring: 'ring0' }
  }
  if (path.startsWith(AEG_CORE_BIN_PREFIX) && path.endsWith('.ts')) {
    const base = path.slice(AEG_CORE_BIN_PREFIX.length, -'.ts'.length)
    const audience = GATE_AUDIENCE[base]
    if (audience && isShipped(audience)) {
      const checkName = Array.isArray(audience.shippedAs) ? audience.shippedAs[0] : audience.shippedAs
      return { ring: ringFromNumber(audience.ring), checkName }
    }
    return null
  }
  return null
}

function gateCell(path: string, checkName: string | undefined): string {
  if (checkName) return `\`${checkName}\` check (\`vinaya check ${checkName}\`)`
  return `managed hook script (\`${path}\`)`
}

function buildCells(ring: GateRing, path: string, checkName: string | undefined): string[] {
  const action = checkName ?? path
  const category = RING_CATEGORY[ring]
  const audience = checkName ? 'product' : 'repo-own'
  const implementation = `\`${path}\``
  if (ring === 'ring0') {
    return [
      action,
      PLACEHOLDER,
      category,
      PLACEHOLDER,
      gateCell(path, checkName),
      PLACEHOLDER,
      audience,
      implementation
    ]
  }
  if (ring === 'ring1') {
    return [action, PLACEHOLDER, category, PLACEHOLDER, PLACEHOLDER, audience, implementation]
  }
  return [action, PLACEHOLDER, category, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER, audience, implementation]
}

/** Computes which G2-orphan candidates get a stub row, and where. Pure: no
 * I/O, deterministic over its inputs. Idempotent by construction — a
 * candidate already present in `rows` (including one from a prior scaffold
 * run) is excluded before classification ever runs. */
export function computeScaffoldPlan(rows: GateRow[], candidateFiles: string[]): ScaffoldPlan {
  const implementations = new Set(rows.map((r) => r.implementation).filter((p) => p !== ''))
  const stubs: ScaffoldStub[] = []
  const skipped: ScaffoldSkip[] = []
  for (const path of candidateFiles) {
    if (implementations.has(path)) continue
    const classified = classify(path)
    if (!classified) {
      skipped.push({ path, reason: 'no derivable ring — remains a plain G2 finding' })
      continue
    }
    stubs.push({
      ring: classified.ring,
      path,
      checkName: classified.checkName,
      cells: buildCells(classified.ring, path, classified.checkName)
    })
  }
  return { stubs, skipped }
}

function formatRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

/**
 * Rewrites `content` to append the plan's stub rows to their ring tables.
 * Only ever APPENDS new lines after a ring table's last existing row —
 * never edits, reorders, or removes an existing line, so a hand-written row
 * (including every row task `#67` wrote) is untouched byte-for-byte.
 *
 * Rings are processed from the bottom of the file upward (ring 2 first,
 * then ring 1, then ring 0) so an earlier insertion's line numbers, computed
 * once up front from the ORIGINAL `rows`, stay valid throughout — a later
 * ring's insertion never shifts an earlier ring's already-resolved splice
 * point.
 *
 * Throws if a ring with stubs to insert has no existing table/rows to
 * anchor on — the caller (`bin/verify-registry.ts`) must not write anything
 * to disk when this throws; computing this in memory before any write is
 * what keeps the round-trip guard restore-free (nothing is ever written
 * badly in the first place).
 */
export function applyScaffoldPlan(content: string, plan: ScaffoldPlan): string {
  if (plan.stubs.length === 0) return content
  const lines = content.split('\n')

  const byRing: Record<GateRing, ScaffoldStub[]> = { ring0: [], ring1: [], ring2: [] }
  for (const stub of plan.stubs) byRing[stub.ring].push(stub)

  for (const ring of ['ring2', 'ring1', 'ring0'] as const) {
    const stubs = byRing[ring]
    if (stubs.length === 0) continue
    const headingLine = findHeadingLine(lines, RING_HEADING_PATTERN[ring])
    if (headingLine === null) {
      throw new Error(`registry-scaffold: no "${ring}" heading found in enforcement.md`)
    }
    const table = findTable(lines, headingLine + 1)
    if (!table || table.rows.length === 0) {
      throw new Error(`registry-scaffold: ${ring} table has no existing rows to insert after`)
    }
    const lastRowLine = table.rows[table.rows.length - 1]?.line ?? headingLine
    const newLines = stubs.map((s) => formatRow(s.cells))
    lines.splice(lastRowLine, 0, ...newLines)
  }

  return lines.join('\n')
}
