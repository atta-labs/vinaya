/**
 * The evaluation foundation's global exit check: one pure function over the
 * aggregated registry rows and the universes the caller derives, claiming
 * zero uncovered components across the complete kind set. Each shard's own
 * check proves completeness for its kinds alone; only this check claims the
 * exit. It also reports, per kind, the rows proved on the Engine and those
 * still owing that proof; owed proof never fails the exit. Beside it,
 * `checkOwedEngineEvidence` holds the shrink-only list of owed Engine
 * evidence to the rows. Neither reads a file; both are run by tests, not
 * imported by the CLI. The specification is `apps/cli/specs/evals.md`,
 * "Global exit check" and "Owed Engine evidence".
 */

import {
  COMPONENT_KINDS,
  type ComponentKind,
  type ComponentRow,
  EVIDENCE_KINDS,
  isPlaceholder,
  type ModuleCatalog,
  REQUIRED_FIELDS,
  type Shard,
  TASK_CASES
} from './registry'

/** The shards the foundation delivers, by name. */
export const EXPECTED_SHARDS = ['typed-sources', 'contract-kinds', 'cutover-gates', 'fault-attack'] as const

/** The row counts after the Operator-owned rows are excluded from this project's exit. */
export const EXPECTED_COUNTS: Partial<Record<ComponentKind, number>> = { 'cutover-gate': 16, 'fault-attack': 56 }

export interface ExitExclusion {
  kind: ComponentKind | 'check' | 'module'
  name: string
  owner: 'Operator on one host'
  reason: string
}

const OPERATOR_REASON = 'Owned by the Operator on one host project; its own exit check runs with no exclusions.'
const operator = (kind: ExitExclusion['kind'], name: string): ExitExclusion => ({
  kind,
  name,
  owner: 'Operator on one host',
  reason: OPERATOR_REASON
})

/** Shrink-only debt owned by the Operator project, listed row by row. */
export const OPERATOR_EXIT_EXCLUSIONS: readonly ExitExclusion[] = [
  operator('check', 'program-6.23-supporting-pull-request-read'),
  operator('module', '6.14'),
  operator('module', '6.23'),
  operator('cutover-gate', 'gate-11'),
  operator('fault-attack', '11-consumed-or-stale-ruling-replayed'),
  operator('fault-attack', '51-human-wait-principal-ruling-pause'),
  ...[
    '59-operator-session-attempts-shell-arbitrary-file-or-controller',
    '60-codex-residual-apply-patch-or-another-built-in-attempts-a',
    '61-installed-plugin-merged-configuration-or-trusted-project',
    '62-claude-or-codex-instruction-document-is-missing-changed',
    '63-inert-client-terminal-primitive-is-invoked',
    '64-hook-is-absent-or-bypassed',
    '65-maximum-valid-task-log-read-result-crosses-claude-s',
    '66-codex-maximum-valid-task-log-read-result-exceeds-an',
    '67-injected-or-oversized-log-text',
    '68-log-read-targets-another-task-or-reuses-another-task-s',
    '69-log-source-is-absent-corrupt-or-unreadable',
    '70-persistent-installation-id-enters-model-context-tool-output',
    '71-host-check-result-is-replayed-or-misread-as-start-authority',
    '72-installation-record-update-fails-partway',
    '73-persistent-installation-record-is-absent-reset-duplicated-or',
    '74-allowed-list-version-or-digest-is-absent-stale-duplicated-or',
    '75-aggregate-readiness-evidence-is-mixed-or-incomplete',
    '76-public-quota-cannot-be-read-while-mandatory-probes-are',
    '77-mandatory-probe-is-false',
    '78-mandatory-probe-times-out-or-is-unavailable',
    '79-agent-or-model-is-omitted-or-pair-is-outside-current-list',
    '80-allowed-list-rotates-between-start-validation-and-launch',
    '81-running-pair-is-removed-from-the-allowed-list',
    '82-installation-record-resets-before-resume',
    '83-start-acknowledgement-is-lost-or-request-replayed',
    '84-caller-attempts-to-choose-task-rule-destination',
    '85-pull-request-opens-after-an-issue-bound-pause-but-before',
    '86-ruling-is-posted-or-would-be-posted-somewhere-other-than',
    '87-ruling-casts-a-review-verdict-or-escalation-marker',
    '88-ruling-orders-reset-stash-rebase-commit-push-git-gh-raw',
    '89-validator-bypass-uses-case-unicode-markdown-whitespace-or',
    '90-benign-quotation-mention-explanation-or-negation-names-a',
    '91-issue-side-ruling-is-absent-from-pull-request-projection-or',
    '92-identical-ruling-delivered-twice',
    '93-conflicting-stale-wrong-task-superseded-or-already-consumed',
    '94-ruling-publication-succeeds-but-acknowledgement-is-lost',
    '95-task-rule-is-misread-as-continuation-authority',
    '96-standalone-engine-or-claude-codex-expose-different-schemas'
  ].map((name) => operator('fault-attack', name))
]

export type ExitCauseCode =
  | 'shard_absent'
  | 'kind_missing'
  | 'duplicate_id'
  | 'empty_field'
  | 'no_module'
  | 'module_unnamed'
  | 'universe_missing'
  | 'universe_extra'
  | 'count_mismatch'
  | 'exclusion_stale'
  | 'exclusion_covered'

/** One reason the exit is not met, naming what is wrong. */
export interface ExitCause {
  code: ExitCauseCode
  detail: string
}

export interface ExitKindReport {
  /** Rows of this kind, each id counted once. */
  covered: number
  /** Required fields empty, absent or a placeholder, over this kind's rows. */
  emptyFields: number
  /** Universe members with no row, plus rows naming no live catalog module. */
  unmapped: number
  /** On a kind whose rows carry backend evidence: the rows proved on the Engine and those owing that proof. */
  engine?: EngineEvidenceReport
}

/** The Engine evidence of one kind's rows listing the Engine backend. Owed proof is reported, never refused. */
export interface EngineEvidenceReport {
  /** Rows whose Engine entry names a test file that proves them. */
  evidenced: number
  /** Rows whose Engine proof is owed, or whose live-gated test has no live run recorded. */
  owed: number
  /** The owed rows' ids, in registry order. */
  owedIds: string[]
}

/**
 * Where a row's Engine proof stands. A live-gated test proves its row only
 * once its entry records the pull request carrying the pasted live probe
 * output; until then the live run is owed.
 */
export type EngineEvidenceState =
  | { state: 'evidenced'; test: string }
  | { state: 'owed'; reason: string }
  | { state: 'live-run-owed'; test: string; variable: string }

/** A row's Engine evidence state; `undefined` when the row does not list the Engine backend. */
export function engineEvidenceOf(row: ComponentRow): EngineEvidenceState | undefined {
  if (!row.backends.includes('engine')) return undefined
  const entry = row.backendEvidence?.engine
  if (entry === undefined) return { state: 'owed', reason: 'the row carries no Engine evidence entry' }
  if ('owed' in entry) return { state: 'owed', reason: entry.owed }
  if (entry.liveGated !== undefined && entry.liveGated.liveProbePullRequest === undefined) {
    return { state: 'live-run-owed', test: entry.test, variable: entry.liveGated.variable }
  }
  return { state: 'evidenced', test: entry.test }
}

const carriesEvidence = (kind: ComponentKind): boolean => (EVIDENCE_KINDS as readonly string[]).includes(kind)

export interface ExitInput {
  catalog: ModuleCatalog
  /** Every shard, as aggregated. */
  shards: readonly Shard[]
  /** Every row with its location, as aggregated; checked as given, not re-derived. */
  components: readonly { location: string; row: ComponentRow }[]
  /** Each kind's universe, by name within the kind, derived by the caller from its typed source. */
  universes: Partial<Record<ComponentKind, readonly string[]>>
  /** The row counts the mirror's tables state, for the kinds a table fixes. */
  mirrorCounts: Partial<Record<ComponentKind, number>>
  expectedShards?: readonly string[]
  expectedCounts?: Partial<Record<ComponentKind, number>>
  /** Rows temporarily removed from this global exit; defaults to the Operator-owned list. */
  exclusions?: readonly ExitExclusion[]
  /** Registry rows whose complete table payload already equals the mirror row. */
  mirrorMatchedComponents?: readonly string[]
}

export interface ExitReport {
  pass: boolean
  kinds: Record<ComponentKind, ExitKindReport>
  emptyFields: number
  unmapped: number
  /**
   * The excluded rows, `<kind>:<name>`: owed to the Operator on one host
   * project, never counted as owed Engine evidence of this registry.
   */
  operatorOwed: string[]
  causes: ExitCause[]
}

/** The ten fields of a row that are empty, absent or a placeholder. */
export function emptyFieldsOf(row: ComponentRow): string[] {
  const bare = (value: unknown): boolean => typeof value !== 'string' || value.trim() === '' || isPlaceholder(value)
  const list = (value: unknown): boolean => !Array.isArray(value) || value.length === 0
  const loose = row as unknown as Record<string, unknown>
  const out: string[] = []
  for (const key of REQUIRED_FIELDS) {
    const value = loose[key]
    let empty: boolean
    if (key === 'suite' || key === 'backends' || key === 'cadence') empty = list(value)
    else if (key === 'tasks') {
      const cases = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
      empty = TASK_CASES.some((name) => {
        const one = cases[name] as { present?: unknown; notApplicable?: unknown } | undefined
        return one === undefined || one === null || bare(one.present ?? one.notApplicable)
      })
    } else if (key === 'grader') {
      const g = (typeof value === 'object' && value !== null ? value : {}) as { kinds?: unknown; detail?: unknown }
      empty = list(g.kinds) || bare(g.detail)
    } else empty = bare(value)
    if (empty) out.push(key)
  }
  return out
}

const nameOf = (row: ComponentRow): string =>
  row.id.startsWith(`${row.kind}:`) ? row.id.slice(row.kind.length + 1) : row.id

/** Checks the whole registry against every universe and count; passes only with no cause. */
export function checkExit(input: ExitInput): ExitReport {
  const causes: ExitCause[] = []
  const cause = (code: ExitCauseCode, detail: string) => causes.push({ code, detail })
  const kinds = Object.fromEntries(
    COMPONENT_KINDS.map((k) => [
      k,
      carriesEvidence(k)
        ? { covered: 0, emptyFields: 0, unmapped: 0, engine: { evidenced: 0, owed: 0, owedIds: [] } }
        : { covered: 0, emptyFields: 0, unmapped: 0 }
    ])
  ) as Record<ComponentKind, ExitKindReport>
  const exclusions = (input.exclusions ?? OPERATOR_EXIT_EXCLUSIONS).filter((entry) =>
    COMPONENT_KINDS.includes(entry.kind as ComponentKind)
  )
  const exclusionKeys = new Set(exclusions.map((entry) => `${entry.kind}:${entry.name}`))
  const universeKeys = new Set(
    COMPONENT_KINDS.flatMap((kind) => (input.universes[kind] ?? []).map((name) => `${kind}:${name}`))
  )
  for (const entry of exclusions) {
    const key = `${entry.kind}:${entry.name}`
    if (!universeKeys.has(key)) cause('exclusion_stale', `${key} is excluded but is no longer in the mirror`)
    if (input.mirrorMatchedComponents?.includes(key)) {
      cause('exclusion_covered', `${key} is excluded but its registry row already matches the mirror`)
    }
  }

  const present = new Set(input.shards.map((s) => s.shard))
  for (const name of input.expectedShards ?? EXPECTED_SHARDS) {
    if (!present.has(name)) cause('shard_absent', `shard ${name} is absent`)
  }

  const modules = new Map(input.catalog.modules.map((m) => [m.id, m]))
  const named = new Set<string>()
  const seen = new Map<string, string>()
  const rowsByKind = new Map<ComponentKind, Set<string>>()
  for (const { location, row } of input.components) {
    if (exclusionKeys.has(`${row.kind}:${nameOf(row)}`)) continue
    const report = kinds[row.kind]
    if (report === undefined) {
      cause('kind_missing', `${row.id} at ${location} is of unknown kind ${String(row.kind)}`)
      continue
    }
    const prior = seen.get(row.id)
    if (prior !== undefined) {
      cause('duplicate_id', `${row.id} appears at ${prior} and at ${location}`)
      continue
    }
    seen.set(row.id, location)
    report.covered++
    const names = rowsByKind.get(row.kind) ?? new Set<string>()
    names.add(nameOf(row))
    rowsByKind.set(row.kind, names)

    const engine = report.engine === undefined ? undefined : engineEvidenceOf(row)
    if (report.engine !== undefined && engine !== undefined) {
      if (engine.state === 'evidenced') report.engine.evidenced++
      else {
        report.engine.owed++
        report.engine.owedIds.push(row.id)
      }
    }

    const empty = emptyFieldsOf(row)
    report.emptyFields += empty.length
    for (const key of empty) cause('empty_field', `${row.id} at ${location} has an empty ${key}`)

    const module = typeof row.module === 'string' ? modules.get(row.module) : undefined
    if (module === undefined || module.excluded !== null) {
      report.unmapped++
      cause('no_module', `${row.id} at ${location} names no live catalog module (${JSON.stringify(row.module)})`)
    } else named.add(module.id)
    for (const other of row.additionalModules ?? []) {
      const extra = modules.get(other)
      if (extra === undefined || extra.excluded !== null) {
        report.unmapped++
        cause('no_module', `${row.id} at ${location} names no live catalog module (${JSON.stringify(other)})`)
      } else named.add(extra.id)
    }
  }

  for (const kind of COMPONENT_KINDS) {
    if (kinds[kind].covered === 0) cause('kind_missing', `no component of kind ${kind}`)
    const universe = input.universes[kind]
    if (universe === undefined) {
      cause('universe_missing', `no universe was derived for kind ${kind}`)
      continue
    }
    const have = rowsByKind.get(kind) ?? new Set<string>()
    for (const name of universe) {
      if (exclusionKeys.has(`${kind}:${name}`)) continue
      if (have.has(name)) continue
      kinds[kind].unmapped++
      cause('universe_missing', `${kind}:${name} is in the universe and has no row`)
    }
    const members = new Set(universe)
    for (const name of have)
      if (!members.has(name)) cause('universe_extra', `${kind}:${name} has a row naming no universe member`)
  }

  for (const module of input.catalog.modules) {
    if (module.excluded === null && module.scope !== 'system' && !named.has(module.id)) {
      cause('module_unnamed', `catalog module ${module.id} is named by no component and is not system scope`)
    }
  }

  const expected = input.expectedCounts ?? EXPECTED_COUNTS
  for (const kind of COMPONENT_KINDS) {
    const want = expected[kind]
    if (want === undefined) continue
    const excluded = exclusions.filter((entry) => entry.kind === kind).length
    const mirror = input.mirrorCounts[kind] === undefined ? undefined : input.mirrorCounts[kind] - excluded
    if (mirror !== want)
      cause('count_mismatch', `the mirror's ${kind} table has ${mirror ?? 'no'} rows, expected ${want}`)
    if (kinds[kind].covered !== want) {
      cause('count_mismatch', `${kind} has ${kinds[kind].covered} rows, expected ${want}`)
    }
  }

  const emptyFields = COMPONENT_KINDS.reduce((n, k) => n + kinds[k].emptyFields, 0)
  const unmapped = COMPONENT_KINDS.reduce((n, k) => n + kinds[k].unmapped, 0)
  const operatorOwed = exclusions.map((entry) => `${entry.kind}:${entry.name}`)
  return {
    pass: causes.length === 0 && emptyFields === 0 && unmapped === 0,
    kinds,
    emptyFields,
    unmapped,
    operatorOwed,
    causes
  }
}

// ── The shrink-only list of owed Engine evidence ────────────────────────────

export type OwedListCauseCode =
  | 'owed_unlisted'
  | 'live_run_unrecorded'
  | 'listed_evidenced'
  | 'listed_unknown'
  | 'listed_operator'
  | 'listed_twice'
  | 'list_grew'

export interface OwedListCause {
  code: OwedListCauseCode
  detail: string
}

export interface OwedListInput {
  /** Every row with its location, as aggregated. */
  components: readonly { location: string; row: ComponentRow }[]
  /** The owed list as read: row ids, `<kind>:<name>`. */
  listed: readonly string[]
  /** The most rows the list may hold: it shrinks as proof lands and never gains a row. */
  ceiling: number
  /** Rows owed to the Operator on one host project; defaults to the Operator-owned list. */
  exclusions?: readonly ExitExclusion[]
}

export interface OwedListReport {
  pass: boolean
  /** The rows of this registry owing Engine proof, derived from their evidence entries. */
  owed: string[]
  causes: OwedListCause[]
}

/**
 * Compares the owed list with the rows: every row owing Engine proof is
 * listed, and no listed row has its proof, is owed to the Operator on one
 * host project, or names no row. A live-gated row stays listed until its
 * entry records the pull request carrying the pasted live probe output.
 */
export function checkOwedEngineEvidence(input: OwedListInput): OwedListReport {
  const causes: OwedListCause[] = []
  const cause = (code: OwedListCauseCode, detail: string) => causes.push({ code, detail })
  const operatorRows = new Set(
    (input.exclusions ?? OPERATOR_EXIT_EXCLUSIONS).map((entry) => `${entry.kind}:${entry.name}`)
  )
  const states = new Map<string, EngineEvidenceState>()
  for (const { row } of input.components) {
    if (!carriesEvidence(row.kind) || operatorRows.has(row.id)) continue
    const state = engineEvidenceOf(row)
    if (state !== undefined) states.set(row.id, state)
  }
  const owed = [...states].filter(([, state]) => state.state !== 'evidenced').map(([id]) => id)

  const listed = new Set<string>()
  for (const id of input.listed) {
    if (listed.has(id)) cause('listed_twice', `${id} appears on the owed list more than once`)
    listed.add(id)
    const state = states.get(id)
    if (operatorRows.has(id)) {
      cause('listed_operator', `${id} is owed to the Operator on one host project, not listed as owed Engine evidence`)
    } else if (state === undefined) {
      cause('listed_unknown', `${id} is on the owed list but names no row listing the Engine backend`)
    } else if (state.state === 'evidenced') {
      cause('listed_evidenced', `${id} now has Engine evidence in ${state.test}; remove it from the owed list`)
    }
  }
  for (const id of owed) {
    if (listed.has(id)) continue
    const state = states.get(id) as EngineEvidenceState
    if (state.state === 'live-run-owed') {
      cause(
        'live_run_unrecorded',
        `${id} is proved by ${state.test} only when ${state.variable} is set; it leaves the owed list only once its Engine entry records liveProbePullRequest, the pull request carrying the pasted live probe output`
      )
    } else cause('owed_unlisted', `${id} owes Engine evidence and is missing from the owed list`)
  }
  if (input.listed.length > input.ceiling) {
    cause('list_grew', `the owed list holds ${input.listed.length} rows, above its ceiling of ${input.ceiling}`)
  }
  return { pass: causes.length === 0, owed, causes }
}
