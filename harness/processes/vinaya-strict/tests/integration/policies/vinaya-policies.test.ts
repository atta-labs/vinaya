import { describe, expect, it } from 'bun:test'
import { isProtectedAdminPath, normalizeTouchedPath, PROTECTED_ADMIN_PATHS } from '@attalabs/aeg-core'
import type { DispatchTeeRecoveryDeps } from '../../../loops/dev-review/dispatch/dispatch.js'
import { vinayaLaunchRecordVerifier } from '../../../integration/policies/launch-records.js'
import { VINAYA_PROTECTED_PATHS } from '../../../integration/policies/protected-paths.js'
import {
  VINAYA_BOUNDARY_ROLES,
  VINAYA_BROKER_ROLES,
  VINAYA_ROUTER_ROLES,
  VINAYA_TOOL_GRANTS
} from '../../../integration/policies/roles.js'
import { VINAYA_SCRATCH_NAMES } from '../../../integration/policies/scratch-names.js'
import {
  vinayaBrokerPolicies,
  vinayaProtectedPathPolicy,
  vinayaRouterPolicies,
  vinayaToolGrantPolicy,
  vinayaWorkerBoundaryPolicies
} from '../../../integration/policies/vinaya-policies.js'

/** Vinaya's scratch-name, protected-path and launch-record implementations, and the composition every builder reads. */

describe('the scratch-name policy — each reviewer’s own scratch copy, never the candidate or the sibling’s', () => {
  it('exempts the code reviewer’s reviewer-scratch family and the security reviewer’s security-scratch family', () => {
    expect(VINAYA_SCRATCH_NAMES.isExemptScratchName('reviewer-scratch', 'code-reviewer')).toBe(true)
    expect(VINAYA_SCRATCH_NAMES.isExemptScratchName('reviewer-scratch-retry2', 'code-reviewer')).toBe(true)
    expect(VINAYA_SCRATCH_NAMES.isExemptScratchName('security-scratch', 'security')).toBe(true)
    expect(VINAYA_SCRATCH_NAMES.isExemptScratchName('security-scratch-retry1', 'security')).toBe(true)
  })
  it('never exempts the shared candidate, the sibling’s copy, a work directory or any Developer entry', () => {
    expect(VINAYA_SCRATCH_NAMES.isExemptScratchName('candidate', 'code-reviewer')).toBe(false)
    expect(VINAYA_SCRATCH_NAMES.isExemptScratchName('security-scratch', 'code-reviewer')).toBe(false)
    expect(VINAYA_SCRATCH_NAMES.isExemptScratchName('reviewer-scratch', 'security')).toBe(false)
    expect(VINAYA_SCRATCH_NAMES.isExemptScratchName('reviewer-work', 'code-reviewer')).toBe(false)
    expect(VINAYA_SCRATCH_NAMES.isExemptScratchName('reviewer-scratch', 'developer')).toBe(false)
  })
})

describe('the protected-path policy — the one list the surface-scope check also reads', () => {
  it('answers exactly as isProtectedAdminPath does, for every listed path and a path under one', () => {
    for (const prefix of PROTECTED_ADMIN_PATHS) {
      const under = prefix.endsWith('/') ? `${prefix}x` : prefix
      expect(VINAYA_PROTECTED_PATHS.isProtected(under)).toBe(true)
      expect(VINAYA_PROTECTED_PATHS.isProtected(under)).toBe(isProtectedAdminPath(under))
    }
    expect(VINAYA_PROTECTED_PATHS.isProtected('apps/cli/src/lib/broker.ts')).toBe(false)
  })
  it('protects a disguised path once the broker has normalized it', () => {
    expect(VINAYA_PROTECTED_PATHS.isProtected(normalizeTouchedPath('../.github/workflows/ci.yml'))).toBe(true)
    expect(VINAYA_PROTECTED_PATHS.isProtected(normalizeTouchedPath('foo/../aeg-root/x'))).toBe(true)
  })
})

describe('the launch-record verifier — the role dispatch’s own launch records', () => {
  const deps: DispatchTeeRecoveryDeps = {
    env: {},
    listLaunchRecordPaths: () => ['launch-0.json'],
    readFile: () => JSON.stringify({ runId: 'run-1', role: 'developer', agent: 'claude', task: 7 })
  }
  it('matches only the exact (runId, role, task) triple a launch record names', () => {
    const verifier = vinayaLaunchRecordVerifier(deps)
    expect(verifier.matchesRun('run-1', 'developer', 7)).toBe(true)
    expect(verifier.matchesRun('run-1', 'developer', 8)).toBe(false)
    expect(verifier.matchesRun('run-1', 'code-reviewer', 7)).toBe(false)
    expect(verifier.matchesRun('run-2', 'developer', 7)).toBe(false)
  })
})

describe('the composition module — every builder’s policies from one place', () => {
  it('composes the broker from the protected-path policy, a launch-record verifier and the broker role facts', () => {
    const policies = vinayaBrokerPolicies()
    expect(policies.protectedPaths).toBe(VINAYA_PROTECTED_PATHS)
    expect(vinayaProtectedPathPolicy()).toBe(VINAYA_PROTECTED_PATHS)
    expect(policies.roles).toBe(VINAYA_BROKER_ROLES)
    expect(typeof policies.launchRecords.matchesRun).toBe('function')
  })
  it('composes the boundary, the tool grants and the router from the same role facts', () => {
    expect(vinayaWorkerBoundaryPolicies()).toEqual({ roles: VINAYA_BOUNDARY_ROLES, scratchNames: VINAYA_SCRATCH_NAMES })
    expect(vinayaToolGrantPolicy()).toBe(VINAYA_TOOL_GRANTS)
    expect(vinayaRouterPolicies()).toEqual({ roles: VINAYA_ROUTER_ROLES })
  })
})
