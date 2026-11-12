import { describe, expect, it } from 'bun:test'
import { ROLE_VALUES } from '../../../../../kernel/log/schema'
import { DEV_TOOL_NAMES } from '../../../../../kernel/tools/dev-tools-server.js'
import { isToolGranted } from '../../../../../kernel/tools/role-grants.js'
import { AGENT_TOOL_CATALOG } from '../../../../../kernel/tools/tool-catalog.js'
import {
  OPERATOR_SEAT,
  PLANNER_SEAT,
  ARCHITECT_SEAT,
  TRANCHE_ARCHIVIST_SEAT,
  createTaskToolsMcpServer
} from '../../../integration/server.js'
import { ARCHITECT_TOOL_GRANT, TRANCHE_ARCHIVIST_TOOL_GRANT } from '../../../integration/policies/roles.js'
import { PLANNER_TOOL_NAMES } from '../../../thinking/planner/tools/planner-tools.js'
import {
  GRANTED_ROLES,
  OPERATOR_TOOL_GRANT,
  PLANNER_TOOL_GRANT,
  ROLE_TOOL_GRANTS,
  VINAYA_PLANNER_ROUTER_ROLES,
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
  it('the Operator grant lives in this role policy as exactly the six task tools', () => {
    expect([...OPERATOR_TOOL_GRANT]).toEqual([
      'task_start',
      'task_status',
      'task_escalation_read',
      'task_pr_read',
      'task_resume',
      'task_cancel'
    ])
  })
})

describe("the Planner seat's grant", () => {
  const PLANNER_TOOLS: string[] = [
    'task_issue_create',
    'task_issue_edit',
    'task_issue_surface',
    'task_objectives_edit',
    'brief_render',
    'task_issue_validate'
  ]
  const list = async (seat: string | null) => {
    const server = createTaskToolsMcpServer({ serverVersion: '0.0.0-test', seat })
    const line = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
    return (JSON.parse(line ?? '{}').result?.tools ?? []).map((t: { name: string }) => t.name) as string[]
  }
  const call = async (seat: string | null, name: string) => {
    const server = createTaskToolsMcpServer({ serverVersion: '0.0.0-test', seat })
    const line = await server.handleLine(
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: {} } })
    )
    return JSON.parse(line ?? '{}').result
  }

  it('is exactly the six Planner tools, the catalog tool names bound to the grant', () => {
    expect([...PLANNER_TOOL_GRANT] as string[]).toEqual(PLANNER_TOOLS)
    expect([...PLANNER_TOOL_NAMES] as string[]).toEqual(PLANNER_TOOLS)
    expect(VINAYA_PLANNER_ROUTER_ROLES.seat).toBe('the Planner')
  })
  it('serves exactly the six on the Planner seat', async () => {
    expect(await list(PLANNER_SEAT)).toEqual(PLANNER_TOOLS)
  })
  it('leaves the Operator seat serving exactly its six task tools', async () => {
    expect(await list(OPERATOR_SEAT)).toEqual([...OPERATOR_TOOL_GRANT])
    expect(await list(null)).toEqual([...OPERATOR_TOOL_GRANT])
  })
  it('refuses a Planner tool called on the Operator seat', async () => {
    for (const tool of PLANNER_TOOLS) expect((await call(OPERATOR_SEAT, tool)).isError).toBe(true)
  })
  it('refuses an Operator tool called on the Planner seat', async () => {
    for (const tool of OPERATOR_TOOL_GRANT) expect((await call(PLANNER_SEAT, tool)).isError).toBe(true)
  })
  it('refuses a tool outside both catalogs on the Planner seat', async () => {
    expect((await call(PLANNER_SEAT, 'merge')).isError).toBe(true)
  })
})

describe('Milestone seat isolation', () => {
  const grants = {
    [OPERATOR_SEAT]: [...OPERATOR_TOOL_GRANT],
    [PLANNER_SEAT]: [...PLANNER_TOOL_GRANT],
    [ARCHITECT_SEAT]: [
      'milestone_create',
      'milestone_edit',
      'milestone_delete',
      'milestone_adopt',
      'milestone_status',
      'milestone_close'
    ],
    [TRANCHE_ARCHIVIST_SEAT]: ['milestone_status', 'milestone_close']
  }
  it('grants exactly six to the Architect and two to the Tranche Archivist', () => {
    expect([...ARCHITECT_TOOL_GRANT] as string[]).toEqual(grants[ARCHITECT_SEAT])
    expect([...TRANCHE_ARCHIVIST_TOOL_GRANT] as string[]).toEqual(grants[TRANCHE_ARCHIVIST_SEAT])
  })
  for (const [seat, grant] of Object.entries(grants)) {
    it(`${seat} serves exactly its grant and refuses every other seat tool`, async () => {
      const server = createTaskToolsMcpServer({ serverVersion: 'test', seat })
      const listed = await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }))
      expect(JSON.parse(listed ?? '{}').result.tools.map((t: { name: string }) => t.name)).toEqual(grant)
      for (const name of new Set([...Object.values(grants).flat(), 'merge', 'shell'])) {
        if (grant.includes(name as never)) continue
        const response = await server.handleLine(
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: {} } })
        )
        expect(JSON.parse(response ?? '{}').result.isError).toBe(true)
      }
    })
  }
})
