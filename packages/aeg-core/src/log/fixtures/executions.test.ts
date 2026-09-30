import { describe, expect, it } from 'vitest'
import { LogEventSchema } from '../schema'
import { classifyStoredLine, recordIdentity } from '../store'
import { buildExecution, buildExecutions, EXECUTION_NAMES } from './executions'
import { FIXTURE_EPOCH } from './generator'

const HOME = '/fixture-home'

describe('fixture executions — every line validates under the schema version it declares', () => {
  for (const execution of buildExecutions()) {
    describe(execution.name, () => {
      it('has lines, and every line is JSON', () => {
        expect(execution.lines.length).toBeGreaterThan(0)
        for (const line of execution.lines) expect(() => JSON.parse(line.raw)).not.toThrow()
      })

      it('every line marked valid parses under the event schema, and every other line does not', () => {
        for (const line of execution.lines) {
          const parsed = LogEventSchema.safeParse(JSON.parse(line.raw))
          expect(parsed.success, line.raw).toBe(line.validity === 'valid')
        }
      })

      it('a reader classifies each line the way the fixture marks it', () => {
        const expected = { valid: 'ok', unknown_version: 'unknown_version', invalid: 'invalid' } as const
        for (const line of execution.lines) {
          expect(classifyStoredLine(line.raw, HOME).status).toBe(expected[line.validity])
        }
      })
    })
  }
})

describe('fixture executions — determinism', () => {
  it('the same seed gives the same lines byte for byte', () => {
    expect(buildExecutions()).toEqual(buildExecutions())
    expect(buildExecutions('another-seed')).toEqual(buildExecutions('another-seed'))
  })

  it('a different seed gives different ids and times', () => {
    const a = buildExecution('green-one-round').lines.map((l) => l.raw)
    const b = buildExecution('green-one-round', 'another-seed').lines.map((l) => l.raw)
    expect(a).not.toEqual(b)
  })

  it('building one execution alone gives the same lines as building it among the others', () => {
    for (const execution of buildExecutions()) expect(buildExecution(execution.name)).toEqual(execution)
  })

  it('times start at the epoch and never go backwards within an execution', () => {
    const epoch = Date.parse(FIXTURE_EPOCH)
    const first = buildExecution(EXECUTION_NAMES[0])
    const times = first.lines.map((l) => Date.parse(JSON.parse(l.raw).meta.ts))
    expect(times[0]).toBeGreaterThan(epoch)
    expect(times).toEqual([...times].sort((x, y) => x - y))
  })
})

describe('fixture executions — nothing sensitive', () => {
  it('no line carries a home path, a token shape or a real repository name', () => {
    for (const execution of buildExecutions()) {
      for (const line of execution.lines) {
        expect(line.raw).not.toMatch(/\/Users\/|\/home\/|ghp_|gho_|github_pat_|atta-labs/)
      }
    }
  })
})

describe('fixture executions — identities', () => {
  it('every valid line has an identity', () => {
    for (const execution of buildExecutions()) {
      for (const line of execution.lines.filter((l) => l.validity === 'valid')) {
        expect(recordIdentity(JSON.parse(line.raw))).not.toBeNull()
      }
    }
  })
})
