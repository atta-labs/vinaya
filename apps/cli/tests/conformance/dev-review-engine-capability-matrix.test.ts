import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * `apps/cli/specs/dev-review-engine-capability-matrix.md`'s own test — the
 * capability and ownership matrix for the Atta-backed developer-review
 * workflow, held in `tests/fixtures/dev-review-engine-capability-matrix.json`.
 *
 * It never re-derives WHETHER a capability fits; that is the matrix's own
 * audited, cited content. It checks that every row is mechanically complete
 * (owner, mechanism, limitation, conclusion, a pinned URL with a section
 * anchor), that every Atta conclusion sits on the one decided consumption
 * boundary at an Atta commit, that every adapter gets the same core contract
 * and cites only its own documentation, and that each adapter has a
 * confinement row per platform with the confinement gaps named.
 */

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..')
const FIXTURE_PATH = join(REPO_ROOT, 'apps', 'cli', 'tests', 'fixtures', 'dev-review-engine-capability-matrix.json')

/** The earliest Atta main-branch commit carrying the halt-and-resume delivery this matrix judges. */
const ATTA_COMMIT_FLOOR = '249d8fc11e525bd015daf9b35cfbd9cfac66f44d'
const CONSUMPTION_BOUNDARY = 'packed-public-runtime+injected-executor'
const CONCLUSIONS = ['fit', 'gap'] as const
const ROW_KINDS = ['runtime', 'policy', 'core-port', 'pattern', 'adapter', 'confinement', 'confinement-gap'] as const
const SOURCE_KINDS = ['atta-source', 'framework-doc', 'pattern-doc', 'adapter-doc', 'repo-spec', 'repo-source'] as const
/** Kinds whose rows must trace to the invariant register or say why they cannot. */
const TRACED_KINDS = new Set<string>(['runtime', 'policy', 'core-port', 'confinement-gap'])
/** Kinds that form the provider-neutral core: no vendor may be named in them. */
const CORE_KINDS = new Set<string>(['runtime', 'policy', 'core-port'])
const VENDOR_WORDS = /\b(claude|codex|anthropic|openai|gemini)\b/i
/** Hosts an adapter cell may never rest on: an API-key SDK and the API platform pages. */
const FORBIDDEN_ADAPTER_URL = [
  /^https:\/\/openai\.github\.io\/openai-agents/,
  /^https:\/\/platform\.openai\.com\//,
  /^https:\/\/platform\.claude\.com\//,
  /^https:\/\/docs\.anthropic\.com\/en\/api\//,
  /^https:\/\/docs\.claude\.com\/en\/api\//
]
const PINNED_GITHUB = /^https:\/\/github\.com\/[^/]+\/[^/]+\/blob\/([0-9a-f]{40})\//
const LINE_ANCHOR = /^L\d+(-L\d+)? — \S/
const DRIVER_TOOLS = ['publish_changes', 'open_pull_request'] as const
const NAMED_CONFINEMENT_GAPS = ['GAP-CONF-01', 'GAP-CONF-02', 'GAP-CONF-03'] as const

interface Source {
  kind: string
  url: string
  title: string
  adapter?: string
  path?: string
  sections?: string[]
}
interface Citation {
  source: string
  anchor: string
}
interface Row {
  id: string
  kind: string
  capability: string
  owner: string
  mechanism: string
  limitation: string
  conclusion: string
  citations: Citation[]
  traces?: string[]
  untracedReason?: string
  consumptionBoundary?: string
  port?: string
  adapter?: string
  adapterCapability?: string
  providerSpecific?: boolean
  platform?: string
  sandbox?: string
  refusal?: string
  publication?: string
  owningLayer?: string
  gap?: string
  gaps?: string[]
}
interface Gap {
  id: string
  name: string
  owningLayer: string
  escalation: string
}
interface Matrix {
  schemaVersion: number
  spec: string
  invariantRegister: string
  retrieved: string
  consumptionBoundary: { id: string; attaCommit: string; vinayaRevision: string; packages: string[] }
  owners: string[]
  ports: string[]
  adapters: string[]
  platforms: string[]
  adapterCapabilities: string[]
  sources: Record<string, Source>
  rows: Row[]
  gaps: Gap[]
}

const matrix: Matrix = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
const register: { invariants: { id: string }[]; defects: { id: string }[] } = JSON.parse(
  readFileSync(join(REPO_ROOT, matrix.invariantRegister), 'utf8')
)

// --- the checks, as pure functions so their own failure modes are testable --

const blank = (s: string | undefined) => s === undefined || s.trim().length === 0

/** A URL fixed to one version: https, no query or fragment, and a GitHub blob only at a full commit. */
function isPinnedUrl(url: string): boolean {
  if (!url.startsWith('https://') || url.includes('?') || url.includes('#')) return false
  if (url.startsWith('https://github.com/')) return PINNED_GITHUB.test(url)
  return true
}

/** The headings of a markdown file, without their leading `#`s. */
function headingsOf(markdown: string): Set<string> {
  const out = new Set<string>()
  for (const line of markdown.split('\n')) {
    if (!line.startsWith('#')) continue
    const text = line.replace(/^#+/, '').trim()
    if (text.length > 0) out.add(text)
  }
  return out
}

/** Why a citation fails to carry both a pinned URL and a valid, non-empty section anchor — or null. */
function citationProblem(c: Citation, m: Matrix): string | null {
  const s = m.sources[c.source]
  if (s === undefined) return `unknown source ${c.source}`
  if (!isPinnedUrl(s.url)) return `${c.source}: URL not pinned`
  if (blank(c.anchor)) return `${c.source}: empty anchor`
  if (s.kind === 'atta-source' || s.kind === 'repo-source') {
    return LINE_ANCHOR.test(c.anchor) ? null : `${c.source}: anchor "${c.anchor}" is not a line anchor`
  }
  if (!(s.sections ?? []).includes(c.anchor)) return `${c.source}: anchor "${c.anchor}" is not a declared section`
  return null
}

/** Every completeness defect in one row: an empty cell, or no citation carrying URL plus anchor. */
function rowProblems(r: Row, m: Matrix): string[] {
  const out: string[] = []
  if (blank(r.owner) || !m.owners.includes(r.owner)) out.push(`${r.id}: owner`)
  if (blank(r.mechanism)) out.push(`${r.id}: mechanism`)
  if (blank(r.limitation)) out.push(`${r.id}: limitation`)
  if (!(CONCLUSIONS as readonly string[]).includes(r.conclusion)) out.push(`${r.id}: conclusion`)
  if (r.citations.length === 0) out.push(`${r.id}: no citation`)
  for (const c of r.citations) {
    const p = citationProblem(c, m)
    if (p !== null) out.push(`${r.id}: ${p}`)
  }
  return out
}

/** Why an adapter-owned cell is grounded in something other than its own adapter's documentation — or null. */
function adapterCellProblem(r: Row, m: Matrix): string | null {
  if (r.adapter === undefined) return null
  const sources = r.citations.map((c) => m.sources[c.source]).filter((s): s is Source => s !== undefined)
  const forbidden = sources.find((s) => FORBIDDEN_ADAPTER_URL.some((re) => re.test(s.url)))
  if (forbidden) return `${r.id}: cites ${forbidden.url}`
  if (sources.some((s) => s.kind === 'pattern-doc')) return `${r.id}: cites a pattern-only source`
  if (sources.some((s) => s.kind === 'adapter-doc' && s.adapter !== r.adapter)) {
    return `${r.id}: cites another adapter's documentation`
  }
  if (!sources.some((s) => s.kind === 'adapter-doc' && s.adapter === r.adapter)) {
    return `${r.id}: cites none of ${r.adapter}'s own documentation`
  }
  return null
}

/** Every (adapter, required capability) pair with no adapter-owned cell, or more than one. */
function parityProblems(m: Matrix): string[] {
  const out: string[] = []
  for (const a of m.adapters) {
    for (const cap of m.adapterCapabilities) {
      const cells = m.rows.filter((r) => r.kind === 'adapter' && r.adapter === a && r.adapterCapability === cap)
      if (cells.length !== 1) out.push(`${a}/${cap}: ${cells.length} cells`)
    }
  }
  return out
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const v of values) out[v] = (out[v] ?? 0) + 1
  return out
}

const rows = matrix.rows
const ids = rows.map((r) => r.id)
const traceIds = new Set([...register.invariants.map((i) => i.id), ...register.defects.map((d) => d.id)])
const gapIds = new Set(matrix.gaps.map((g) => g.id))
const allProblems = rows.flatMap((r) => rowProblems(r, matrix))
const adapterProblems = rows.map((r) => adapterCellProblem(r, matrix)).filter((p): p is string => p !== null)
const confinementRows = rows.filter((r) => r.kind === 'confinement')
const confinementGaps = rows.filter((r) => r.kind === 'confinement-gap')

describe('capability matrix (O1: every row mechanically complete)', () => {
  it('rows are uniquely identified and of a known kind; sources are of a known kind', () => {
    expect(new Set(ids).size).toBe(ids.length)
    for (const r of rows) expect(ROW_KINDS as readonly string[]).toContain(r.kind)
    for (const s of Object.values(matrix.sources)) expect(SOURCE_KINDS as readonly string[]).toContain(s.kind)
  })

  it('reports zero empty owners, mechanisms, limitations and unanchored or unpinned citations', () => {
    expect(allProblems).toEqual([])
  })

  it('every declared section of an in-repo spec is a real heading of that file', () => {
    const missing: string[] = []
    for (const [key, s] of Object.entries(matrix.sources)) {
      if (s.kind !== 'repo-spec') continue
      const headings = headingsOf(readFileSync(join(REPO_ROOT, s.path as string), 'utf8'))
      for (const h of s.sections ?? []) if (!headings.has(h)) missing.push(`${key}: ${h}`)
    }
    expect(missing).toEqual([])
  })

  it('every in-repo source is pinned at the revision the matrix was read at', () => {
    for (const s of Object.values(matrix.sources)) {
      if (s.kind !== 'repo-spec' && s.kind !== 'repo-source') continue
      expect(s.url.match(PINNED_GITHUB)?.[1]).toBe(matrix.consumptionBoundary.vinayaRevision)
      expect(s.url.endsWith(`/${s.path}`)).toBe(true)
    }
  })

  it('every trace resolves in the invariant register, and an untraced core row says why', () => {
    const unresolved = rows.flatMap((r) => (r.traces ?? []).filter((t) => !traceIds.has(t)).map((t) => `${r.id}: ${t}`))
    expect(unresolved).toEqual([])
    const silent = rows.filter(
      (r) => TRACED_KINDS.has(r.kind) && (r.traces ?? []).length === 0 && blank(r.untracedReason)
    )
    expect(silent.map((r) => r.id)).toEqual([])
  })

  it('an empty owner, an empty anchor and an unpinned GitHub URL each fail', () => {
    const base = rows[0] as Row
    expect(rowProblems({ ...base, owner: ' ' }, matrix)).toContain(`${base.id}: owner`)
    const emptyAnchor: Row = { ...base, citations: [{ source: 'langgraph-thinking', anchor: '' }] }
    expect(rowProblems(emptyAnchor, matrix)).toEqual([`${base.id}: langgraph-thinking: empty anchor`])
    const unpinned: Matrix = {
      ...matrix,
      sources: {
        ...matrix.sources,
        'atta-index': {
          ...(matrix.sources['atta-index'] as Source),
          url: 'https://github.com/atta-labs/attalabs/blob/main/packages/executor-agent-spawn/src/index.ts'
        }
      }
    }
    expect(citationProblem({ source: 'atta-index', anchor: 'L35 — run-control' }, unpinned)).toBe(
      'atta-index: URL not pinned'
    )
    expect(citationProblem({ source: 'langgraph-thinking', anchor: 'Not a section' }, matrix)).not.toBeNull()
  })
})

describe('capability matrix (O2: Atta conclusions on the decided consumption boundary)', () => {
  const runtime = rows.filter((r) => r.kind === 'runtime')

  it('the decided boundary is the packed public runtime with the injected executor, at the Atta commit floor', () => {
    expect(matrix.consumptionBoundary.id).toBe(CONSUMPTION_BOUNDARY)
    expect(matrix.consumptionBoundary.attaCommit).toBe(ATTA_COMMIT_FLOOR)
    expect(matrix.consumptionBoundary.packages).toContain('@atta/executor-agent-spawn')
  })

  it('every Atta source is pinned at the recorded Atta commit', () => {
    const atta = Object.values(matrix.sources).filter((s) => s.kind === 'atta-source')
    expect(atta.length).toBeGreaterThan(0)
    for (const s of atta) expect(s.url.match(PINNED_GITHUB)?.[1]).toBe(matrix.consumptionBoundary.attaCommit)
  })

  it('every runtime row records the boundary, is owned by Atta, and cites pinned Atta source', () => {
    expect(runtime.length).toBeGreaterThan(0)
    for (const r of runtime) {
      expect(r.consumptionBoundary).toBe(CONSUMPTION_BOUNDARY)
      expect(['atta-engine', 'atta-runtime']).toContain(r.owner)
      expect(r.citations.some((c) => matrix.sources[c.source]?.kind === 'atta-source')).toBe(true)
    }
  })

  it('every conclusion is fit or a named gap, and a gap names its owning layer and escalation only', () => {
    for (const r of rows) {
      if (r.conclusion === 'gap') expect(gapIds.has(r.gap as string)).toBe(true)
      else expect(r.gap).toBeUndefined()
    }
    for (const g of matrix.gaps) {
      expect(Object.keys(g).sort()).toEqual(['escalation', 'id', 'name', 'owningLayer'])
      expect(blank(g.owningLayer) || blank(g.escalation) || blank(g.name)).toBe(false)
      expect(rows.some((r) => r.gap === g.id)).toBe(true)
    }
  })
})

describe('capability matrix (O3: one core contract for every adapter)', () => {
  it('the core names the five ports, each with its own row', () => {
    expect(matrix.ports).toEqual(['AgentRuntime', 'ToolCatalog', 'SourceProvider', 'EffectExecutor', 'RunControl'])
    for (const p of matrix.ports) expect(rows.filter((r) => r.kind === 'core-port' && r.port === p).length).toBe(1)
  })

  it('no core row names a vendor, and no core row is adapter-owned', () => {
    const named = rows
      .filter((r) => CORE_KINDS.has(r.kind))
      .filter((r) => VENDOR_WORDS.test(`${r.capability} ${r.mechanism} ${r.limitation}`))
    expect(named.map((r) => r.id)).toEqual([])
    for (const r of rows.filter((r) => CORE_KINDS.has(r.kind))) {
      expect(r.adapter).toBeUndefined()
      expect(r.owner).not.toBe('provider-adapter')
    }
  })

  it('every adapter fills every required capability exactly once, and provider-specific cells are adapter-owned', () => {
    expect(parityProblems(matrix)).toEqual([])
    for (const r of rows.filter((r) => r.kind === 'adapter')) {
      expect(r.owner).toBe('provider-adapter')
      expect(matrix.adapters).toContain(r.adapter as string)
      const required = matrix.adapterCapabilities.includes(r.adapterCapability as string)
      expect(required).toBe(r.providerSpecific !== true)
    }
    for (const r of rows.filter((r) => r.providerSpecific === true)) expect(r.kind).toBe('adapter')
  })

  it("reports zero adapter cells grounded outside their own adapter's documentation", () => {
    expect(adapterProblems).toEqual([])
  })

  it('an adapter cell citing the agents SDK or an API platform page fails', () => {
    const cell = rows.find((r) => r.kind === 'adapter' && r.adapter === 'codex') as Row
    const viaSdk: Row = {
      ...cell,
      citations: [...cell.citations, { source: 'openai-agents-tracing', anchor: 'Sensitive data' }]
    }
    expect(adapterCellProblem(viaSdk, matrix)).toBe(
      `${cell.id}: cites https://openai.github.io/openai-agents-js/guides/tracing/`
    )
    const platform: Matrix = {
      ...matrix,
      sources: {
        ...matrix.sources,
        'claude-platform': {
          kind: 'adapter-doc',
          adapter: 'claude-code',
          url: 'https://platform.claude.com/docs/en/build-with-claude/tool-use',
          title: 'probe',
          sections: ['Probe']
        }
      }
    }
    const claudeCell = rows.find((r) => r.kind === 'adapter' && r.adapter === 'claude-code') as Row
    const viaPlatform: Row = { ...claudeCell, citations: [{ source: 'claude-platform', anchor: 'Probe' }] }
    expect(adapterCellProblem(viaPlatform, platform)).toBe(
      `${claudeCell.id}: cites https://platform.claude.com/docs/en/build-with-claude/tool-use`
    )
  })

  it('a future adapter registered without its cells fails parity', () => {
    const withFuture: Matrix = { ...matrix, adapters: [...matrix.adapters, 'future-provider'] }
    expect(parityProblems(withFuture)).toHaveLength(matrix.adapterCapabilities.length)
  })
})

describe('capability matrix (O4: confinement per adapter and platform, with the gaps named)', () => {
  it('one confinement row per adapter and platform, naming sandbox, refusal and driver-run publication', () => {
    const pairs = confinementRows.map((r) => `${r.adapter}/${r.platform}`).sort()
    expect(pairs).toEqual(matrix.adapters.flatMap((a) => matrix.platforms.map((p) => `${a}/${p}`)).sort())
    for (const r of confinementRows) {
      expect(blank(r.sandbox) || blank(r.refusal) || blank(r.publication)).toBe(false)
      for (const tool of DRIVER_TOOLS) expect(r.publication).toContain(tool)
      expect(r.citations.some((c) => matrix.sources[c.source]?.path === 'apps/cli/specs/isolation.md')).toBe(true)
      for (const g of r.gaps ?? []) expect(NAMED_CONFINEMENT_GAPS as readonly string[]).toContain(g)
    }
  })

  it('the three confinement gaps each appear as a gap row with its owning layer', () => {
    expect(confinementGaps.map((r) => r.id).sort()).toEqual([...NAMED_CONFINEMENT_GAPS])
    for (const r of confinementGaps) {
      expect(r.conclusion).toBe('gap')
      expect(r.gap).toBe(r.id)
      expect(blank(r.owningLayer)).toBe(false)
      expect(matrix.gaps.find((g) => g.id === r.id)?.owningLayer).toBe(r.owningLayer as string)
    }
  })

  it('prints the matrix counts', () => {
    const byOwner = countBy(rows.map((r) => r.owner))
    const byKind = countBy(rows.map((r) => r.kind))
    const fit = rows.filter((r) => r.conclusion === 'fit').length
    const gap = rows.filter((r) => r.conclusion === 'gap').length
    const adapterCells = rows.filter((r) => r.adapter !== undefined)
    const citations = rows.flatMap((r) => r.citations)
    const lines = [
      `matrix rows: ${rows.length} (${Object.entries(byKind)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')})`,
      `owners: ${matrix.owners.map((o) => `${o} ${byOwner[o] ?? 0}`).join(', ')}; empty owner cells: ${rows.filter((r) => blank(r.owner)).length}`,
      `fit: ${fit}; gap: ${gap}; named gaps: ${matrix.gaps.length}`,
      `providers: ${matrix.adapters.length} (${matrix.adapters.join(', ')}); adapter cells: ${adapterCells.length}; required capabilities per adapter: ${matrix.adapterCapabilities.length}`,
      `confinement rows: ${confinementRows.length}; confinement gaps: ${confinementGaps.length}`,
      `citations: ${citations.length} across ${new Set(citations.map((c) => c.source)).size} sources; lacking a pinned URL plus section anchor: ${allProblems.filter((p) => p.includes('anchor') || p.includes('pinned') || p.includes('citation')).length}`,
      `adapter cells citing the agents SDK or an API platform page: ${adapterProblems.filter((p) => p.includes('cites http')).length}`
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    expect(fit + gap).toBe(rows.length)
  })
})
