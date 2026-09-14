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
