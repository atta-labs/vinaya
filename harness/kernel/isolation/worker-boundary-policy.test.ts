/**
 * The per-turn worker boundary's policy seams, owned by the boundary itself:
 * building one without its role policy or its scratch-name policy is refused,
 * naming the missing one; and the other-roles protected-path list is derived
 * from whatever session names, round directories, concurrent sibling and
 * scratch rule the policies carry. Every role label here is synthetic — no
 * process's own vocabulary.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import {
  type BoundaryRolePolicy,
  createWorkerBoundary,
  MissingWorkerBoundaryPolicyError,
  type ScratchNamePolicy,
  type WorkerBoundaryPolicies
} from './worker-boundary'

const ROLES: BoundaryRolePolicy = {
  // `north-star` carries its own hyphen, so it is listed ahead of anything its first segment could read as.
  sessionRoles: ['north-star', 'east', 'west'],
  roundDirectory: (role) => {
    if (role === 'north-star') return { name: 'north', suffixed: false }
    return { name: `${role}-dir`, suffixed: true }
  },
  concurrentSibling: (role) => (role === 'east' ? 'west' : role === 'west' ? 'east' : null)
}

const SCRATCH: ScratchNamePolicy = {
  isExemptScratchName: (name, role) =>
    (role === 'east' || role === 'west') && (name === `${role}-scratch` || name.startsWith(`${role}-scratch-`))
}

describe('createWorkerBoundary — a missing policy is a refusal, never a default', () => {
  it('refuses no policies at all, naming the role policy', () => {
    expect(() => createWorkerBoundary(undefined as unknown as WorkerBoundaryPolicies)).toThrow(
      'worker boundary: refusing to build without its role policy (roles)'
    )
  })

  it('refuses a boundary built without its role policy', () => {
    let thrown: unknown
    try {
      createWorkerBoundary({ scratchNames: SCRATCH } as unknown as WorkerBoundaryPolicies)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(MissingWorkerBoundaryPolicyError)
    expect((thrown as MissingWorkerBoundaryPolicyError).policy).toBe('roles')
  })

  it('refuses a boundary built without its scratch-name policy', () => {
    expect(() => createWorkerBoundary({ roles: ROLES } as unknown as WorkerBoundaryPolicies)).toThrow(
      'worker boundary: refusing to build without its scratch-name policy (scratchNames)'
    )
  })

  it('refuses a malformed policy as missing', () => {
    expect(() =>
      createWorkerBoundary({ roles: { sessionRoles: [] }, scratchNames: SCRATCH } as unknown as WorkerBoundaryPolicies)
    ).toThrow(MissingWorkerBoundaryPolicyError)
    expect(() => createWorkerBoundary({ roles: ROLES, scratchNames: {} } as unknown as WorkerBoundaryPolicies)).toThrow(
      '(scratchNames)'
    )
  })
})

describe('protectedPathsForTurn reads every role fact from the policies', () => {
  let runtimeDir: string
  const boundary = createWorkerBoundary({ roles: ROLES, scratchNames: SCRATCH })
  const taskDir = (): string => join(runtimeDir, 'tasks-execution', '5')

  beforeEach(() => {
    runtimeDir = realpathSync(mkdtempSync(join(tmpdir(), 'worker-boundary-policy-')))
    const sessions = join(taskDir(), 'sessions')
    mkdirSync(sessions, { recursive: true })
    for (const name of ['north-star-agent.json', 'east-agent.json', 'west-agent.json']) {
      writeFileSync(join(sessions, name), '{}')
    }
    for (const [round, names] of [
      ['1', ['north', 'east-dir', 'east-dir-retry1', 'west-dir', 'east-scratch', 'west-scratch', 'candidate']],
      ['2', ['west-dir', 'west-scratch', 'east-scratch']]
    ] as const) {
      for (const name of names) mkdirSync(join(taskDir(), 'rounds', round, name), { recursive: true })
    }
  })
  afterEach(() => rmSync(runtimeDir, { recursive: true, force: true }))

  const otherRoleEntries = (role: string, round: number): string[] =>
    boundary
      .protectedPathsForTurn({ runtimeDir, task: 5, round, role, vinayaConfigPath: null })
      .map((entry) => relative(taskDir(), entry.path))
      .filter((path) => path.startsWith('sessions') || path.startsWith('rounds'))
      .sort()

  it('a role with a concurrent sibling excuses its own entries and its sibling’s same-round ones, never the shared candidate', () => {
    expect(otherRoleEntries('east', 1)).toEqual(
      [
        'sessions/north-star-agent.json',
        'rounds/1/north',
        'rounds/1/candidate',
        'rounds/2/west-dir',
        'rounds/2/west-scratch',
        'rounds/2/east-scratch'
      ].sort()
    )
  })

  it('a role running alone protects every other role’s session and round entry, parsing a hyphenated role by its listed name', () => {
    expect(otherRoleEntries('north-star', 1)).toEqual(
      [
        'sessions/east-agent.json',
        'sessions/west-agent.json',
        'rounds/1/east-dir',
        'rounds/1/east-dir-retry1',
        'rounds/1/west-dir',
        'rounds/1/east-scratch',
        'rounds/1/west-scratch',
        'rounds/1/candidate',
        'rounds/2/west-dir',
        'rounds/2/west-scratch',
        'rounds/2/east-scratch'
      ].sort()
    )
  })

  it('an unsuffixed round directory belongs to its role by exact name only', () => {
    mkdirSync(join(taskDir(), 'rounds', '1', 'north-retry1'), { recursive: true })
    expect(otherRoleEntries('north-star', 1)).toContain('rounds/1/north-retry1')
    expect(otherRoleEntries('north-star', 1)).not.toContain('rounds/1/north')
  })
})
