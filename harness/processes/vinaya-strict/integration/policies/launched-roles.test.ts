import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { launchedRoleName } from '@harness/kernel/dev-process-socket/loader/load-process'
import { DOCTRINE_MAP } from '../../tools/doctrine/doctrine-map'
import { VINAYA_LOG_ROLE_NAMES } from '../log/log-roles'
import { VINAYA_LAUNCHED_ROLES } from './launched-roles'
import { GRANTED_ROLES, VINAYA_BROKER_ROLES } from './roles'

describe('Vinaya launched roles', () => {
  test('the list equals the launched role folders process.yaml declares, in order', () => {
    const identity = parse(readFileSync(join(import.meta.dir, '../../process.yaml'), 'utf8')) as { roles: string[] }
    expect([...VINAYA_LAUNCHED_ROLES]).toEqual(identity.roles.map(launchedRoleName))
  })

  test('the Plan reviewer is launched and every site that lists roles lists it', () => {
    expect(VINAYA_LAUNCHED_ROLES).toContain('plan-reviewer')
    expect(VINAYA_LOG_ROLE_NAMES).toContain('plan-reviewer')
    expect(GRANTED_ROLES as readonly string[]).toContain('plan-reviewer')
    expect(VINAYA_BROKER_ROLES.recognizedRoles).toContain('plan-reviewer')
    expect(DOCTRINE_MAP.some((entry) => entry.role === 'plan-reviewer')).toBe(true)
  })
})
