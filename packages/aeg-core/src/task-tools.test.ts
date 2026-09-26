import { describe, expect, it } from 'vitest'
import {
  isTaskToolName,
  TASK_TOOL_CATALOG,
  TASK_TOOL_ERROR_KINDS,
  TASK_TOOL_NAMES,
  taskToolByName,
  taskToolError,
  taskStartRequestIdentity,
  capabilityUnavailable
} from './task-tools'

describe('TASK_TOOL_CATALOG', () => {
  it('carries exactly the six task tools, in TASK_TOOL_NAMES order', () => {
    expect(TASK_TOOL_CATALOG.map((tool) => tool.name)).toEqual([...TASK_TOOL_NAMES])
    expect(TASK_TOOL_NAMES).toContain('task_pr_read')
    expect(TASK_TOOL_NAMES.length).toBe(6)
  })

  it('every tool has a purpose, boundaries, and at least one example', () => {
    for (const tool of TASK_TOOL_CATALOG) {
      expect(tool.purpose.length).toBeGreaterThan(0)
      expect(tool.boundaries.length).toBeGreaterThan(0)
      expect(tool.examples.length).toBeGreaterThan(0)
    }
  })

  it('every example validates against its own tool inputSchema', () => {
    for (const tool of TASK_TOOL_CATALOG) {
      for (const example of tool.examples) {
        expect(() => tool.inputSchema.parse(example), `${tool.name} example ${JSON.stringify(example)}`).not.toThrow()
      }
    }
  })

  it('every tool errorSchema accepts one instance of every error kind', () => {
    for (const tool of TASK_TOOL_CATALOG) {
      for (const kind of TASK_TOOL_ERROR_KINDS) {
        expect(() => tool.errorSchema.parse(taskToolError(kind, 'x'))).not.toThrow()
      }
    }
  })

  it('every catalog tool is bound to a real handler', () => {
    for (const tool of TASK_TOOL_CATALOG) {
      expect(taskToolByName(tool.name).handlerBinding.kind).toBe('bound')
    }
  })

  it('taskToolByName throws for an unknown name', () => {
    expect(() => taskToolByName('task_bogus' as never)).toThrow()
  })
})

describe('taskStartRequestIdentity', () => {
  const base = {
    caller: 'op1',
    repo: 'o/r',
    target: { tranche: 'task-operator-v1', id: '2' },
    payloadDigest: 'd1'
  }

  it('is deterministic — the same input always yields the same id', () => {
    expect(taskStartRequestIdentity(base)).toBe(taskStartRequestIdentity({ ...base }))
  })

  it('differs when any scoping field differs (caller, repo, target, payload)', () => {
    const id = taskStartRequestIdentity(base)
    expect(taskStartRequestIdentity({ ...base, caller: 'op2' })).not.toBe(id)
    expect(taskStartRequestIdentity({ ...base, repo: 'o/other' })).not.toBe(id)
    expect(taskStartRequestIdentity({ ...base, repo: null })).not.toBe(id)
    expect(taskStartRequestIdentity({ ...base, target: { tranche: 'other', id: '2' } })).not.toBe(id)
    expect(taskStartRequestIdentity({ ...base, target: { tranche: 'task-operator-v1', id: '3' } })).not.toBe(id)
    expect(taskStartRequestIdentity({ ...base, payloadDigest: 'd2' })).not.toBe(id)
  })

  it('is a stable, opaque token shape', () => {
    expect(taskStartRequestIdentity(base)).toMatch(/^req_[0-9a-f]{32}$/)
  })

  it('never lets the two address forms share an identity, whichever Issue an ordinal resolves to', () => {
    const byIssue = taskStartRequestIdentity({ ...base, target: { issue: 729 } })
    expect(byIssue).not.toBe(taskStartRequestIdentity(base))
    // Nor does a tranche whose own slug/id happen to stringify like the number.
    expect(byIssue).not.toBe(taskStartRequestIdentity({ ...base, target: { tranche: 'issue', id: '729' } }))
    expect(byIssue).toBe(taskStartRequestIdentity({ ...base, target: { issue: 729 } }))
    expect(byIssue).not.toBe(taskStartRequestIdentity({ ...base, target: { issue: 730 } }))
  })

  it('computes a tranche identity from the same bytes it always has, so an older build’s claim is still found', () => {
    // Pinned to the sha256 of the pre-widening canonical bytes
    // (`{"caller":"op1","repo":"o/r","tranche":"task-operator-v1","id":"2","payloadDigest":"d1"}`),
    // computed outside this implementation rather than recorded from it: a claim
    // file written before `{ issue }` was a startable form lives at a path keyed
    // by this exact string, and an upgrade that changed it would replay nothing
    // and start a second run.
    expect(taskStartRequestIdentity(base)).toBe('req_6143a102cd1a157c71eecf0ba1ba1f75')
  })
})

describe('isTaskToolName', () => {
  it('accepts every catalog name and rejects an arbitrary string', () => {
    for (const name of TASK_TOOL_NAMES) expect(isTaskToolName(name)).toBe(true)
    expect(isTaskToolName('task_bogus')).toBe(false)
  })
})

describe('capabilityUnavailable', () => {
  it('always returns a capability-kind error naming the tool', () => {
    const err = capabilityUnavailable('task_start', 'no control store exists yet')
    expect(err.kind).toBe('capability')
    expect(err.message).toContain('task_start')
    expect(err.message).toContain('no control store exists yet')
  })
})
