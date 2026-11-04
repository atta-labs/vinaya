import { describe, expect, it } from 'bun:test'
import { OPERATOR_TOOL_GRANT } from '@attalabs/aeg-core'
import { ROLE_VALUES } from '../../../../../kernel/log/schema'
import { DEV_TOOL_NAMES } from '../../../../../kernel/tools/dev-tools-server.js'
import { isToolGranted } from '../../../../../kernel/tools/role-grants.js'
import { AGENT_TOOL_CATALOG } from '../../../../../kernel/tools/tool-catalog.js'
import {
  GRANTED_ROLES,
  ROLE_TOOL_GRANTS,
  VINAYA_BOUNDARY_ROLES,
  VINAYA_BROKER_ROLES,
  VINAYA_ROUTER_ROLES
} from '../../../integration/policies/roles.js'
import { vinayaToolGrantPolicy } from '../../../integration/policies/vinaya-policies.js'

/**
 * Vinaya's role facts — the grant table, and the role names the broker, the
 * per-turn worker boundary and the task-tool router read through their
 * policies. The enforcement each one runs over these facts is tested with
 * its kernel owner, against synthetic role labels.
 */

describe('ROLE_TOOL_GRANTS — the one grant table', () => {
  it('grants the Developer exactly the seven Developer tools', () => {
    expect(ROLE_TOOL_GRANTS.developer).toHaveLength(7)
    expect([...ROLE_TOOL_GRANTS.developer].sort()).toEqual([...DEV_TOOL_NAMES].sort())
  })
  it('grants the code and security reviewers read_source only', () => {
    expect(ROLE_TOOL_GRANTS['code-reviewer']).toEqual(['read_source'])
    expect(ROLE_TOOL_GRANTS.security).toEqual(['read_source'])
  })
  it('grants the controller nothing', () => {
    expect(ROLE_TOOL_GRANTS.controller).toEqual([])
  })
  it('names no Operator tool and no Operator role', () => {
    expect(GRANTED_ROLES as readonly string[]).not.toContain('operator')
    const granted = Object.values(ROLE_TOOL_GRANTS).flat()
    for (const tool of OPERATOR_TOOL_GRANT) expect(granted).not.toContain(tool)
  })
  it('every granted tool is a catalog entry', () => {
    const catalog = AGENT_TOOL_CATALOG.map((t) => t.name)
    for (const tool of Object.values(ROLE_TOOL_GRANTS).flat()) expect(catalog).toContain(tool)
  })
  it('a role outside the table is granted nothing', () => {
    expect(isToolGranted(vinayaToolGrantPolicy(), 'operator', 'run_checks')).toBe(false)
    expect(isToolGranted(vinayaToolGrantPolicy(), 'planner', 'read_source')).toBe(false)
  })
  it('an annotation never grants: a read-only Developer tool is still not a reviewer’s', () => {
    const readPr = AGENT_TOOL_CATALOG.find((t) => t.name === 'read_pull_request')
    expect(readPr?.annotations.readOnlyHint).toBe(true)
    expect(isToolGranted(vinayaToolGrantPolicy(), 'code-reviewer', 'read_pull_request')).toBe(false)
    expect(isToolGranted(vinayaToolGrantPolicy(), 'security', 'read_pull_request')).toBe(false)
  })
})

describe("the broker's role facts", () => {
  it('recognizes exactly the Log role vocabulary', () => {
    expect([...VINAYA_BROKER_ROLES.recognizedRoles]).toEqual([...ROLE_VALUES])
  })
  it('maps only the Developer to the Worker grant', () => {
    expect([...VINAYA_BROKER_ROLES.workerRoles]).toEqual(['developer'])
  })
  it('sends a protected path to the Planner', () => {
    expect(VINAYA_BROKER_ROLES.surfaceOwner).toBe('the Planner')
  })
})

describe("the per-turn boundary's role facts", () => {
  it('parses the sessions area with code-reviewer ahead of its own first segment', () => {
    expect([...VINAYA_BOUNDARY_ROLES.sessionRoles]).toEqual(['code-reviewer', 'developer', 'security'])
  })
  it('names each role’s round directory: the Developer’s exactly, each reviewer’s with its attempt suffixes', () => {
    expect(VINAYA_BOUNDARY_ROLES.roundDirectory('developer')).toEqual({ name: 'developer', suffixed: false })
    expect(VINAYA_BOUNDARY_ROLES.roundDirectory('code-reviewer')).toEqual({ name: 'reviewer-work', suffixed: true })
    expect(VINAYA_BOUNDARY_ROLES.roundDirectory('security')).toEqual({ name: 'security-work', suffixed: true })
  })
  it('pairs the code and security reviewers as concurrent siblings, and nothing else', () => {
    expect(VINAYA_BOUNDARY_ROLES.concurrentSibling('code-reviewer')).toBe('security')
    expect(VINAYA_BOUNDARY_ROLES.concurrentSibling('security')).toBe('code-reviewer')
    expect(VINAYA_BOUNDARY_ROLES.concurrentSibling('developer')).toBeNull()
  })
})

describe("the router's role facts", () => {
  it('grants the Operator exactly OPERATOR_TOOL_GRANT and names the Planner or Principal for anything else', () => {
    expect([...VINAYA_ROUTER_ROLES.grantedTools]).toEqual([...OPERATOR_TOOL_GRANT])
    expect(VINAYA_ROUTER_ROLES.seat).toBe('the Operator')
    expect(VINAYA_ROUTER_ROLES.askedOf).toBe('the Planner or Principal')
  })
})
