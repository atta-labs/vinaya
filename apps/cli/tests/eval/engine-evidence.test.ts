// The registry's Engine evidence is honest and shrink-only. Every
// fault-and-attack and cutover-gate row carries an evidence entry for each
// backend it lists; an entry naming a test file is accepted only when that
// file exists in the repository and contains the row's full id. The owed list,
// `engine-evidence-owed.json`, holds exactly the rows still owing Engine
// proof: an owed row missing from it fails, a listed row that now has its
// proof fails until it is removed, and the list never grows past its ceiling.
// A row proved by a live-gated test stays listed until its entry records the
// pull request carrying the pasted live probe output.
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checkOwedEngineEvidence,
  engineEvidenceOf,
  type OwedListCauseCode,
  type OwedListInput,
  OPERATOR_EXIT_EXCLUSIONS
} from '../../src/lib/dev-review-eval/exit-check'
import {
  type EvidenceFiles,
  loadRegistry,
  namesRowId,
  type RegistryResult,
  validateComponentRow
} from '../../src/lib/dev-review-eval/registry'

const REGISTRY_DIR = join(import.meta.dir, 'registry')
const OWED_FILE = join(import.meta.dir, 'engine-evidence-owed.json')
/** The most rows the owed list may hold. Lower it as rows gain their proof; never raise it. */
const OWED_CEILING = 42
const GATE_16_PROOF = 'apps/cli/tests/conformance/packed-runtime-public-run-control.test.ts'
const LIVE_VARIABLE = 'VINAYA_SANDBOX_CONFORMANCE'

const loaded = loadRegistry(join(REGISTRY_DIR, 'modules.json'), join(REGISTRY_DIR, 'shards'))
if (!loaded.ok) throw new Error(`registry refused: ${JSON.stringify(loaded.refusal)}`)
const registry = loaded.value
const owedList = JSON.parse(readFileSync(OWED_FILE, 'utf8')) as { schemaVersion: number; owed: string[] }

type RawRow = Record<string, unknown> & { id: string; backendEvidence: Record<string, unknown> }
const rawRows = (shard: string): RawRow[] =>
  (JSON.parse(readFileSync(join(REGISTRY_DIR, 'shards', `${shard}.json`), 'utf8')) as { components: RawRow[] })
    .components
const rawGate = (n: number): RawRow =>
  structuredClone(rawRows('cutover-gates').find((row) => row.id === `cutover-gate:gate-${n}`) as RawRow)

const validate = (row: unknown, files?: EvidenceFiles) =>
  validateComponentRow(row, registry.catalog, 'shards/cutover-gates.json#components[0]', files)
const refusal = <T>(result: RegistryResult<T>) => {
  if (result.ok) throw new Error('expected a refusal')
  return result.refusal
}

const input = (overrides: Partial<OwedListInput> = {}): OwedListInput => ({
  components: structuredClone(registry.components),
  listed: [...owedList.owed],
  ceiling: OWED_CEILING,
  ...overrides
})
const causesOf = (value: OwedListInput): OwedListCauseCode[] => checkOwedEngineEvidence(value).causes.map((c) => c.code)

/** Marks a row's Engine entry live-gated: proved by a test that runs only when the live variable is set. */
function liveGated(value: OwedListInput, id: string, liveProbePullRequest?: number): OwedListInput {
  for (const { row } of value.components) {
    if (row.id !== id) continue
    row.backendEvidence = {
      ...row.backendEvidence,
      engine: {
        test: 'apps/cli/tests/sandbox-conformance/sandbox-conformance.test.ts',
        liveGated:
          liveProbePullRequest === undefined
            ? { variable: LIVE_VARIABLE }
            : { variable: LIVE_VARIABLE, liveProbePullRequest }
      }
    }
  }
  return value
}

describe('the owed Engine evidence list', () => {
  it('holds exactly the rows owing Engine proof, at its ceiling, and prints the owed count', () => {
    const report = checkOwedEngineEvidence(input())
    const byKind = (prefix: string) => owedList.owed.filter((id) => id.startsWith(prefix)).length
    console.log(
      `owed Engine evidence: ${owedList.owed.length} rows (cutover-gate ${byKind('cutover-gate:')}, fault-attack ${byKind('fault-attack:')}); ceiling ${OWED_CEILING}`
    )
    expect(report.causes).toEqual([])
    expect(report.pass).toBe(true)
    expect([...owedList.owed].sort()).toEqual([...report.owed].sort())
    expect(owedList.schemaVersion).toBe(1)
    // At the ceiling: a row that leaves the list lowers the ceiling in the same change.
    expect(owedList.owed.length).toBe(OWED_CEILING)
  })

  it('lists no row owed to the Operator on one host project', () => {
    const operatorRows = new Set(OPERATOR_EXIT_EXCLUSIONS.map((entry) => `${entry.kind}:${entry.name}`))
    expect(owedList.owed.filter((id) => operatorRows.has(id))).toEqual([])
    expect(causesOf(input({ listed: [...owedList.owed.slice(1), 'cutover-gate:gate-11'] }))).toEqual([
      'listed_operator',
      'owed_unlisted'
    ])
  })

  it('fails when an owed row is missing from the list', () => {
    const [dropped, ...rest] = owedList.owed
    const report = checkOwedEngineEvidence(input({ listed: rest }))
    expect(report.causes.map((c) => c.code)).toEqual(['owed_unlisted'])
    expect(report.causes[0]?.detail).toContain(dropped as string)
  })

  it('fails when a listed row now has its Engine evidence, until it is removed', () => {
    const value = input()
    const target = owedList.owed[0] as string
    const row = value.components.find((entry) => entry.row.id === target)?.row
    if (row === undefined) throw new Error(`${target} has no row`)
    row.backendEvidence = { ...row.backendEvidence, engine: { test: GATE_16_PROOF } }
    const report = checkOwedEngineEvidence(value)
    expect(report.causes.map((c) => c.code)).toEqual(['listed_evidenced'])
    expect(report.causes[0]?.detail).toContain(target)
    value.listed = value.listed.filter((id) => id !== target)
    expect(checkOwedEngineEvidence(value).pass).toBe(true)
  })

  it('cannot gain a row: an evidenced, unknown or repeated row, or one past the ceiling, fails', () => {
    expect(causesOf(input({ listed: [...owedList.owed, 'cutover-gate:gate-16'] }))).toEqual([
      'listed_evidenced',
      'list_grew'
    ])
    expect(causesOf(input({ listed: [...owedList.owed, 'fault-attack:97-planted-row'] }))).toEqual([
      'listed_unknown',
      'list_grew'
    ])
    expect(causesOf(input({ listed: [...owedList.owed, owedList.owed[0] as string] }))).toEqual([
      'listed_twice',
      'list_grew'
    ])
    expect(causesOf(input({ ceiling: OWED_CEILING - 1 }))).toEqual(['list_grew'])
  })
})

describe('a live-gated row leaves the owed list only with its live run recorded', () => {
  const target = 'cutover-gate:gate-3'

  it('keeps a live-gated row owed while no live run is recorded', () => {
    const value = liveGated(input(), target)
    const row = value.components.find((entry) => entry.row.id === target)?.row
    expect(row === undefined ? undefined : engineEvidenceOf(row)?.state).toBe('live-run-owed')
    expect(checkOwedEngineEvidence(value).pass).toBe(true)
  })

  it('refuses removing a live-gated row whose entry records no pull request with the live probe output', () => {
    const value = liveGated(input({ listed: owedList.owed.filter((id) => id !== target) }), target)
    const report = checkOwedEngineEvidence(value)
    expect(report.causes.map((c) => c.code)).toEqual(['live_run_unrecorded'])
    expect(report.causes[0]?.detail).toContain(target)
    expect(report.causes[0]?.detail).toContain(LIVE_VARIABLE)
  })

  it('accepts the removal once the entry records that pull request, and then refuses keeping it listed', () => {
    const removed = liveGated(input({ listed: owedList.owed.filter((id) => id !== target) }), target, 4242)
    expect(checkOwedEngineEvidence(removed).causes).toEqual([])
    expect(causesOf(liveGated(input(), target, 4242))).toEqual(['listed_evidenced'])
  })
})

describe('an evidence entry naming a test file', () => {
  it('is accepted when the file exists in the repository and contains the row’s full id', () => {
    const result = validate(rawGate(16))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.backendEvidence).toEqual({ engine: { test: GATE_16_PROOF } })
    expect(readFileSync(join(import.meta.dir, '../../../..', GATE_16_PROOF), 'utf8')).toContain('cutover-gate:gate-16')
  })

  it('is refused when the file does not exist, naming the row id and the file', () => {
    const row = rawGate(16)
    row.backendEvidence = { engine: { test: 'apps/cli/tests/eval/no-such-proof.test.ts' } }
    const refused = refusal(validate(row))
    expect(refused.code).toBe('evidence_file_missing')
    expect(refused.path).toBe('shards/cutover-gates.json#components[0].backendEvidence.engine.test')
    expect(refused.detail).toContain('cutover-gate:gate-16')
    expect(refused.detail).toContain('apps/cli/tests/eval/no-such-proof.test.ts')
  })

  it('is refused when the file does not contain the row’s full id, naming the row id and the file', () => {
    const row = rawGate(16)
    row.backendEvidence = { engine: { test: 'apps/cli/tests/eval/registry.test.ts' } }
    const refused = refusal(validate(row))
    expect(refused.code).toBe('evidence_id_absent')
    expect(refused.detail).toContain('cutover-gate:gate-16')
    expect(refused.detail).toContain('apps/cli/tests/eval/registry.test.ts')
  })

  it('is refused when the file names only the short name, or a longer id the full id begins', () => {
    const files: EvidenceFiles = (path) =>
      path === 'proof.test.ts'
        ? "it('gate-1 holds', () => {})\nit('cutover-gate:gate-16 holds', () => {})\n"
        : undefined
    const row = rawGate(1)
    row.backendEvidence = { engine: { test: 'proof.test.ts' } }
    expect(refusal(validate(row, files)).code).toBe('evidence_id_absent')
    expect(namesRowId('cutover-gate:gate-16 holds', 'cutover-gate:gate-1')).toBe(false)
    expect(namesRowId("it('cutover-gate:gate-1 — holds'", 'cutover-gate:gate-1')).toBe(true)
    expect(namesRowId('gate-1', 'cutover-gate:gate-1')).toBe(false)
  })

  it('is refused when its path leaves the repository root', () => {
    for (const test of ['../outside.test.ts', '/abs/proof.test.ts', 'apps/../proof.test.ts']) {
      const row = rawGate(16)
      row.backendEvidence = { engine: { test } }
      expect({ test, code: refusal(validate(row)).code }).toEqual({ test, code: 'bad_name' })
    }
  })

  it('records a live gate by its variable, and the pull request once the live run is recorded', () => {
    const files: EvidenceFiles = (path) => (path === 'live.test.ts' ? 'cutover-gate:gate-16' : undefined)
    const row = rawGate(16)
    row.backendEvidence = { engine: { test: 'live.test.ts', liveGated: { variable: LIVE_VARIABLE } } }
    const result = validate(row, files)
    expect(result.ok && result.value.backendEvidence?.engine).toEqual({
      test: 'live.test.ts',
      liveGated: { variable: LIVE_VARIABLE }
    })
    row.backendEvidence = {
      engine: { test: 'live.test.ts', liveGated: { variable: LIVE_VARIABLE, liveProbePullRequest: 4242 } }
    }
    expect(validate(row, files).ok).toBe(true)
    row.backendEvidence = { engine: { test: 'live.test.ts', liveGated: { variable: 'sandbox-switch' } } }
    expect(refusal(validate(row, files)).code).toBe('bad_name')
    row.backendEvidence = {
      engine: { test: 'live.test.ts', liveGated: { variable: LIVE_VARIABLE, liveProbePullRequest: 0 } }
    }
    expect(refusal(validate(row, files)).code).toBe('out_of_range')
  })
})

describe('an owed evidence entry', () => {
  it('gives its reason on one line, and never also names a test', () => {
    const row = rawGate(2)
    row.backendEvidence = { standalone: { owed: 'No proof yet.' }, engine: { owed: 'No proof yet.\nStill none.' } }
    expect(refusal(validate(row)).code).toBe('wrong_type')
    row.backendEvidence = { standalone: { owed: 'No proof yet.' }, engine: { owed: 'TBD' } }
    expect(refusal(validate(row)).code).toBe('placeholder')
    row.backendEvidence = {
      standalone: { owed: 'No proof yet.' },
      engine: { owed: 'No proof yet.', test: GATE_16_PROOF }
    }
    expect(refusal(validate(row)).code).toBe('wrong_type')
    row.backendEvidence = { standalone: { owed: 'No proof yet.' }, engine: {} }
    expect(refusal(validate(row)).code).toBe('missing_field')
  })

  it('is carried only by a fault-and-attack or cutover-gate row', () => {
    const node = structuredClone(rawRows('typed-sources')[0] as RawRow)
    expect(validateComponentRow(node, registry.catalog).ok).toBe(true)
    node.backendEvidence = { engine: { owed: 'No proof yet.' } }
    const refused = refusal(validateComponentRow(node, registry.catalog))
    expect([refused.code, refused.path]).toEqual(['unknown_value', 'backendEvidence'])
  })
})
