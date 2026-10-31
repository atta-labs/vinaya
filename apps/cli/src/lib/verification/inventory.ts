/**
 * The generic half of the test inventory: validating a revision's inventory
 * view, and answering which readers a changed input reaches.
 *
 * A repository builds its views itself — where its declarations live, how its
 * runners are configured and which files it holds are the repository's to
 * read. This module only checks that a view has the shape every selection
 * relies on, and reads the edges it carries. It reads no file, runs nothing and
 * records nothing.
 *
 * Every view is per revision. {@link changedInputReaders} looks a change up on
 * both the base view (at the change's old path) and the head view, so an edge
 * the head removed, or an input it deleted, still names its readers.
 */
import { createHash } from 'node:crypto'
import { inputCovers } from './path-pattern.js'
import type {
  FormatParsers,
  InputChange,
  InputFormat,
  InputImpact,
  InventoryProblem,
  InventoryView,
  ReaderKind,
  ResolvedEdge,
  SelectionInventory
} from './types.js'

/** JSON with object keys sorted, so equal values hash equally. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object')
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** The sha256 of a value's {@link stableJson}. */
export function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

// ── Validation ─────────────────────────────────────────────────────────────

const READER_KINDS: ReadonlySet<string> = new Set(['code', 'raw-bytes', 'semantic', 'parsed-keys', 'schema-policy'])
const EDGE_KINDS: ReadonlySet<string> = new Set([
  'import',
  'preload',
  'runner-config',
  'lockfile',
  'fixture',
  'schema',
  'doc',
  'config',
  'spawn',
  'scan',
  'provider'
])
const POLICY_KINDS: ReadonlySet<string> = new Set(['always-run', 'mandatory', 'security', 'oracle'])
const RUNNERS: ReadonlySet<string> = new Set(['bun', 'vitest'])

/** The declaration lists an inventory carries; each must be a list. */
export const DECLARATION_LISTS = [
  'suites',
  'typeInputs',
  'exclusions',
  'inputs',
  'providers',
  'policies',
  'unknowns'
] as const

/** A `schema` problem for each {@link DECLARATION_LISTS} entry of `declarations` that is not a list. */
export function declarationListProblems(declarations: Record<string, unknown>, path: string): InventoryProblem[] {
  return DECLARATION_LISTS.filter((key) => !Array.isArray(declarations[key])).map((key) => ({
    code: 'schema' as const,
    path,
    detail: `${key} is not a list`
  }))
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/**
 * Every way `view` falls short of the shape a selection reads: a field of the
 * wrong type, an unknown edge, reader or policy kind, a test with an unknown
 * runner, or an edge naming a reader that is not one of the view's tests. A
 * view's own recorded problems are reported too — a view with problems is not
 * a validated view. An empty list is a valid view.
 */
export function validateInventoryView(view: unknown): InventoryProblem[] {
  const problems: InventoryProblem[] = []
  const at = isRecord(view) && isString(view.revision) ? view.revision : '<view>'
  const problem = (detail: string) => problems.push({ code: 'schema', path: at, detail })
  if (!isRecord(view)) {
    problem('the view is not an object')
    return problems
  }
  if (!isString(view.revision) || view.revision.length === 0) problem('revision is not a non-empty string')
  if (typeof view.modeled !== 'boolean') problem('modeled is not a boolean')
  for (const key of ['schemaIdentity', 'contextIdentity', 'graphIdentity'] as const)
    if (!isString(view[key])) problem(`${key} is not a string`)
  for (const key of [
    'workspaces',
    'suites',
    'tests',
    'exclusions',
    'typeInputs',
    'edges',
    'unknowns',
    'policies',
    'problems'
  ] as const)
    if (!Array.isArray(view[key])) problem(`${key} is not a list`)
  if (problems.length > 0) return problems

  const tests = view.tests as unknown[]
  const ids = new Set<string>()
  for (const test of tests) {
    if (!isRecord(test) || !isString(test.id) || !isString(test.suite) || !isString(test.runner)) {
      problem('a test is not { id, suite, runner }')
      continue
    }
    if (!RUNNERS.has(test.runner)) problem(`test ${test.id} names the unknown runner ${test.runner}`)
    if (ids.has(test.id)) problem(`test ${test.id} is listed twice`)
    ids.add(test.id)
  }
  for (const suite of view.suites as unknown[])
    if (!isRecord(suite) || !isString(suite.id) || !isString(suite.runner) || !Array.isArray(suite.configFiles))
      problem('a suite is not { id, runner, configFiles }')
  for (const edge of view.edges as unknown[]) {
    if (!isRecord(edge) || !isString(edge.input) || !isString(edge.source) || !Array.isArray(edge.readers)) {
      problem('an edge is not { input, kind, readerKind, readers, source }')
      continue
    }
    if (!isString(edge.kind) || !EDGE_KINDS.has(edge.kind))
      problem(`edge ${edge.source} has the unknown kind ${String(edge.kind)}`)
    if (!isString(edge.readerKind) || !READER_KINDS.has(edge.readerKind))
      problem(`edge ${edge.source} has the unknown reader kind ${String(edge.readerKind)}`)
    if (edge.readerKind === 'parsed-keys' && !(Array.isArray(edge.keys) && edge.keys.length > 0))
      problem(`edge ${edge.source} is a parsed-keys reader with no key domain`)
    for (const reader of edge.readers)
      if (!isString(reader) || !ids.has(reader))
        problem(`edge ${edge.source} names ${String(reader)}, which is not a test of this view`)
  }
  for (const policy of view.policies as unknown[])
    if (
      !isRecord(policy) ||
      !isString(policy.id) ||
      !isString(policy.kind) ||
      !POLICY_KINDS.has(policy.kind) ||
      !Array.isArray(policy.inputs)
    )
      problem('a policy is not { id, kind, inputs } with a known kind')
  for (const scope of view.unknowns as unknown[])
    if (!isRecord(scope) || !isString(scope.scope) || !isString(scope.reason))
      problem('an unknown scope is not { scope, reason }')
  for (const recorded of view.problems as InventoryProblem[]) problems.push(recorded)
  return problems
}

/**
 * Validates the views a selection reads: the head must be a valid, modeled
 * view with no problems; a base may be unmodeled or carry problems (a revision
 * older than its inventory), but its shape must still hold. Problems are
 * returned, never thrown.
 */
export function validateInventory(inventory: SelectionInventory): InventoryProblem[] {
  const problems = [...validateInventoryView(inventory.head)]
  if (inventory.head && (inventory.head as InventoryView).modeled === false)
    problems.push({
      code: 'unmodeled',
      path: inventory.head.revision,
      detail: 'the head view carries no inventory declarations'
    })
  // A base records its own problems (an unmodeled or stale older revision);
  // only its shape must hold here, and a selection reads a base with problems
  // as unmodeled.
  if (inventory.base) problems.push(...validateInventoryView({ ...inventory.base, problems: [] }))
  return problems
}

/** Test identities added, removed and renamed between two views; `renames` maps an old path to its new one. */
export function diffTestIdentities(
  base: InventoryView,
  head: InventoryView,
  renames: ReadonlyMap<string, string> = new Map()
): { added: string[]; removed: string[]; renamed: { from: string; to: string }[] } {
  const before = new Set(base.tests.map((t) => t.id))
  const after = new Set(head.tests.map((t) => t.id))
  const renamed = [...renames]
    .filter(([from, to]) => before.has(from) && after.has(to))
    .map(([from, to]) => ({ from, to }))
  const renamedFrom = new Set(renamed.map((r) => r.from))
  const renamedTo = new Set(renamed.map((r) => r.to))
  return {
    added: [...after].filter((id) => !before.has(id) && !renamedTo.has(id)).sort(),
    removed: [...before].filter((id) => !after.has(id) && !renamedFrom.has(id)).sort(),
    renamed
  }
}

// ── Which readers a changed input reaches ──────────────────────────────────

/**
 * Whether an edge's input covers `path`. A scan root is a prefix as its
 * declaration writes it — a folder, a file, or a file-name prefix — and `.`
 * is the whole repository.
 */
export function edgeCovers(edge: ResolvedEdge, path: string): boolean {
  if (edge.kind === 'scan') return edge.input === '.' || path.startsWith(edge.input)
  return inputCovers(edge.input, path)
}

function parseByFormat(
  text: string,
  format: InputFormat | undefined,
  parsers: FormatParsers
): { ok: true; value: unknown } | { ok: false } {
  if (format === 'json' || format === 'toml') {
    const parse = parsers[format] ?? (format === 'json' ? (t: string) => JSON.parse(t) as unknown : null)
    if (!parse) return { ok: false }
    try {
      return { ok: true, value: parse(text) }
    } catch {
      return { ok: false }
    }
  }
  return { ok: true, value: text }
}

/** Every leaf key path whose value differs between two parsed values. */
function changedKeyPaths(a: unknown, b: unknown, prefix = ''): string[] {
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)])
    return [...keys].flatMap((k) => changedKeyPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k))
  }
  return stableJson(a) === stableJson(b) ? [] : [prefix]
}

function keyCovered(changed: string, domain: string): boolean {
  return changed === domain || changed.startsWith(`${domain}.`) || domain.startsWith(`${changed}.`) || changed === ''
}

/**
 * The tests a changed input reaches, by how each reads it, looked up on both
 * the base view (at the change's old path) and the head view — so an edge
 * the head removed, or an input it deleted, still names its readers.
 *
 * A raw-bytes or code reader is reached by any byte change; a schema or
 * policy consumer, and every security or mandatory policy over the input, by
 * any byte change too. A semantic reader is reached only when the parsed
 * value differs, and a parsed-keys reader only when a key in its domain
 * does — so formatting alone reaches neither. A changed key no declared
 * domain covers, a side that is malformed, absent or deleted, an unmodeled
 * base, an unknown scope over the path, or a path no edge names keeps the
 * conservative answer: every reader of the input, and an unknown naming why.
 * A format with no parser in `parsers` (JSON needs none) reads as malformed.
 */
export function changedInputReaders(
  base: InventoryView | null,
  head: InventoryView,
  change: InputChange,
  parsers: FormatParsers = {}
): InputImpact {
  const impact: InputImpact = { readers: [], policies: [], unknown: [] }
  const reached = new Map<string, InputImpact['readers'][number]>()
  const reach = (test: string, readerKind: ReaderKind, edge: string, reason: string) => {
    const key = `${test}\0${readerKind}\0${edge}`
    if (!reached.has(key)) reached.set(key, { test, readerKind, edge, reason })
  }
  const basePath = change.from ?? change.path
  const candidates: { edge: ResolvedEdge; side: 'base' | 'head' }[] = []
  if (base?.modeled)
    for (const edge of base.edges) if (edgeCovers(edge, basePath)) candidates.push({ edge, side: 'base' })
  for (const edge of head.edges) if (edgeCovers(edge, change.path)) candidates.push({ edge, side: 'head' })

  if (base && !base.modeled)
    impact.unknown.push({
      scope: basePath,
      reason: 'the base revision is not modeled, so its readers of this path are unknown'
    })
  for (const view of [base, head]) {
    for (const scope of view?.unknowns ?? [])
      if (scope.scope === '.' || inputCovers(scope.scope, change.path) || inputCovers(scope.scope, basePath))
        impact.unknown.push(scope)
  }
  if (candidates.length === 0)
    impact.unknown.push({ scope: change.path, reason: 'no declared edge names this path, so its readers are unknown' })

  const bytesChanged = change.before !== change.after
  const conservative = (reason: string) => {
    for (const { edge } of candidates)
      for (const test of edge.readers) reach(test, edge.readerKind, edge.source, reason)
  }

  if (change.before === null || change.after === null) {
    if (bytesChanged) {
      const why = change.after === null ? 'the input was deleted' : 'the input was added'
      impact.unknown.push({ scope: change.path, reason: `${why}, so every reader of it is reached` })
      conservative(why)
    }
  } else if (bytesChanged) {
    // Key domains declared over this input, across both views.
    const domains = candidates
      .filter(({ edge }) => edge.readerKind === 'parsed-keys')
      .flatMap(({ edge }) => edge.keys ?? [])
    const hasSemantic = candidates.some(({ edge }) => edge.readerKind === 'semantic')
    let parsedFallback = false
    for (const { edge } of candidates) {
      if (edge.readerKind === 'code' || edge.readerKind === 'raw-bytes' || edge.readerKind === 'schema-policy') {
        for (const test of edge.readers) reach(test, edge.readerKind, edge.source, 'its bytes changed')
        continue
      }
      const before = parseByFormat(change.before, edge.format, parsers)
      const after = parseByFormat(change.after, edge.format, parsers)
      if (!before.ok || !after.ok) {
        parsedFallback = true
        continue
      }
      const keys = changedKeyPaths(before.value, after.value)
      if (keys.length === 0) continue // formatting only: the parsed value is the same.
      if (edge.readerKind === 'semantic') {
        for (const test of edge.readers)
          reach(test, 'semantic', edge.source, `its parsed value changed (${keys.join(', ')})`)
        continue
      }
      const relevant = keys.filter((k) => (edge.keys ?? []).some((domain) => keyCovered(k, domain)))
      if (relevant.length > 0)
        for (const test of edge.readers)
          reach(test, 'parsed-keys', edge.source, `a key it reads changed (${relevant.join(', ')})`)
      const unclaimed = keys.filter((k) => !domains.some((domain) => keyCovered(k, domain)))
      if (unclaimed.length > 0 && !hasSemantic) {
        for (const key of unclaimed)
          impact.unknown.push({
            scope: `${change.path}#${key}`,
            reason: 'a changed key belongs to no declared key domain'
          })
        parsedFallback = true
      }
    }
    if (parsedFallback) {
      if (!impact.unknown.some((u) => u.scope.startsWith(change.path)))
        impact.unknown.push({
          scope: change.path,
          reason: 'the input does not parse on one side, so it is read conservatively'
        })
      conservative('the change could not be confined to declared keys')
    }
  }

  if (bytesChanged) {
    for (const view of [base, head]) {
      for (const policy of view?.policies ?? []) {
        if (policy.kind !== 'security' && policy.kind !== 'mandatory') continue
        const covers = policy.inputs.some((entry) => {
          const target = entry.split('#')[0] as string
          return inputCovers(target, change.path) || inputCovers(target, basePath)
        })
        if (covers && !impact.policies.some((p) => p.id === policy.id))
          impact.policies.push({ id: policy.id, kind: policy.kind, duty: policy.duty })
      }
    }
  }
  impact.readers = [...reached.values()].sort((a, b) => a.test.localeCompare(b.test) || a.edge.localeCompare(b.edge))
  const seenUnknown = new Set<string>()
  impact.unknown = impact.unknown.filter((u) => {
    const key = `${u.scope}\0${u.reason}`
    if (seenUnknown.has(key)) return false
    seenUnknown.add(key)
    return true
  })
  return impact
}
