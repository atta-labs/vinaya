import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  AmbiguousBareEdgeError,
  findLetteredEdgeIds,
  parseRationaleDeps,
  requireTrancheQualifiedEdges
} from './parse-rationale-deps'

const FIXTURES = join(__dirname, '..', 'tests', 'fixtures')
/** Captured verbatim via `gh issue view <n> --json body` on 2026-07-06 — the
 * real bodies the 2026-07-06 spike and this task's own golden comparison
 * were validated against. Static fixtures, not live calls: `bun test` must
 * not depend on network/gh access (CI has no `GH_TOKEN` wired for this job). */
function readIssueBodyFixture(number: 383 | 384 | 509): string {
  return readFileSync(join(FIXTURES, `issue-${number}-body.md`), 'utf8')
}

describe('parseRationaleDeps', () => {
  it('parses the dash-empty form (`Depends-on: —`) as no edges', () => {
    const body =
      '**Dependency rationale** — `Depends-on: —`. First task; independently buildable.\n\n**Traps to avoid** — none.'
    expect(parseRationaleDeps(body)).toEqual({ dependsOn: [], conflictsWith: [] })
  })

  it('parses a single comma-joined backtick span (topology-cell convention)', () => {
    const body = '**Dependency rationale** — `Depends-on: 1, 2`, `Conflicts-with: 3`.\n\n**Traps to avoid** — none.'
    expect(parseRationaleDeps(body)).toEqual({ dependsOn: ['1', '2'], conflictsWith: ['3'] })
  })

  it('resolves a bare id that follows a slug-qualified one inside the SAME labeled span', () => {
    // Issue #388's real body (aeg-forge-state-v1 3b, #437) meant `#372` as a
    // second aeg-governance-hardening reference, not this tranche's own #372.
    // Since #347 that inheritance lives inside one labeled span's comma list —
    // the form `amendRationaleDeps` writes — rather than across spans.
    const body =
      '**Dependency rationale** — `Depends-on: aeg-governance-hardening #368, #372`: both reshape the surface.\n\n**Traps to avoid** — none.'
    expect(parseRationaleDeps(body)).toEqual({
      dependsOn: ['aeg-governance-hardening #368', 'aeg-governance-hardening #372'],
      conflictsWith: []
    })
  })

  it('resets slug inheritance after one bare id, so a THIRD id does not inherit a stale qualifier', () => {
    const body =
      "**Dependency rationale** — `Depends-on: aeg-governance-hardening #368, #372, 5` — the last is this tranche's own task and must NOT inherit.\n\n**Traps to avoid** — none."
    expect(parseRationaleDeps(body)).toEqual({
      dependsOn: ['aeg-governance-hardening #368', 'aeg-governance-hardening #372', '5'],
      conflictsWith: []
    })
  })

  it('ignores a bare backtick span that follows a labeled span (Issue #347)', () => {
    // The worked example from Issue #347's own body. The trailing `1` is
    // ordinary prose naming a task, not a second declared edge; before the
    // narrowing it was scavenged as one, and — once the Issue was itself task
    // 1 — read back as a self-dependency.
    const body =
      '**Dependency rationale** — `Depends-on: #1034` — `engine-conditional-edges-v1` task `1` — because the engine must land first.\n\n**Traps to avoid** — none.'
    expect(parseRationaleDeps(body)).toEqual({ dependsOn: ['#1034'], conflictsWith: [] })
  })

  it("ignores the bare continuation spans in Issue #383's real body", () => {
    // #383 wrote its second edge as a separate bare span (`2`) with prose
    // between. That convention is no longer read: only the labeled
    // span declares. A body needing both edges states them comma-separated in
    // the labeled span, which is what `amendRationaleDeps` emits.
    const body = readIssueBodyFixture(383)
    expect(parseRationaleDeps(body)).toEqual({ dependsOn: ['1'], conflictsWith: [] })
  })

  it("does not scavenge task ids named in prose beside an empty field (Issue #243's real shape)", () => {
    // Both fields read `—`; the ids are prose explaining the disjointness
    // check. The old reader declared three conflicts that were never declared.
    const body =
      '**Dependency rationale** — No `depends-on`. `Conflicts-with: —` verified by file-set disjointness: task `35` owns tests, task `78` owns check bins, task `38` owns labels.\n\n**Traps to avoid** — none.'
    expect(parseRationaleDeps(body)).toEqual({ dependsOn: [], conflictsWith: [] })
  })

  it("ignores an unrelated backtick span in the same paragraph (Issue #384's `vinaya check` mention)", () => {
    const body = readIssueBodyFixture(384)
    expect(parseRationaleDeps(body)).toEqual({ dependsOn: ['3'], conflictsWith: [] })
  })

  it("does NOT re-parse a prose-cited historical field as a live edge (Issue #509's real body)", () => {
    // Regression for Issue #509 ([vinaya-pages-v1] 2): the `Depends-on: 1`
    // labeled span is the live declaration; the LATER `Depends-on: 2` span
    // is prose citing a removed historical edge (an Amendment explaining why
    // it no longer applies), not a fresh re-declaration. Before the fix this
    // resolved to `dependsOn: ['1', '2']`, and since #509 was renumbered to
    // task id "2" in the same amendment, edge "2" self-referenced #509.
    const body = readIssueBodyFixture(509)
    expect(parseRationaleDeps(body)).toEqual({ dependsOn: ['1'], conflictsWith: [] })
  })

  it('does NOT duplicate an id repeated inside one labeled span (Issue #569 regression)', () => {
    // Regression for Issue #569 ([vinaya-pages-v1] 9): a duplicated id
    // propagated to a React key collision in Vinaya Studio's task table
    // (DepList, page.tsx). #569's own body duplicated via a bare prose span,
    // which #347 stopped reading at all; the within-span repeat below is the
    // remaining way to reach `pushUnique`.
    const body =
      '**Dependency rationale** — `Depends-on: —`. `Conflicts-with: #570, #570`. The `#570` edge is sequencing, not exclusion.\n\n**Traps to avoid** — none.'
    expect(parseRationaleDeps(body)).toEqual({ dependsOn: [], conflictsWith: ['#570'] })
  })

  it('returns empty edges when the body has no Dependency rationale section', () => {
    expect(parseRationaleDeps('**Boundary** — some text with `a backtick span` in it.')).toEqual({
      dependsOn: [],
      conflictsWith: []
    })
  })

  // issue-809, O1 — the grammar no longer accepts a lettered task id. The
  // tolerant reader drops it (the refusal lives in `findLetteredEdgeIds` + the
  // aeg-core gate); it must not be scavenged as an edge.
  it('drops a lettered task id from a labeled edge span rather than declaring it', () => {
    const body = '**Dependency rationale** — `Depends-on: 7a, 2`, `Conflicts-with: 3b`.\n\n**Traps to avoid** — none.'
    expect(parseRationaleDeps(body)).toEqual({ dependsOn: ['2'], conflictsWith: [] })
  })

  it('drops a slug-qualified lettered id, keeping only the whole-number references', () => {
    const body =
      '**Dependency rationale** — `Depends-on: aeg-governance-hardening 3c, #372`.\n\n**Traps to avoid** — none.'
    expect(parseRationaleDeps(body)).toEqual({ dependsOn: ['#372'], conflictsWith: [] })
  })
})

// issue-809, O1 — the refusal's eyes: name a lettered edge id so a gate can
// refuse it, rather than leaving the tolerant reader to drop it unremarked.
describe('findLetteredEdgeIds', () => {
  it('is empty when every declared edge id is a whole number or `#NNN`', () => {
    const body = '**Dependency rationale** — `Depends-on: 1, 2`, `Conflicts-with: #570`.\n\n**Traps to avoid** — none.'
    expect(findLetteredEdgeIds(body)).toEqual([])
  })

  it('is empty when there is no Dependency rationale section at all', () => {
    expect(findLetteredEdgeIds('**Boundary** — nothing here.')).toEqual([])
  })

  it('names a bare lettered id (`7a`) in a Depends-on span', () => {
    const body = '**Dependency rationale** — `Depends-on: 7a, 2`.\n\n**Traps to avoid** — none.'
    expect(findLetteredEdgeIds(body)).toEqual(['7a'])
  })

  it('names lettered ids across both fields, including a slug-qualified one', () => {
    const body =
      '**Dependency rationale** — `Depends-on: aeg-governance-hardening 3c`, `Conflicts-with: 2b`.\n\n**Traps to avoid** — none.'
    expect(findLetteredEdgeIds(body)).toEqual(['aeg-governance-hardening 3c', '2b'])
  })

  it('reads only the FIRST labeled span per field, so a later prose re-mention of a dropped `2b` is not flagged', () => {
    // Mirrors `parseRationaleDeps`: an Amendment citing a removed historical
    // value in backticks is prose, not a fresh declaration.
    const body =
      '**Dependency rationale** — `Depends-on: 1`. Amendment: the old `Depends-on: 2b` edge was dropped.\n\n**Traps to avoid** — none.'
    expect(findLetteredEdgeIds(body)).toEqual([])
  })

  it('de-duplicates a repeated lettered id within a span', () => {
    const body = '**Dependency rationale** — `Conflicts-with: 4e, 4e`.\n\n**Traps to avoid** — none.'
    expect(findLetteredEdgeIds(body)).toEqual(['4e'])
  })
})

// issue-545, O3 — a bare edge id is ambiguous once its Milestone holds two
// or more tranches.
describe('requireTrancheQualifiedEdges', () => {
  it('is a no-op for a single-tranche Milestone — the ordinary case', () => {
    expect(() => requireTrancheQualifiedEdges(['1', '#372'], ['solo-tranche'])).not.toThrow()
  })

  it('is a no-op for a tranche-less Milestone (empty list)', () => {
    expect(() => requireTrancheQualifiedEdges(['1'], [])).not.toThrow()
  })

  it('is a no-op when every id is already slug-qualified, even across several tranches', () => {
    expect(() =>
      requireTrancheQualifiedEdges(['tranche-a 1', 'tranche-b #372'], ['tranche-a', 'tranche-b', 'tranche-c'])
    ).not.toThrow()
  })

  it('refuses a bare task id once the Milestone holds two tranches, quoting the token and listing both', () => {
    expect(() => requireTrancheQualifiedEdges(['1'], ['tranche-a', 'tranche-b'])).toThrow(AmbiguousBareEdgeError)
    try {
      requireTrancheQualifiedEdges(['1'], ['tranche-a', 'tranche-b'])
      expect.unreachable('must throw')
    } catch (e) {
      const err = e as AmbiguousBareEdgeError
      expect(err.token).toBe('1')
      expect(err.tranches).toEqual(['tranche-a', 'tranche-b'])
      expect(err.message).toContain('`1`')
      expect(err.message).toContain('tranche-a')
      expect(err.message).toContain('tranche-b')
    }
  })

  it('never refuses a bare #NNN Issue ref, whatever the Milestone holds — the hash sign makes it unique', () => {
    expect(() => requireTrancheQualifiedEdges(['#372'], ['tranche-a', 'tranche-b', 'tranche-c'])).not.toThrow()
  })

  it('reports the FIRST bare id, not a later qualified one that happens to sit beside it', () => {
    try {
      requireTrancheQualifiedEdges(['tranche-a 5', '9'], ['tranche-a', 'tranche-b'])
      expect.unreachable('must throw')
    } catch (e) {
      expect((e as AmbiguousBareEdgeError).token).toBe('9')
    }
  })
})
