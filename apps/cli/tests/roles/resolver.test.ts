import { describe, expect, it } from 'bun:test'
import type { RoleContract, RoleContractValidation } from '../../src/roles/contract'
import { resolveRoles, type RoleConfigInput } from '../../src/roles/resolver'

function role(overrides: Partial<RoleContract> = {}): RoleContract {
  return {
    roleId: 'developer',
    title: 'Developer',
    order: 3,
    description: 'Writes the code.',
    actor: 'agent',
    performs: ['write-the-code'],
    refusesWhen: 'Never.',
    summary: 'Ever?',
    ...overrides
  }
}

const CORE: RoleContract[] = [
  role({ roleId: 'developer', title: 'Developer' }),
  role({ roleId: 'security', title: 'Security Reviewer' })
]

function ok(contract: RoleContract): RoleContractValidation {
  return { ok: true, contract }
}
function invalid(...errors: string[]): RoleContractValidation {
  return { ok: false, errors }
}
function input(key: string, validation: RoleContractValidation): RoleConfigInput {
  return { key, validation }
}

describe('resolveRoles', () => {
  it('classifies every core entry as default when config is undefined', () => {
    const result = resolveRoles(CORE, undefined)
    expect(result.failures).toEqual([])
    expect(result.resolved).toHaveLength(2)
    for (const r of result.resolved) {
      expect(r.state).toBe('default')
      expect(r.source).toBe('core')
      expect(r.renderId).toBe(r.name)
      expect(r.inertToGating).toBeUndefined()
    }
  })

  it('classifies every core entry as default when config is an empty object', () => {
    const result = resolveRoles(CORE, {})
    expect(result.resolved.every((r) => r.state === 'default')).toBe(true)
    expect(result.failures).toEqual([])
  })

  it('an exact-key match with a matching role_id overrides the core entry, replacing it in place', () => {
    const overrideContract = role({ roleId: 'developer', title: 'Custom Developer' })
    const result = resolveRoles(CORE, { developer: input('developer', ok(overrideContract)) })
    expect(result.failures).toEqual([])
    const overridden = result.resolved.find((r) => r.name === 'developer')
    expect(overridden?.state).toBe('overridden')
    expect(overridden?.source).toBe('config')
    expect(overridden?.renderId).toBe('developer')
    expect(overridden?.contract.title).toBe('Custom Developer')
    // Complete replacement — the core `security` entry is untouched.
    expect(result.resolved.find((r) => r.name === 'security')?.state).toBe('default')
  })

  it('an override whose contract role_id does not match the config key is a failure, core entry unaffected', () => {
    const mismatched = role({ roleId: 'not-developer' })
    const result = resolveRoles(CORE, { developer: input('developer', ok(mismatched)) })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.key).toBe('developer')
    expect(result.failures[0]?.reason).toContain('role_id')
    expect(result.resolved.find((r) => r.name === 'developer')?.state).toBe('default')
  })

  it('an override whose contract is structurally invalid is a failure naming the errors', () => {
    const result = resolveRoles(CORE, { developer: input('developer', invalid('missing "summary"')) })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.reason).toContain('missing "summary"')
    expect(result.resolved.find((r) => r.name === 'developer')?.state).toBe('default')
  })

  it('a namespaced key with a matching post-"/" role_id is additive and flagged inert to core gating', () => {
    const additive = role({ roleId: 'qa-lead', title: 'QA Lead' })
    const result = resolveRoles(CORE, { 'acme/qa-lead': input('acme/qa-lead', ok(additive)) })
    expect(result.failures).toEqual([])
    const entry = result.resolved.find((r) => r.name === 'acme/qa-lead')
    expect(entry?.state).toBe('additive')
    expect(entry?.source).toBe('config')
    expect(entry?.renderId).toBe('qa-lead')
    expect(entry?.inertToGating).toBe(true)
  })

  it('an additive entry whose contract role_id does not match the post-"/" segment is a failure', () => {
    const mismatched = role({ roleId: 'wrong-id' })
    const result = resolveRoles(CORE, { 'acme/qa-lead': input('acme/qa-lead', ok(mismatched)) })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.key).toBe('acme/qa-lead')
    expect(result.failures[0]?.reason).toContain('role_id')
    expect(result.resolved.some((r) => r.name === 'acme/qa-lead')).toBe(false)
  })

  it('an additive entry whose contract is structurally invalid is a failure naming the errors', () => {
    const result = resolveRoles(CORE, { 'acme/qa-lead': input('acme/qa-lead', invalid('bad shape')) })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.reason).toContain('bad shape')
  })

  it('a bare key with no core match and no namespace is a failure, not added to resolved', () => {
    const result = resolveRoles(CORE, { badkey: input('badkey', ok(role({ roleId: 'badkey' }))) })
    expect(result.failures).toEqual([{ key: 'badkey', reason: 'bare key has no "/" and matches no core role id' }])
    expect(result.resolved.some((r) => r.name === 'badkey')).toBe(false)
    expect(result.resolved).toHaveLength(2)
  })

  it('an additive role rendering as an existing core role id is a failure, not added to resolved', () => {
    const collides = role({ roleId: 'developer' })
    const result = resolveRoles(CORE, { 'acme/developer': input('acme/developer', ok(collides)) })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0]?.key).toBe('acme/developer')
    expect(result.failures[0]?.reason).toContain('collides with a core role id')
    expect(result.resolved.some((r) => r.name === 'acme/developer')).toBe(false)
  })

  it('two additive roles rendering under the same id both fail, each naming the other', () => {
    const a = role({ roleId: 'qa-lead' })
    const b = role({ roleId: 'qa-lead' })
    const result = resolveRoles(CORE, {
      'acme/qa-lead': input('acme/qa-lead', ok(a)),
      'other/qa-lead': input('other/qa-lead', ok(b))
    })
    expect(result.failures).toHaveLength(2)
    const byKey = Object.fromEntries(result.failures.map((f) => [f.key, f.reason]))
    expect(byKey['acme/qa-lead']).toContain('other/qa-lead')
    expect(byKey['other/qa-lead']).toContain('acme/qa-lead')
    expect(result.resolved.some((r) => r.name === 'acme/qa-lead' || r.name === 'other/qa-lead')).toBe(false)
  })

  it('collision detection is order-independent (collect-all-then-reject, not incremental)', () => {
    const a = role({ roleId: 'qa-lead' })
    const b = role({ roleId: 'qa-lead' })
    const forward = resolveRoles(CORE, {
      'acme/qa-lead': input('acme/qa-lead', ok(a)),
      'other/qa-lead': input('other/qa-lead', ok(b))
    })
    const backward = resolveRoles(CORE, {
      'other/qa-lead': input('other/qa-lead', ok(b)),
      'acme/qa-lead': input('acme/qa-lead', ok(a))
    })
    expect(forward.failures).toHaveLength(2)
    expect(backward.failures).toHaveLength(2)
  })

  it('classification is deterministic and independent of config-file key order', () => {
    const additive = role({ roleId: 'qa-lead' })
    const overrideContract = role({ roleId: 'developer' })
    const configA: Record<string, RoleConfigInput> = {
      'acme/qa-lead': input('acme/qa-lead', ok(additive)),
      developer: input('developer', ok(overrideContract))
    }
    const configB: Record<string, RoleConfigInput> = {
      developer: input('developer', ok(overrideContract)),
      'acme/qa-lead': input('acme/qa-lead', ok(additive))
    }
    const resultA = resolveRoles(CORE, configA)
    const resultB = resolveRoles(CORE, configB)
    const byName = (r: typeof resultA) =>
      Object.fromEntries(r.resolved.map((e) => [e.name, { state: e.state, source: e.source }]))
    expect(byName(resultA)).toEqual(byName(resultB))
  })

  it('mixes default, overridden, and additive states together', () => {
    const overrideContract = role({ roleId: 'developer' })
    const additive = role({ roleId: 'qa-lead' })
    const result = resolveRoles(CORE, {
      developer: input('developer', ok(overrideContract)),
      'acme/qa-lead': input('acme/qa-lead', ok(additive)),
      badkey: input('badkey', ok(role({ roleId: 'badkey' })))
    })
    expect(result.resolved.find((r) => r.name === 'security')?.state).toBe('default')
    expect(result.resolved.find((r) => r.name === 'developer')?.state).toBe('overridden')
    expect(result.resolved.find((r) => r.name === 'acme/qa-lead')?.state).toBe('additive')
    expect(result.failures).toEqual([{ key: 'badkey', reason: 'bare key has no "/" and matches no core role id' }])
  })
})
