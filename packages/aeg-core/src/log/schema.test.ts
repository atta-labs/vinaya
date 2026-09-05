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
      reason: 'timeout' as const
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
})

describe('LogEventSchema — defeat cases', () => {
  it('refuses kind: gate — out of scope for this task', () => {
    expect(LogEventSchema.safeParse({ ...validDispatched, kind: 'gate' }).success).toBe(false)
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
})
