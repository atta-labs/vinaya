import { describe, expect, it } from 'vitest'
import { TASK_LOG_ARTIFACT_MAX_BYTES, validateTaskLogArtifact } from './artifact'

const HOME = '/Users/dev'
const EXPECTED = { repo: 'atta-labs/vinaya' }

/** A valid `schema: 2` header with the given identity fields, declaring `repo`. */
function metaV2(
  runId: string,
  seq: number,
  eventId: string,
  repo: string | null = 'atta-labs/vinaya'
): Record<string, unknown> {
  return {
    schema: 2,
    ts: '2026-09-15T00:00:00.000Z',
    run_id: runId,
    seq,
    repo,
    vinaya: '0.29.0',
    doctrine: 'aeg-root@deadbeef',
    host: 'ci',
    machine: 'cafebabe',
    event_id: eventId,
    process_id: 'proc-1',
    actor_id: 'developer',
    lineage: { run: null, attempt: null, parent: null },
    input_versions: { objectives_version: null, brief_hash: null, ruling_ordinal: null, policy_digest: null },
    provenance: 'env_correlated'
  }
}

function gateChecked(meta: Record<string, unknown>): Record<string, unknown> {
  return {
    meta,
    subject: { issue: 564, role: 'developer' },
    kind: 'gate',
    event: 'checked',
    payload: {},
    check: 'typecheck',
    check_version: null,
    policy_version: null,
    input_fingerprint: null,
    outcome: 'pass'
  }
}

function line(obj: unknown): string {
  return JSON.stringify(obj)
}

describe('validateTaskLogArtifact — O1 schema/size/redaction, O2 never executes', () => {
  it('accepts every well-formed, correctly-provenanced line', () => {
    const raw = [line(gateChecked(metaV2('run-1', 0, 'e-0'))), line(gateChecked(metaV2('run-1', 1, 'e-1')))].join('\n')
    const result = validateTaskLogArtifact(raw, HOME, EXPECTED)
    expect(result.rejectedForSize).toBe(false)
    expect(result.gaps).toEqual([])
    expect(result.acceptedLines).toHaveLength(2)
  })

  it('rejects the whole artifact above the size cap without parsing a single line (defense against a decompression-cost attack)', () => {
    const raw = `${'x'.repeat(TASK_LOG_ARTIFACT_MAX_BYTES + 1)}`
    const result = validateTaskLogArtifact(raw, HOME, EXPECTED)
    expect(result.rejectedForSize).toBe(true)
    expect(result.acceptedLines).toEqual([])
    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]?.reason).toContain('exceeding')
  })

  it('a line that is not valid JSON becomes a named gap, never a thrown error, never executed', () => {
    const raw = [
      'function() { require("child_process").execSync("rm -rf /") }',
      line(gateChecked(metaV2('run-1', 0, 'e-0')))
    ].join('\n')
    const result = validateTaskLogArtifact(raw, HOME, EXPECTED)
    expect(result.acceptedLines).toHaveLength(1)
    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]?.reason).toContain('invalid record')
  })

  it('a line failing schema validation (missing required field) becomes a gap, not a publish', () => {
    const malformed = { meta: metaV2('run-1', 0, 'e-0'), subject: { issue: 564, role: 'developer' }, kind: 'gate' }
    const raw = line(malformed)
    const result = validateTaskLogArtifact(raw, HOME, EXPECTED)
    expect(result.acceptedLines).toEqual([])
    expect(result.gaps).toHaveLength(1)
  })

  it('a line declaring a different repo than expected is refused as a provenance mismatch, never silently attributed here', () => {
    const raw = line(gateChecked(metaV2('run-1', 0, 'e-0', 'someone-else/fork')))
    const result = validateTaskLogArtifact(raw, HOME, EXPECTED)
    expect(result.acceptedLines).toEqual([])
    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]?.reason).toContain('provenance mismatch')
  })

  it('a line with no declared repo (repo: null) is accepted on content — the run-id-scoped download is the real provenance guarantee, this is only a defense-in-depth cross-check', () => {
    const raw = line(gateChecked(metaV2('run-1', 0, 'e-0', null)))
    const result = validateTaskLogArtifact(raw, HOME, EXPECTED)
    expect(result.acceptedLines).toHaveLength(1)
    expect(result.gaps).toEqual([])
  })

  it('an unknown schema version is kept as a gap for diagnosis, never accepted and never crashes validation', () => {
    const raw = line({ meta: { schema: 99, run_id: 'run-1', seq: 0, repo: 'atta-labs/vinaya' } })
    const result = validateTaskLogArtifact(raw, HOME, EXPECTED)
    expect(result.acceptedLines).toEqual([])
    expect(result.gaps).toHaveLength(1)
    expect(result.gaps[0]?.reason).toContain('unknown schema version')
  })

  it('a redacted secret pattern in a free-text field is re-redacted, never posted verbatim (same transport-boundary guarantee flush already gives a local line)', () => {
    const withSecret = {
      meta: metaV2('run-1', 0, 'e-0'),
      subject: { issue: 564, role: 'developer' },
      kind: 'gate',
      event: 'checked',
      payload: {},
      check: 'typecheck',
      check_version: null,
      policy_version: null,
      input_fingerprint: null,
      outcome: 'fail',
      reason: 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKL'
    }
    const result = validateTaskLogArtifact(line(withSecret), HOME, EXPECTED)
    expect(result.acceptedLines).toHaveLength(1)
    expect(result.acceptedLines[0]).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKL')
  })

  it('a mixed batch reports every gap by reason while still accepting the valid lines — a partial artifact never becomes an all-or-nothing failure', () => {
    const raw = [
      'not json at all',
      line(gateChecked(metaV2('run-1', 0, 'e-0'))),
      line(gateChecked(metaV2('run-1', 1, 'e-1', 'fork/repo'))),
      line(gateChecked(metaV2('run-1', 2, 'e-2')))
    ].join('\n')
    const result = validateTaskLogArtifact(raw, HOME, EXPECTED)
    expect(result.acceptedLines).toHaveLength(2)
    expect(result.gaps).toHaveLength(2)
  })
})
