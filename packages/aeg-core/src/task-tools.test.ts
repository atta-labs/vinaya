import { describe, expect, it } from 'vitest'
import {
  isTaskToolName,
  TASK_TOOL_CATALOG,
  TASK_TOOL_ERROR_KINDS,
  TASK_TOOL_NAMES,
  taskToolByName,
  taskToolError,
  capabilityUnavailable
} from './task-tools'

describe('TASK_TOOL_CATALOG', () => {
  it('carries exactly the five task tools, in TASK_TOOL_NAMES order', () => {
    expect(TASK_TOOL_CATALOG.map((tool) => tool.name)).toEqual([...TASK_TOOL_NAMES])
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

  it('the three mutating tools are stub-bound, the two read tools are bound', () => {
    expect(taskToolByName('task_start').handlerBinding.kind).toBe('stub')
    expect(taskToolByName('task_resume').handlerBinding.kind).toBe('stub')
    expect(taskToolByName('task_cancel').handlerBinding.kind).toBe('stub')
    expect(taskToolByName('task_status').handlerBinding.kind).toBe('bound')
    expect(taskToolByName('task_escalation_read').handlerBinding.kind).toBe('bound')
  })

  it('taskToolByName throws for an unknown name', () => {
    expect(() => taskToolByName('task_bogus' as never)).toThrow()
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
