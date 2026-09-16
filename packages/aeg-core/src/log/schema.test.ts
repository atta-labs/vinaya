import { describe, expect, it } from 'vitest'
import { LogEventSchema } from './schema'

const meta = {
  schema: 1 as const,
  ts: '2026-09-05T00:00:00.000Z',
  run_id: 'run-1',
  seq: 0,
  repo: 'atta-labs/vinaya',
  vinaya: '0.24.1',
  doctrine: 'aeg-root@abc123',
  host: 'cli' as const,
  machine: 'deadbeef'
}
const subject = { issue: 412, role: 'developer' as const }

const validDispatched = {
  meta,
  subject,
  kind: 'dispatch' as const,
  event: 'dispatched' as const,
  payload: {},
  target_role: 'developer' as const,
  model: 'sonnet',
  effect_id: 'e1',
  prompt_hash: 'sha256:abc'
}

const validLoopEvent = {
  meta,
  subject,
  kind: 'dev_review_loop' as const,
  event: 'round_started' as const,
  payload: {},
  loop_id: 'loop-1',
  round: 1,
  base_head: 'sha1'
}

describe('LogEventSchema — dispatch family', () => {
  it('parses a valid dispatched line', () => {
    expect(LogEventSchema.safeParse(validDispatched).success).toBe(true)
  })

  it('parses a valid outcome_received line with a typed DispatchOutcome', () => {
    const line = {
      ...validDispatched,
      event: 'outcome_received' as const,
      prompt_hash: undefined,
      outcome: { type: 'pr_opened', pr: 42, head: 'sha1' },
      usage: { input: 100, output: 50 }
    }
    delete (line as Record<string, unknown>).prompt_hash
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('parses outcome_received with null usage', () => {
    const line = {
      meta,
      subject,
      kind: 'dispatch' as const,
      event: 'outcome_received' as const,
      payload: {},
      target_role: 'developer' as const,
      model: 'sonnet',
      effect_id: 'e1',
      outcome: { type: 'archive', provenance_comment_id: 7 },
      usage: null
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('parses a valid dispatch_failed line', () => {
    const line = {
      meta,
      subject,
      kind: 'dispatch' as const,
      event: 'dispatch_failed' as const,
      payload: {},
      target_role: 'developer' as const,
      model: 'sonnet',
      effect_id: 'e1',
      reason: 'timeout' as const,
      usage: null
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('parses a dispatch_failed line with real usage — O10, a killed run still has figures', () => {
    const line = {
      meta,
      subject,
      kind: 'dispatch' as const,
      event: 'dispatch_failed' as const,
      payload: {},
      target_role: 'developer' as const,
      model: 'sonnet',
      effect_id: 'e1',
      reason: 'timeout' as const,
      usage: { input: 184327, output: 22190 }
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })
})

describe('LogEventSchema — dev_review_loop family', () => {
  it('parses a valid round_started line', () => {
    expect(LogEventSchema.safeParse(validLoopEvent).success).toBe(true)
  })

  it('parses a valid journal_finalized line with a nullable time_to_green_ms', () => {
    const line = {
      meta,
      subject,
      kind: 'dev_review_loop' as const,
      event: 'journal_finalized' as const,
      payload: {},
      loop_id: 'loop-1',
      rounds: 2,
      total_wall_ms: 1000,
      time_to_green_ms: null,
      files_changed_total: 10,
      final_head: 'sha2',
      result: 'merged_ready' as const
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('parses a resumed line authenticated by a principal ruling', () => {
    const line = {
      meta,
      subject,
      kind: 'dev_review_loop' as const,
      event: 'resumed' as const,
      payload: {},
      loop_id: 'loop-1',
      round: 3,
      by: 'principal' as const
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it("parses a resumed line for a bare 'infrastructure' recoverable-hiccup resume (task-log-v1 task 6, O2 — never claimed 'principal' with no ruling read)", () => {
    const line = {
      meta,
      subject,
      kind: 'dev_review_loop' as const,
      event: 'resumed' as const,
      payload: {},
      loop_id: 'loop-1',
      round: 3,
      by: 'driver' as const
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('parses a cancelled line (task-log-v1 task 6, O2)', () => {
    const line = {
      meta,
      subject,
      kind: 'dev_review_loop' as const,
      event: 'cancelled' as const,
      payload: {},
      loop_id: 'loop-1',
      round: 3,
      by: 'principal' as const
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it("refuses a cancelled line claiming by: 'driver' — a cancel always requires an authenticated principal ruling", () => {
    const line = {
      meta,
      subject,
      kind: 'dev_review_loop' as const,
      event: 'cancelled' as const,
      payload: {},
      loop_id: 'loop-1',
      round: 3,
      by: 'driver' as const
    }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })
})

const validForgeWrite = {
  meta,
  subject,
  kind: 'forge_write' as const,
  event: 'validated' as const,
  payload: {},
  op: 'issue.comment' as const,
  target: { issue: 412 }
}

describe('LogEventSchema — forge_write family', () => {
  it('parses a valid validated line', () => {
    expect(LogEventSchema.safeParse(validForgeWrite).success).toBe(true)
  })

  it('parses a valid refused line with a reason', () => {
    const line = { ...validForgeWrite, event: 'refused' as const, reason: 'gh: rate limited' }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('parses a valid written line with comment_ids', () => {
    const line = { ...validForgeWrite, event: 'written' as const, comment_ids: ['123456'] }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('refuses a written line missing comment_ids', () => {
    const line = { ...validForgeWrite, event: 'written' as const }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })

  it('refuses a refused line missing reason', () => {
    const line = { ...validForgeWrite, event: 'refused' as const }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })

  it('parses a target naming a pr instead of an issue', () => {
    const line = { ...validForgeWrite, op: 'pr.comment' as const, target: { pr: 42 } }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('refuses an op outside the ForgeOp enum', () => {
    const line = { ...validForgeWrite, op: 'pr.delete' }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })
})

const metaV2 = {
  ...meta,
  schema: 2 as const,
  event_id: 'event-1',
  process_id: 'process-1',
  actor_id: 'developer',
  lineage: { run: null, attempt: null, parent: null },
  input_versions: { objectives_version: null, brief_hash: null, ruling_ordinal: null, policy_digest: null },
  provenance: 'env_correlated' as const
}

describe('LogEventSchema — schema: 2 envelope (O1)', () => {
  it('parses a dispatch event with a schema: 2 header — every existing family accepts the new envelope', () => {
    expect(LogEventSchema.safeParse({ ...validDispatched, meta: metaV2 }).success).toBe(true)
  })

  it('refuses a schema: 2 header missing a new required field', () => {
    const { event_id: _drop, ...incomplete } = metaV2
    expect(LogEventSchema.safeParse({ ...validDispatched, meta: incomplete }).success).toBe(false)
  })

  it('refuses lineage carrying an extra key — .strict() reaches nested objects too', () => {
    const line = { ...validDispatched, meta: { ...metaV2, lineage: { ...metaV2.lineage, sneaky: 1 } } }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })

  it('refuses provenance outside its enum', () => {
    const line = { ...validDispatched, meta: { ...metaV2, provenance: 'trust-me' } }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })

  it('accepts lineage.attempt as a number and as null', () => {
    const withAttempt = { ...validDispatched, meta: { ...metaV2, lineage: { run: 'run-9', attempt: 3, parent: 'e0' } } }
    expect(LogEventSchema.safeParse(withAttempt).success).toBe(true)
  })
})

const gateEvent = {
  meta,
  subject,
  kind: 'gate' as const,
  event: 'checked' as const,
  payload: {},
  check: 'typecheck',
  check_version: '1',
  policy_version: null,
  input_fingerprint: 'sha256:abc',
  outcome: 'pass' as const
}

describe('LogEventSchema — gate family (O2)', () => {
  it('parses a passing check', () => {
    expect(LogEventSchema.safeParse(gateEvent).success).toBe(true)
  })

  it('parses a failing check with a reason', () => {
    const line = { ...gateEvent, outcome: 'fail' as const, reason: 'typecheck: 3 errors' }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('parses unavailable_dependency and timeout outcomes', () => {
    expect(LogEventSchema.safeParse({ ...gateEvent, outcome: 'unavailable_dependency' }).success).toBe(true)
    expect(LogEventSchema.safeParse({ ...gateEvent, outcome: 'timeout' }).success).toBe(true)
  })

  it('refuses an outcome outside the enum — no invented pass/fail when the real value is unknown', () => {
    expect(LogEventSchema.safeParse({ ...gateEvent, outcome: 'ok' }).success).toBe(false)
  })
})

const operationEvent = {
  meta,
  subject,
  kind: 'operation' as const,
  event: 'completed' as const,
  payload: {},
  operation: 'gh pr create',
  target: null,
  result: 'ok' as const,
  error_class: null
}

describe('LogEventSchema — operation family (O2)', () => {
  it('parses a completed operation', () => {
    expect(LogEventSchema.safeParse(operationEvent).success).toBe(true)
  })

  it('parses a refused operation with an error_class', () => {
    const line = { ...operationEvent, result: 'refused' as const, error_class: 'validation' }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('refuses a result outside the enum', () => {
    expect(LogEventSchema.safeParse({ ...operationEvent, result: 'success' }).success).toBe(false)
  })
})

const usageEvent = {
  meta,
  subject,
  kind: 'usage' as const,
  event: 'observed' as const,
  payload: {},
  model: 'sonnet',
  source: 'claude-code',
  semantics: 'cumulative' as const,
  units: { input: 100, output: 50, cache: null },
  unknown_reason: null
}

describe('LogEventSchema — usage family (O2)', () => {
  it('parses an observed usage line', () => {
    expect(LogEventSchema.safeParse(usageEvent).success).toBe(true)
  })

  it('accepts every unit as null — unknown usage is never coerced to zero', () => {
    const line = {
      ...usageEvent,
      units: { input: null, output: null, cache: null },
      unknown_reason: 'host has no usage API'
    }
    const parsed = LogEventSchema.safeParse(line)
    expect(parsed.success).toBe(true)
    if (parsed.success && parsed.data.kind === 'usage') {
      expect(parsed.data.units.input).toBeNull()
    }
  })

  it('refuses a negative unit', () => {
    expect(LogEventSchema.safeParse({ ...usageEvent, units: { ...usageEvent.units, input: -1 } }).success).toBe(false)
  })

  it('refuses semantics outside cumulative/delta', () => {
    expect(LogEventSchema.safeParse({ ...usageEvent, semantics: 'total' }).success).toBe(false)
  })
})

const roleAttemptEvent = {
  meta,
  subject,
  kind: 'role_attempt' as const,
  event: 'attempted' as const,
  payload: {},
  actor: 'ci-gate',
  attempt: 1,
  // Evidence identity + runtime receipt, added alongside actor/attempt.
  effect_id: 'effect-1',
  model: 'claude-opus-5',
  outcome: 'completed' as const,
  usage: { input: 100, output: 50 }
}

describe('LogEventSchema — role_attempt family (O2)', () => {
  it('parses a completed attempt', () => {
    expect(LogEventSchema.safeParse(roleAttemptEvent).success).toBe(true)
  })

  it('accepts an opaque actor outside the closed Role union — the title this task is named for', () => {
    expect(LogEventSchema.safeParse({ ...roleAttemptEvent, actor: 'some-future-role-nobody-registered' }).success).toBe(
      true
    )
  })

  it('parses every normalized outcome', () => {
    for (const outcome of ['incomplete', 'infrastructure_failed', 'cancelled', 'timed_out', 'capability_refused']) {
      expect(LogEventSchema.safeParse({ ...roleAttemptEvent, outcome }).success).toBe(true)
    }
  })

  it('parses null usage — no fabricated process success, and no fabricated usage either', () => {
    expect(LogEventSchema.safeParse({ ...roleAttemptEvent, usage: null }).success).toBe(true)
  })

  it('accepts a null model — a pre-spawn refusal has no receipt to give', () => {
    expect(LogEventSchema.safeParse({ ...roleAttemptEvent, model: null }).success).toBe(true)
  })

  it('refuses a missing effect_id — the evidence identity that joins this line to its dispatch lines', () => {
    const { effect_id: _effectId, ...withoutEffectId } = roleAttemptEvent
    expect(LogEventSchema.safeParse(withoutEffectId).success).toBe(false)
  })

  it('refuses an outcome outside the enum', () => {
    expect(LogEventSchema.safeParse({ ...roleAttemptEvent, outcome: 'succeeded' }).success).toBe(false)
  })
})

const handoffRaised = {
  meta,
  subject,
  kind: 'handoff' as const,
  event: 'raised' as const,
  payload: {},
  class: 'product' as const,
  reason: 'a Type 1 decision surfaced mid-task',
  requested_decision: 'confirm the migration strategy'
}

describe('LogEventSchema — handoff family (O2)', () => {
  it('parses a raised handoff', () => {
    expect(LogEventSchema.safeParse(handoffRaised).success).toBe(true)
  })

  it("parses a resolved handoff — its own field set, not raised's requested_decision", () => {
    const line: Record<string, unknown> = {
      ...handoffRaised,
      event: 'resolved' as const,
      resolution: 'approved',
      resolved_by: 'principal'
    }
    delete line.requested_decision
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it("refuses resolved carrying raised's requested_decision field — .strict() per member of the union", () => {
    const line = { ...handoffRaised, event: 'resolved' as const, resolution: 'approved', resolved_by: 'principal' }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })

  it('refuses class outside authority/strategy/product', () => {
    expect(LogEventSchema.safeParse({ ...handoffRaised, class: 'architecture' }).success).toBe(false)
  })
})

const effectEvent = {
  meta,
  subject,
  kind: 'effect' as const,
  event: 'attempted' as const,
  payload: {},
  effect_id: 'e1',
  target: { kind: 'pr.comment', ref: '412' }
}

describe('LogEventSchema — effect family (O2)', () => {
  it('parses an attempted effect', () => {
    expect(LogEventSchema.safeParse(effectEvent).success).toBe(true)
  })

  it('parses observed/verified effects with an outcome, including uncertain', () => {
    expect(LogEventSchema.safeParse({ ...effectEvent, event: 'observed', outcome: 'uncertain' }).success).toBe(true)
    expect(LogEventSchema.safeParse({ ...effectEvent, event: 'verified', outcome: 'success' }).success).toBe(true)
  })

  it('refuses attempted carrying an outcome field — that belongs to observed/verified only', () => {
    expect(LogEventSchema.safeParse({ ...effectEvent, outcome: 'success' }).success).toBe(false)
  })
})

describe('LogEventSchema — review finding metadata (O3)', () => {
  const verdictLine = {
    meta,
    subject,
    kind: 'dispatch' as const,
    event: 'outcome_received' as const,
    payload: {},
    target_role: 'code-reviewer' as const,
    model: 'sonnet',
    effect_id: 'e1',
    outcome: {
      type: 'verdict' as const,
      verdict: 'REQUEST CHANGES' as const,
      head: 'sha1',
      comment_id: 99,
      objectives: [{ id: 'O1', met: false }],
      findings: [{ id: 'F1', severity: 'BLOCKER' }]
    },
    usage: { input: 10, output: 5 }
  }

  it('parses the pre-existing minimal finding shape — id/severity/state only', () => {
    expect(LogEventSchema.safeParse(verdictLine).success).toBe(true)
  })

  it('parses a finding carrying severity_scale, policy_treatment, and confidence with its own scale/source', () => {
    const line = {
      ...verdictLine,
      outcome: {
        ...verdictLine.outcome,
        findings: [
          {
            id: 'F1',
            severity: 'BLOCKER',
            severity_scale: 'code-review',
            policy_treatment: 'blocking' as const,
            confidence: 0.8,
            confidence_scale: '0-1',
            confidence_source: 'code-reviewer'
          }
        ]
      }
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('parses a finding declaring policy_treatment: unavailable rather than guessing blocking/non_blocking', () => {
    const line = {
      ...verdictLine,
      outcome: {
        ...verdictLine.outcome,
        findings: [{ id: 'F1', severity: 'MINOR', policy_treatment: 'unavailable' as const }]
      }
    }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('refuses confidence outside 0..1', () => {
    const line = {
      ...verdictLine,
      outcome: { ...verdictLine.outcome, findings: [{ id: 'F1', severity: 'MINOR', confidence: 1.5 }] }
    }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })

  it('refuses policy_treatment outside its enum', () => {
    const line = {
      ...verdictLine,
      outcome: { ...verdictLine.outcome, findings: [{ id: 'F1', severity: 'MINOR', policy_treatment: 'maybe' }] }
    }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })

  it('refuses an extra key on a finding — .strict() applies to the widened shape too', () => {
    const line = {
      ...verdictLine,
      outcome: { ...verdictLine.outcome, findings: [{ id: 'F1', severity: 'MINOR', sneaky: 1 }] }
    }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })
})

describe('LogEventSchema — defeat cases', () => {
  it('refuses kind: gate spread onto a dispatch-shaped event — a real kind, but the wrong event/field set for it', () => {
    expect(LogEventSchema.safeParse({ ...validDispatched, kind: 'gate' }).success).toBe(false)
  })

  it('refuses kind outside every shipped family — command/tokens fold into operation/usage, neither is its own kind', () => {
    expect(LogEventSchema.safeParse({ ...validForgeWrite, kind: 'command' }).success).toBe(false)
    expect(LogEventSchema.safeParse({ ...validForgeWrite, kind: 'tokens' }).success).toBe(false)
  })

  it('refuses an event outside its family', () => {
    expect(LogEventSchema.safeParse({ ...validDispatched, event: 'round_started' }).success).toBe(false)
  })

  it('refuses an extra top-level key', () => {
    expect(LogEventSchema.safeParse({ ...validDispatched, extra: 'nope' }).success).toBe(false)
  })

  it('refuses an extra key inside payload', () => {
    expect(LogEventSchema.safeParse({ ...validDispatched, payload: { sneaky: 1 } }).success).toBe(false)
  })

  it('refuses objectives_version as a number — string only, per this task’s deviation', () => {
    const line = { ...validDispatched, subject: { ...subject, objectives_version: 1 } }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })

  it('accepts objectives_version as a string', () => {
    const line = { ...validDispatched, subject: { ...subject, objectives_version: 'deadbeef' } }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('refuses subject.role outside the Role union or "unattributed"', () => {
    const line = { ...validDispatched, subject: { ...subject, role: 'admin' } }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })

  it('accepts subject.role: unattributed', () => {
    const line = { ...validDispatched, subject: { issue: null, role: 'unattributed' as const } }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it('accepts meta.repo: null — the unresolved-repo path', () => {
    const line = { ...validDispatched, meta: { ...meta, repo: null } }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })

  it("refuses a run_id carrying `-->` — would close the flush marker's HTML comment early (security review, PR #439)", () => {
    const line = { ...validDispatched, meta: { ...meta, run_id: 'evil--><script>' } }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })

  it('refuses a run_id carrying a newline', () => {
    const line = { ...validDispatched, meta: { ...meta, run_id: 'evil\nrun-2' } }
    expect(LogEventSchema.safeParse(line).success).toBe(false)
  })

  it('accepts a run_id at the safe-charset boundary', () => {
    const line = { ...validDispatched, meta: { ...meta, run_id: 'Run.id_09-safe' } }
    expect(LogEventSchema.safeParse(line).success).toBe(true)
  })
})
