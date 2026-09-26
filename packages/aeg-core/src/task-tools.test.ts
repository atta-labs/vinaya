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
  const base = { caller: 'op1', repo: 'o/r', tranche: 'task-operator-v1', id: '2', payloadDigest: 'd1' }

  it('is deterministic — the same input always yields the same id', () => {
    expect(taskStartRequestIdentity(base)).toBe(taskStartRequestIdentity({ ...base }))
  })

  it('differs when any scoping field differs (caller, repo, target, payload)', () => {
    const id = taskStartRequestIdentity(base)
    expect(taskStartRequestIdentity({ ...base, caller: 'op2' })).not.toBe(id)
    expect(taskStartRequestIdentity({ ...base, repo: 'o/other' })).not.toBe(id)
    expect(taskStartRequestIdentity({ ...base, repo: null })).not.toBe(id)
    expect(taskStartRequestIdentity({ ...base, tranche: 'other' })).not.toBe(id)
    expect(taskStartRequestIdentity({ ...base, id: '3' })).not.toBe(id)
    expect(taskStartRequestIdentity({ ...base, payloadDigest: 'd2' })).not.toBe(id)
  })

  it('is a stable, opaque token shape', () => {
    expect(taskStartRequestIdentity(base)).toMatch(/^req_[0-9a-f]{32}$/)
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
