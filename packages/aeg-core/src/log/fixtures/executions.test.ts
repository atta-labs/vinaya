import { describe, expect, it } from 'vitest'
import { LogEventSchema } from '../schema'
import { classifyStoredLine, recordIdentity } from '../store'
import { FACT_SHEETS } from './fact-sheets'
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

type Parsed = Record<string, any>

function parsedLines(name: (typeof EXECUTION_NAMES)[number]): Parsed[] {
  return buildExecution(name).lines.map((line) => JSON.parse(line.raw))
}

function count<T extends string | number>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[String(value)] = (out[String(value)] ?? 0) + 1
  return out
}

describe('fixture executions — each fact sheet matches its lines', () => {
  it('has a fact sheet for every execution and none besides', () => {
    expect(Object.keys(FACT_SHEETS).sort()).toEqual([...EXECUTION_NAMES].sort())
  })

  for (const name of EXECUTION_NAMES) {
    describe(name, () => {
      const sheet = FACT_SHEETS[name]
      const lines = parsedLines(name)

      it('line count and schema versions', () => {
        expect(lines.length).toBe(sheet.lines)
        expect(count(lines.map((l) => l.meta.schema))).toEqual(sheet.schemas)
      })

      it('round count', () => {
        const rounds = new Set(lines.filter((l) => l.event === 'round_started').map((l) => l.round))
        expect(rounds.size).toBe(sheet.rounds)
      })

      it('events per kind', () => {
        expect(count(lines.map((l) => l.kind))).toEqual(sheet.eventsByKind)
      })

      it('distinct finding identities', () => {
        const ids = new Set<string>()
        const named = (list: Array<string | { id: string }> | undefined) => {
          for (const item of list ?? []) ids.add(typeof item === 'string' ? item : item.id)
        }
        for (const line of lines) {
          named(line.findings)
          named(line.outcome?.findings)
          for (const key of ['open', 'resolved', 'new', 'recurring'])
            if (line.event === 'findings_compared') named(line[key])
        }
        expect([...ids].sort()).toEqual(sheet.findingIdentities)
      })

      it('models', () => {
        const models = new Set<string>()
        for (const line of lines) if (typeof line.model === 'string') models.add(line.model)
        expect([...models].sort()).toEqual(sheet.models)
      })
    })
  }
})

describe('fixture executions — each exists to exercise one behaviour', () => {
  it('the three-round execution states confidence from round 2 on, without and with the extra turn', () => {
    const reads = parsedLines('three-rounds-recurring-finding').filter((l) => l.event === 'gate_result_read')
    expect(reads.map((l) => [l.round, l.confidence_value !== undefined, l.extra_turn_spent])).toEqual([
      [1, false, undefined],
      [2, true, false],
      [3, true, true]
    ])
  })

  it('the three-round execution reports one finding in more than one round', () => {
    const compared = parsedLines('three-rounds-recurring-finding').filter((l) => l.event === 'findings_compared')
    expect(compared.some((l) => l.recurring.length > 0)).toBe(true)
  })

  it('the paused execution pauses and resumes the same round', () => {
    const events = parsedLines('paused-and-resumed').map((l) => l.event)
    expect(events.indexOf('paused')).toBeGreaterThan(-1)
    expect(events.indexOf('resumed')).toBe(events.indexOf('paused') + 1)
  })

  it('the escalated execution raises a handoff and never reaches green', () => {
    const lines = parsedLines('escalated-handoff')
    expect(lines.some((l) => l.kind === 'handoff' && l.event === 'raised')).toBe(true)
    expect(lines.find((l) => l.event === 'journal_finalized')?.result).toBe('stopped')
  })

  it('one check and fingerprint at two commits has two different outcomes', () => {
    const gates = parsedLines('gate-two-commits')
    expect(new Set(gates.map((g) => g.input_fingerprint)).size).toBe(1)
    expect(new Set(gates.map((g) => g.check_version)).size).toBe(1)
    expect(new Set(gates.map((g) => g.subject.sha)).size).toBe(2)
    expect(new Set(gates.map((g) => g.outcome)).size).toBe(2)
    expect(gates.map((g) => g.meta.work.revision)).toEqual(gates.map((g) => g.subject.sha))
  })

  it('the no-commit gates record no commit anywhere', () => {
    const gates = parsedLines('gate-no-commit')
    expect(new Set(gates.map((g) => g.input_fingerprint)).size).toBe(1)
    for (const gate of gates) {
      expect(gate.subject.sha).toBeUndefined()
      expect(gate.meta.work.revision).toBeNull()
    }
  })

  it('the same-commit gates share a commit and an outcome', () => {
    const gates = parsedLines('gate-same-commit-twice')
    expect(new Set(gates.map((g) => g.subject.sha)).size).toBe(1)
    expect(gates.map((g) => g.outcome)).toEqual(['pass', 'pass'])
  })

  it('usage observations carry both semantics, and the retried attempt has unknown usage both times', () => {
    const lines = parsedLines('usage-and-models')
    const usage = lines.filter((l) => l.kind === 'usage')
    expect(new Set(usage.map((u) => u.semantics))).toEqual(new Set(['cumulative', 'delta']))
    const attempts = lines.filter((l) => l.kind === 'role_attempt')
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2])
    expect(attempts.map((a) => a.usage)).toEqual([null, null])
  })

  it('the historical execution holds each kind of line exactly once, in order', () => {
    const execution = buildExecution('historical-and-hostile-lines')
    expect(execution.lines.map((l) => l.validity)).toEqual([
      'valid',
      'valid',
      'valid',
      'valid',
      'unknown_version',
      'invalid',
      'valid'
    ])
    const lines = execution.lines.map((l) => JSON.parse(l.raw))
    const lowTrust = lines[2]
    expect(lowTrust.meta.vinaya).toBe('0.30.1')
    expect(lowTrust.meta.actor_id).toBeNull()
    expect(lowTrust.meta.provenance).toBe('unavailable')
    expect(lowTrust.subject.role).toBe('unattributed')
    expect(execution.lines[6]?.raw).toBe(execution.lines[3]?.raw)
  })

  it('the schema 1 line is identified by a run and sequence pair no other line shares', () => {
    const execution = buildExecution('historical-and-hostile-lines')
    const first = JSON.parse(execution.lines[0]?.raw ?? '{}')
    expect(first.meta.event_id).toBeUndefined()
    const identities = execution.lines.map((l) => recordIdentity(JSON.parse(l.raw)))
    expect(identities.filter((id) => id === recordIdentity(first)).length).toBe(1)
  })
})
