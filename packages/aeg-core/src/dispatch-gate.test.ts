import { describe, expect, it } from 'vitest'
import { checkDispatchReadiness, type DispatchGateInput } from './dispatch-gate'
import type { Task } from './types'

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '12',
    title: 'Some task',
    issue: 326,
    projects: ['aeg'],
    dependsOn: [],
    conflictsWith: [],
    rationaleMarkdown: '',
    ...overrides
  }
}

function makeInput(overrides: Partial<DispatchGateInput> = {}): DispatchGateInput {
  return {
    trancheSlug: 'aeg-governance-hardening',
    task: makeTask(),
    issue: { number: 326, state: 'open' },
    issueRationalePass: true,
    dependsOn: [],
    conflictsWith: [],
    priorTask: null,
    priorTrancheArchival: [],
    ...overrides
  }
}

describe('checkDispatchReadiness', () => {
  it('is ready when every predicate holds', () => {
    const result = checkDispatchReadiness(makeInput())
    expect(result).toEqual({ ready: true, blockers: [] })
  })

  it('blocks when the topology row has no Issue (#TBD)', () => {
    const result = checkDispatchReadiness(makeInput({ task: makeTask({ issue: null }), issue: null }))
    expect(result.ready).toBe(false)
    expect(result.blockers[0]).toContain('issue-existence')
    expect(result.blockers[0]).toContain('#TBD')
  })

  it('blocks when the Issue number is a phantom reference', () => {
    const result = checkDispatchReadiness(makeInput({ issue: null }))
    expect(result.ready).toBe(false)
    expect(result.blockers[0]).toContain('phantom reference')
  })

  it('blocks when the Issue fails the rationale gate', () => {
    const result = checkDispatchReadiness(makeInput({ issueRationalePass: false }))
    expect(result.ready).toBe(false)
    expect(result.blockers[0]).toContain('rationale')
    expect(result.blockers[0]).toContain('#326')
  })

  it('does not double-report rationale when the Issue itself does not exist', () => {
    const result = checkDispatchReadiness(
      makeInput({ task: makeTask({ issue: null }), issue: null, issueRationalePass: false })
    )
    expect(result.blockers).toHaveLength(1)
  })

  it('blocks on an unmerged depends-on edge', () => {
    const result = checkDispatchReadiness(makeInput({ dependsOn: [{ id: '5', issue: 266, merged: false }] }))
    expect(result.ready).toBe(false)
    expect(result.blockers[0]).toContain('depends-on')
    expect(result.blockers[0]).toContain('#266')
  })

  it('passes a merged depends-on edge', () => {
    const result = checkDispatchReadiness(makeInput({ dependsOn: [{ id: '5', issue: 266, merged: true }] }))
    expect(result.ready).toBe(true)
  })

  /**
   * #196: `resolved: false` (the edge never matched any tranche/task/Issue at
   * all) must report UNRESOLVABLE, quoting the edge text — never the "not
   * merged yet" claim, which is a fact about the forge this case never
   * observed. Still blocks (conservative default), just says why honestly.
   */
  it('blocks an unresolvable depends-on edge with a distinct message, quoting the edge', () => {
    const result = checkDispatchReadiness(
      makeInput({ dependsOn: [{ id: 'unknown-tranche 2', issue: null, merged: false, resolved: false }] })
    )
    expect(result.ready).toBe(false)
    expect(result.blockers[0]).toContain('depends-on')
    expect(result.blockers[0]).toContain('UNRESOLVABLE')
    expect(result.blockers[0]).toContain('"unknown-tranche 2"')
    expect(result.blockers[0]).not.toContain('not merged yet')
  })

  it('an unmerged-but-resolved edge still gets the original "not merged yet" message', () => {
    const result = checkDispatchReadiness(
      makeInput({ dependsOn: [{ id: '5', issue: 266, merged: false, resolved: true }] })
    )
    expect(result.blockers[0]).toContain('not merged yet')
    expect(result.blockers[0]).not.toContain('UNRESOLVABLE')
  })

  it('`resolved` absent (every caller before #196) behaves exactly as before', () => {
    const result = checkDispatchReadiness(makeInput({ dependsOn: [{ id: '5', issue: 266, merged: false }] }))
    expect(result.blockers[0]).toContain('not merged yet')
    expect(result.blockers[0]).not.toContain('UNRESOLVABLE')
  })

  it('blocks on an open conflicts-with edge', () => {
    const result = checkDispatchReadiness(
      makeInput({ conflictsWith: [{ id: '15', issue: 329, openOrInFlight: true }] })
    )
    expect(result.ready).toBe(false)
    expect(result.blockers[0]).toContain('conflicts-with')
    expect(result.blockers[0]).toContain('#329')
  })

  it('passes a conflicts-with edge that is not open/in-flight (e.g. merged or no branch)', () => {
    const result = checkDispatchReadiness(
      makeInput({ conflictsWith: [{ id: '15', issue: 329, openOrInFlight: false }] })
    )
    expect(result.ready).toBe(true)
  })

  it('no longer blocks when prior task fails every archival predicate (row-adjacency gate removed)', () => {
    const result = checkDispatchReadiness(
      makeInput({
        priorTask: { id: '10', issue: 282, issueClosed: false, prMerged: false, hasProvenance: false }
      })
    )
    expect(result.ready).toBe(true)
    expect(result.blockers.some((b) => b.includes('prior-archival'))).toBe(false)
  })

  it('passes when the prior task is fully archived', () => {
    const result = checkDispatchReadiness(
      makeInput({
        priorTask: { id: '10', issue: 282, issueClosed: true, prMerged: true, hasProvenance: true }
      })
    )
    expect(result.ready).toBe(true)
  })

  it('passes trivially when there is no prior task (first task of a fresh tranche)', () => {
    const result = checkDispatchReadiness(makeInput({ priorTask: null }))
    expect(result.ready).toBe(true)
  })

  it('blocks when a named project has an unarchived prior tranche', () => {
    const result = checkDispatchReadiness(
      makeInput({
        priorTrancheArchival: [{ project: 'aeg', priorTrancheSlug: 'aeg-consolidation', archived: false }]
      })
    )
    expect(result.ready).toBe(false)
    expect(result.blockers[0]).toContain('prior-tranche-archival')
    expect(result.blockers[0]).toContain('aeg-consolidation')
  })

  it('passes when a named project has an archived prior tranche', () => {
    const result = checkDispatchReadiness(
      makeInput({
        priorTrancheArchival: [{ project: 'aeg', priorTrancheSlug: 'aeg-consolidation', archived: true }]
      })
    )
    expect(result.ready).toBe(true)
  })

  it('passes trivially when a named project has no prior tranche at all', () => {
    const result = checkDispatchReadiness(
      makeInput({
        priorTrancheArchival: [{ project: 'aeg', priorTrancheSlug: null, archived: false }]
      })
    )
    expect(result.ready).toBe(true)
  })

  // ---- hand-closed dependency recognition (task vinaya-engine-v1 21, #99) --

  it('passes a depends-on edge hand-closed by a recognized Principal (real incident shape: #890)', () => {
    const result = checkDispatchReadiness(
      makeInput({
        dependsOn: [
          {
            id: '1',
            issue: 890,
            merged: false,
            issueState: 'closed',
            stateReason: 'completed',
            closedByActor: 'daniboomerang'
          }
        ]
      })
    )
    expect(result.ready).toBe(true)
  })

  it('blocks a depends-on edge closed by a non-recognized actor', () => {
    const result = checkDispatchReadiness(
      makeInput({
        dependsOn: [
          {
            id: '1',
            issue: 890,
            merged: false,
            issueState: 'closed',
            stateReason: 'completed',
            closedByActor: 'some-rando'
          }
        ]
      })
    )
    expect(result.ready).toBe(false)
    expect(result.blockers[0]).toContain('depends-on')
  })

  it('blocks a depends-on edge closed NOT_PLANNED even by a recognized Principal (abandoned, not resolved)', () => {
    const result = checkDispatchReadiness(
      makeInput({
        dependsOn: [
          {
            id: '1',
            issue: 890,
            merged: false,
            issueState: 'closed',
            stateReason: 'not_planned',
            closedByActor: 'daniboomerang'
          }
        ]
      })
    )
    expect(result.ready).toBe(false)
  })

  it('blocks an open depends-on edge even with a recognized closedByActor set (issueState must be closed)', () => {
    const result = checkDispatchReadiness(
      makeInput({
        dependsOn: [
          {
            id: '1',
            issue: 890,
            merged: false,
            issueState: 'open',
            stateReason: null,
            closedByActor: 'daniboomerang'
          }
        ]
      })
    )
    expect(result.ready).toBe(false)
  })

  it('respects an overridden principalAllowlist over the hardcoded default', () => {
    const result = checkDispatchReadiness(
      makeInput({
        dependsOn: [
          {
            id: '1',
            issue: 890,
            merged: false,
            issueState: 'closed',
            stateReason: 'completed',
            closedByActor: 'adopter-principal'
          }
        ],
        principalAllowlist: ['adopter-principal']
      })
    )
    expect(result.ready).toBe(true)
  })

  it('still blocks an unresolved edge with no hand-close facts (unchanged pre-task-21 behavior)', () => {
    const result = checkDispatchReadiness(makeInput({ dependsOn: [{ id: '5', issue: 266, merged: false }] }))
    expect(result.ready).toBe(false)
  })

  it('accumulates multiple independent blockers in one call', () => {
    const result = checkDispatchReadiness(
      makeInput({
        dependsOn: [{ id: '5', issue: 266, merged: false }],
        conflictsWith: [{ id: '15', issue: 329, openOrInFlight: true }]
      })
    )
    expect(result.blockers).toHaveLength(2)
  })
})
