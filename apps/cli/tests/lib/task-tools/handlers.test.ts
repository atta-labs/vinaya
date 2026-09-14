import { describe, expect, it } from 'bun:test'
import {
  taskCancelHandler,
  taskEscalationReadHandler,
  taskResumeHandler,
  taskStartHandler,
  taskStatusHandler
} from '../../../src/lib/task-tools/handlers.js'

/**
 * The forge-touching composition inside `taskStatusHandler`/
 * `taskEscalationReadHandler` (a `{ tranche, id }` ref, or no ref at all)
 * shells to real `gh` via `task-status.ts`'s own `gatherTaskStatusList` —
 * exercised end-to-end there (`apps/cli/tests/commands/task-status.test.ts`)
 * against a `gh` stub on `PATH`, never re-mocked here (this task adds no
 * CLI command for these tools to front such a test). What IS safe and
 * deterministic in-process: validation (rejected before any read at all),
 * the three refusing stubs (which touch no outbox and no forge), and the
 * `{ issue }` shape of `task_escalation_read`, which resolves straight to
 * the outbox with no forge call — read against a bare Issue number no real
 * outbox on this machine will ever carry.
 */

const NEVER_DISPATCHED_ISSUE = 900_000_001

describe('taskStatusHandler', () => {
  it('refuses malformed input with a validation error, before any read', () => {
    const result = taskStatusHandler({ limit: -1 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation')
  })

  it('refuses a limit over the catalog’s own ceiling', () => {
    const result = taskStatusHandler({ limit: 10_000 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation')
  })
})

describe('taskEscalationReadHandler', () => {
  it('refuses malformed input with a validation error', () => {
    const result = taskEscalationReadHandler({ task: { tranche: '', id: '1' } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('validation')
  })

  it('answers an empty page, never an error, for a bare Issue ref with no outbox record', () => {
    const result = taskEscalationReadHandler({ task: { issue: NEVER_DISPATCHED_ISSUE } })
    expect(result).toEqual({ ok: true, result: { items: [], nextCursor: null } })
  })
})

describe('the three mutating stubs', () => {
  it('task_start refuses with capability_unavailable for schema-valid input', () => {
    const result = taskStartHandler({ tranche: 'task-operator-v1', id: '1' })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('capability')
      expect(result.error.message).toContain('task_start')
    }
  })

  it('task_resume refuses with capability_unavailable for schema-valid input', () => {
    const result = taskResumeHandler({ task: { issue: NEVER_DISPATCHED_ISSUE } })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('capability')
  })

  it('task_cancel refuses with capability_unavailable for schema-valid input', () => {
    const result = taskCancelHandler({ task: { issue: NEVER_DISPATCHED_ISSUE }, reason: 'no longer needed' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.kind).toBe('capability')
  })

  it('every stub still validates its input first — malformed input is validation, not capability', () => {
    expect(taskStartHandler({}).ok).toBe(false)
    const start = taskStartHandler({})
    if (!start.ok) expect(start.error.kind).toBe('validation')

    const resume = taskResumeHandler({ task: { tranche: '', id: '' } })
    if (!resume.ok) expect(resume.error.kind).toBe('validation')

    const cancel = taskCancelHandler({ task: { issue: 1 }, reason: '' })
    if (!cancel.ok) expect(cancel.error.kind).toBe('validation')
  })
})
