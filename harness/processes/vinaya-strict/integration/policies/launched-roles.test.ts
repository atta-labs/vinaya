import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { launchedRoleName } from '../../../../kernel/dev-process-socket/loader/load-process'
import { VINAYA_LAUNCHED_ROLES } from './launched-roles'

describe('Vinaya launched roles', () => {
  test('the list equals the launched role folders process.yaml declares, in order', () => {
    const identity = parse(readFileSync(join(import.meta.dir, '../../process.yaml'), 'utf8')) as { roles: string[] }
    expect([...VINAYA_LAUNCHED_ROLES]).toEqual(identity.roles.map(launchedRoleName))
  })
})
