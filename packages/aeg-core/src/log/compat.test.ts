import { describe, expect, it } from 'vitest'
import { LogEventSchema } from './schema'

/**
 * Compatibility fixtures (Part 3, O1/O3) — one literal snapshot per event
 * shape shipped before this task, exactly as it would already be sitting in
 * an outbox file or a posted flush comment: `schema: 1`, none of this
 * task's new envelope fields, none of O3's new finding fields. Every one of
 * these must keep re-parsing under the widened `LogEventSchema` — a real
 * event, once recorded, never becomes unreadable because the schema grew.
 */

const meta = {
  schema: 1 as const,
  ts: '2026-08-01T00:00:00.000Z',
  run_id: 'run-historical',
  seq: 0,
  repo: 'atta-labs/vinaya',
  vinaya: '0.24.0',
  doctrine: 'aeg-root@deadbeef',
  host: 'cli' as const,
  machine: 'cafebabe'
}
const subject = { issue: 412, role: 'developer' as const }
const dispatchBase = {
  meta,
  subject,
  kind: 'dispatch' as const,
  payload: {},
  target_role: 'developer' as const,
  model: 'sonnet',
  effect_id: 'e1'
}

describe('pre-task-log-v1 fixtures — dispatch family', () => {
  it('dispatched', () => {
    const line = { ...dispatchBase, event: 'dispatched' as const, prompt_hash: 'sha256:abc' }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  const outcomeCases: Array<{ name: string; outcome: Record<string, unknown> }> = [
    { name: 'pr_opened', outcome: { type: 'pr_opened', pr: 42, head: 'sha1' } },
    { name: 'round_pushed', outcome: { type: 'round_pushed', pr: 42, head: 'sha1', comment_id: 7 } },
    {
      name: 'verdict',
      outcome: {
        type: 'verdict',
        verdict: 'APPROVE',
        head: 'sha1',
        comment_id: 7,
        objectives: [{ id: 'O1', met: true }],
        findings: []
      }
    },
    { name: 'escalation', outcome: { type: 'escalation', class: 'strategy', comment_id: 7 } },
    { name: 'brief', outcome: { type: 'brief', comment_id: 7, hash: 'sha256:def' } },
    { name: 'plan', outcome: { type: 'plan', issues: [412, 413] } },
    { name: 'archive', outcome: { type: 'archive', provenance_comment_id: 7 } }
  ]
  for (const { name, outcome } of outcomeCases) {
    it(`outcome_received — ${name}`, () => {
      const line = {
        ...dispatchBase,
        event: 'outcome_received' as const,
        outcome,
        usage: { input: 100, output: 50 }
      }
      expect(LogEventSchema.safeParse(line).success).toBe(true)
    })
  }

  it('outcome_received — null usage', () => {
    const line = {
      ...dispatchBase,
      event: 'outcome_received' as const,
      outcome: { type: 'archive', provenance_comment_id: 7 },
      usage: null
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('dispatch_failed', () => {
    const line = { ...dispatchBase, event: 'dispatch_failed' as const, reason: 'timeout', usage: null }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })
})

const loopBase = { meta, subject, kind: 'dev_review_loop' as const, payload: {}, loop_id: 'loop-1' }

describe('pre-task-log-v1 fixtures — dev_review_loop family', () => {
  it('loop_started', () => {
    const line = {
      ...loopBase,
      event: 'loop_started' as const,
      task: 412,
      policy: { max_rounds: 5, reviewers: ['code-reviewer', 'security'], models: { 'code-reviewer': 'sonnet' } }
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('round_started', () => {
    const line = { ...loopBase, event: 'round_started' as const, round: 1, base_head: 'sha0' }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('gate_result_read', () => {
    const line = { ...loopBase, event: 'gate_result_read' as const, round: 1, head: 'sha1', green: true }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('verdicts_read', () => {
    const line = {
      ...loopBase,
      event: 'verdicts_read' as const,
      round: 1,
      head: 'sha1',
      all_approve: false,
      blockers: 2
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('findings_compared', () => {
    const line = {
      ...loopBase,
      event: 'findings_compared' as const,
      round: 2,
      open: ['F1'],
      resolved: ['F2'],
      new: ['F3'],
      recurring: []
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('stop_condition_met', () => {
    const line = { ...loopBase, event: 'stop_condition_met' as const, round: 3, condition: 'green' as const }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('paused', () => {
    const line = { ...loopBase, event: 'paused' as const, round: 2, reason: 'escalation' as const }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('resumed', () => {
    const line = { ...loopBase, event: 'resumed' as const, round: 2, by: 'principal' as const }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('unpushed_work_resume', () => {
    const line = {
      ...loopBase,
      event: 'unpushed_work_resume' as const,
      round: 2,
      branch: 'task/foo/1',
      detail: 'uncommitted changes found'
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('round_ended', () => {
    const line = {
      ...loopBase,
      event: 'round_ended' as const,
      round: 1,
      base_head: 'sha0',
      head: 'sha1',
      files_changed: 3,
      insertions: 40,
      deletions: 10,
      wall_ms: 12000,
      outcome: 'green' as const
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('journal_finalized', () => {
    const line = {
      ...loopBase,
      event: 'journal_finalized' as const,
      rounds: 3,
      total_wall_ms: 90000,
      time_to_green_ms: 45000,
      files_changed_total: 12,
      final_head: 'sha3',
      result: 'merged_ready' as const
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })
})

const forgeBase = {
  meta,
  subject,
  kind: 'forge_write' as const,
  payload: {},
  op: 'issue.comment' as const,
  target: { issue: 412 }
}

describe('pre-task-log-v1 fixtures — forge_write family', () => {
  it('validated', () => {
    expect(LogEventSchema.safeParse({ ...forgeBase, event: 'validated' as const }).success).toBe(true)
  })

  it('refused', () => {
    const line = { ...forgeBase, event: 'refused' as const, reason: 'gh: rate limited' }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('written', () => {
    const line = { ...forgeBase, event: 'written' as const, comment_ids: ['123'] }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })
})

/**
 * Retention-gap fixtures for the six families this task's own tranche
 * introduced (`gate`, `operation`, `usage`, `role_attempt`, `handoff`,
 * `effect`) — O3. An outbox recorded before these six families existed has
 * no history for them (they didn't exist yet), so "historical
 * compatibility" here means: the MINIMAL shape a real caller emits when it
 * genuinely has nothing more to report (a pre-spawn refusal with no usage
 * receipt, a vendor shape this build doesn't parse inner fields for yet, a
 * finding with no severity metadata) still parses cleanly, and every
 * optional/nullable slot reads back exactly what was sent — `undefined`
 * when the key was never set, `null` when it was set to `null` — NEVER a
 * fabricated default (a coerced `0`, a guessed `'unavailable'`, an injected
 * key that was never in the payload). Every assertion below reads the
 * schema's own parsed output directly; none of it calls a report-rendering
 * function (`renderSummary`, `vinaya pr report`'s engine, or any Studio
 * artifact) — capture completeness is verified against the typed event
 * itself, never against a generated report (Traps to avoid).
 */

describe('retention-gap fixtures — usage family (O3): unknown usage is null, never coerced to zero', () => {
  it('a usage line with every unit genuinely unknown parses, and none of the three units silently become 0', () => {
    const line = {
      meta,
      subject,
      kind: 'usage' as const,
      event: 'observed' as const,
      payload: {},
      model: null,
      source: 'gemini',
      semantics: 'cumulative' as const,
      units: { input: null, output: null, cache: null },
      unknown_reason: 'gemini usage shape not yet read for inner fields'
    }
    const result = LogEventSchema.safeParse(line)
    expect(result.success).toBe(true)
    if (result.success && result.data.kind === 'usage') {
      expect(result.data.units).toEqual({ input: null, output: null, cache: null })
      expect(result.data.unknown_reason).toBe('gemini usage shape not yet read for inner fields')
    }
  })
})

describe('retention-gap fixtures — role_attempt family (O3): a pre-spawn refusal has no usage receipt to fabricate', () => {
  it('a capability-refused attempt with null usage and a null model parses, neither field defaulted', () => {
    const line = {
      meta,
      subject,
      kind: 'role_attempt' as const,
      event: 'attempted' as const,
      payload: {},
      actor: 'claude',
      attempt: 1,
      effect_id: 'e1',
      // No model receipt was ever given — the vendor never spawned.
      model: null,
      outcome: 'capability_refused' as const,
      usage: null
    }
    const result = LogEventSchema.safeParse(line)
    expect(result.success).toBe(true)
    if (result.success && result.data.kind === 'role_attempt') {
      expect(result.data.model).toBeNull()
      expect(result.data.usage).toBeNull()
    }
  })
})

describe('retention-gap fixtures — verdict findings (O3): absent severity metadata is absent, not defaulted', () => {
  it('a finding carrying only id/severity has no severity_scale/policy_treatment/confidence key at all — not undefined-but-present, genuinely absent', () => {
    const line = {
      ...dispatchBase,
      event: 'outcome_received' as const,
      outcome: {
        type: 'verdict',
        verdict: 'REQUEST CHANGES',
        head: 'sha1',
        comment_id: 7,
        objectives: [{ id: 'O1', met: false }],
        findings: [{ id: 'F1', severity: 'BLOCKER' }]
      },
      usage: null
    }
    const result = LogEventSchema.safeParse(line)
    expect(result.success).toBe(true)
    if (result.success && result.data.kind === 'dispatch' && result.data.event === 'outcome_received') {
      const outcome = result.data.outcome
      if (outcome.type === 'verdict') {
        const finding = outcome.findings[0] as Record<string, unknown>
        expect(Object.hasOwn(finding, 'severity_scale')).toBe(false)
        expect(Object.hasOwn(finding, 'policy_treatment')).toBe(false)
        expect(Object.hasOwn(finding, 'confidence')).toBe(false)
        expect(Object.hasOwn(finding, 'confidence_scale')).toBe(false)
        expect(Object.hasOwn(finding, 'confidence_source')).toBe(false)
      }
    }
  })

  it('a finding that genuinely could not determine policy treatment declares policy_treatment: "unavailable" rather than guessing blocking/non_blocking', () => {
    const line = {
      ...dispatchBase,
      event: 'outcome_received' as const,
      outcome: {
        type: 'verdict',
        verdict: 'REQUEST CHANGES',
        head: 'sha1',
        comment_id: 7,
        objectives: [{ id: 'O1', met: false }],
        findings: [{ id: 'F1', severity: 'MAJOR', policy_treatment: 'unavailable' }]
      },
      usage: null
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })
})

describe('retention-gap fixtures — gate/operation/handoff/effect (O3): the minimal shape each family accepts', () => {
  const gateBase = {
    meta,
    subject: { issue: 412, role: 'unattributed' as const },
    kind: 'gate' as const,
    payload: {},
    check: 'typecheck',
    check_version: null,
    policy_version: null,
    input_fingerprint: null
  }

  it('a gate check with no policy_version and no input_fingerprint (no per-check policy-version concept exists yet) parses honestly null, not fabricated', () => {
    const line = { ...gateBase, event: 'checked' as const, outcome: 'pass' as const }
    const result = LogEventSchema.safeParse(line)
    expect(result.success).toBe(true)
    if (result.success && result.data.kind === 'gate') {
      expect(result.data.policy_version).toBeNull()
      expect(result.data.input_fingerprint).toBeNull()
      expect(Object.hasOwn(result.data, 'reason')).toBe(false)
    }
  })

  it('an operation with a null target and a null error_class (a check with nothing further to report) parses', () => {
    const line = {
      meta,
      subject,
      kind: 'operation' as const,
      event: 'completed' as const,
      payload: {},
      operation: 'authenticate-invocation',
      target: null,
      result: 'ok' as const,
      error_class: null
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('a handoff raised with no requested_decision, and its later resolved twin with no resolution/resolved_by, both parse', () => {
    const handoffShared = {
      meta,
      subject,
      kind: 'handoff' as const,
      payload: {},
      class: 'strategy' as const,
      reason: 'the brief assumes an approach the codebase no longer takes'
    }
    expect(
      LogEventSchema.safeParse({ ...handoffShared, event: 'raised' as const, requested_decision: null }).success
    ).toBe(true)
    expect(
      LogEventSchema.safeParse({ ...handoffShared, event: 'resolved' as const, resolution: null, resolved_by: null })
        .success
    ).toBe(true)
  })

  it('an effect observed as "uncertain" (a reconciliation that came back ambiguous) parses — never silently treated as success', () => {
    const line = {
      meta,
      subject,
      kind: 'effect' as const,
      event: 'observed' as const,
      payload: {},
      effect_id: 'eff-1',
      target: { kind: 'pr_comment', ref: 'pr-42' },
      outcome: 'uncertain' as const
    }
    const result = LogEventSchema.safeParse(line)
    expect(result.success).toBe(true)
    if (result.success && result.data.kind === 'effect' && result.data.event === 'observed') {
      expect(result.data.outcome).toBe('uncertain')
    }
  })
})

describe('pre-task-log-v1 fixtures — verdict findings, the pre-O3 minimal shape', () => {
  it('a finding with only id/severity, no state — the oldest recorded shape', () => {
    const line = {
      ...dispatchBase,
      event: 'outcome_received' as const,
      outcome: {
        type: 'verdict',
        verdict: 'REQUEST CHANGES',
        head: 'sha1',
        comment_id: 7,
        objectives: [{ id: 'O1', met: false }],
        findings: [{ id: 'F1', severity: 'BLOCKER' }]
      },
      usage: null
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('a finding with id/severity/state — the shape after state tracking landed', () => {
    const line = {
      ...dispatchBase,
      event: 'outcome_received' as const,
      outcome: {
        type: 'verdict',
        verdict: 'APPROVE',
        head: 'sha2',
        comment_id: 8,
        objectives: [{ id: 'O1', met: true }],
        findings: [{ id: 'F1', severity: 'MINOR', state: 'resolved' }]
      },
      usage: { input: 10, output: 5 }
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })
})
