import { describe, expect, it } from 'bun:test'
import { join } from 'node:path'
import { isOperatorGranted, OPERATOR_STATUS_FOLLOW, OPERATOR_TOOL_GRANT, TASK_TOOL_NAMES } from '@attalabs/aeg-core'
import { discoverRoleNames, renderAgentSkill, roleAllowedTools } from '../../src/lib/agents-skills-emitter.js'
import { refuseUngrantedTool } from '../../src/lib/task-tools/router.js'

/**
 * O2 — the Operator's grant is one fact with three representations that must
 * never drift: the role doc's `allowed-tools` frontmatter, the machine-
 * readable `OPERATOR_TOOL_GRANT`, and the generated skill's `allowed-tools`.
 * The router refuses any tool outside that one grant.
 */

// apps/cli/tests/lib -> repo root is four levels up.
const REAL_DOCTRINE_ROOT = join(import.meta.dir, '..', '..', '..', '..', 'aeg-root')

const EXPECTED_GRANT = [
  'task_start',
  'task_status',
  'task_escalation_read',
  'task_resume',
  'task_cancel',
  'task_status_follow'
]

// Tools an Operator must NEVER be able to reach — the seat's whole point is
// that holding the run button is not holding content or ratification
// authority. None of these is in the catalog's granted set.
const UNGRANTED = [
  'merge',
  'task_approve',
  'review_publish',
  'issue_edit',
  'Bash',
  'Edit',
  'Write',
  'gh',
  'task_plan',
  'task_start ' // a trailing-space near-miss is still not the granted name
]

describe('OPERATOR_TOOL_GRANT — the five task tools plus status follow, and nothing else', () => {
  it('is exactly the five catalog tools plus the status-follow read', () => {
    expect([...OPERATOR_TOOL_GRANT] as string[]).toEqual(EXPECTED_GRANT)
    expect(OPERATOR_TOOL_GRANT).toContain(OPERATOR_STATUS_FOLLOW)
    for (const name of TASK_TOOL_NAMES) expect(OPERATOR_TOOL_GRANT).toContain(name)
    // Six grants: five typed tools + one follow read. No more.
    expect(OPERATOR_TOOL_GRANT.length as number).toBe(TASK_TOOL_NAMES.length + 1)
  })

  it('isOperatorGranted admits every granted tool and refuses everything else', () => {
    for (const g of OPERATOR_TOOL_GRANT) expect(isOperatorGranted(g)).toBe(true)
    for (const u of UNGRANTED) expect(isOperatorGranted(u)).toBe(false)
  })
})

describe('refuseUngrantedTool — the router refuses any tool outside the grant (O2)', () => {
  it('returns null for every granted tool', () => {
    for (const g of OPERATOR_TOOL_GRANT) expect(refuseUngrantedTool(g)).toBeNull()
  })

  it('returns an authority error for every ungranted tool', () => {
    for (const u of UNGRANTED) {
      const err = refuseUngrantedTool(u)
      expect(err).not.toBeNull()
      expect(err?.kind).toBe('authority')
      expect(err?.message).toContain(u.trim() === u ? u : u) // names the offending tool
      // The refusal names the whole grant so the caller sees what it MAY reach.
      expect(err?.detail).toContain('task_status')
    }
  })

  it('refuses a merge — the ratification act the Operator never performs', () => {
    const err = refuseUngrantedTool('merge')
    expect(err?.kind).toBe('authority')
    expect(err?.message).toContain('merge')
  })
})

describe('the grant has one source of truth across all three surfaces (O2)', () => {
  it('the operator role doc discovers as a real, agent role', () => {
    const roles = discoverRoleNames(REAL_DOCTRINE_ROOT)
    expect(roles).toContain('operator')
  })

  it("operator.md's allowed-tools frontmatter equals OPERATOR_TOOL_GRANT", () => {
    expect(roleAllowedTools(REAL_DOCTRINE_ROOT, 'operator')).toEqual([...OPERATOR_TOOL_GRANT])
  })

  it('the generated skill carries the same allowed-tools grant', () => {
    const skill = renderAgentSkill('operator', null, roleAllowedTools(REAL_DOCTRINE_ROOT, 'operator'))
    expect(skill).toContain(`allowed-tools: ${EXPECTED_GRANT.join(', ')}`)
    expect(skill).toContain('name: vinaya-operator')
  })

  it('a role with no allowed-tools frontmatter renders the unchanged pointer (no grant line)', () => {
    // The Developer declares no grant, so its generated skill is byte-identical
    // to the pre-grant 3-line pointer — the change is additive only.
    expect(roleAllowedTools(REAL_DOCTRINE_ROOT, 'developer')).toEqual([])
    expect(renderAgentSkill('developer')).not.toContain('allowed-tools:')
  })
})
