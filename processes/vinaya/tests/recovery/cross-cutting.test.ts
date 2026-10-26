import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateCodexConfig } from '../../../../harness/adapters/agents/codex/config'
import { loadRoleGrants, ROLE_NAMES } from '../../../../harness/adapters/agents/manifest'
import { ENGINE_RUNNERS } from './runners'

// Owner: the coordinator. Cases that cross the agents' areas, added as each part is merged.

const EXECUTING = join(import.meta.dir, '../../executing')

describe.each(ENGINE_RUNNERS)('%s', () => {
  // A Codex role whose dev-tools bridge cannot start must fail its own start, not run without publish or checks.
  for (const role of ROLE_NAMES)
    test(`a Codex ${role} launch requires its dev-tools server`, () => {
      const generated = generateCodexConfig(loadRoleGrants(join(EXECUTING, role, 'grants.yaml')), {
        generatedDir: `/gen/${role}`,
        outputSchemaPath: `/schema/${role}.json`,
        outputSchema: JSON.parse(readFileSync(join(EXECUTING, role, 'output.schema.json'), 'utf8')),
        mcpCommand: '/bridge',
        variables: { WORKTREE: '/wt', SCRATCH: '/scratch', BUN_INSTALL_CACHE: '/bun', GIT_COMMON_DIR: '/git' }
      })
      const settings = Bun.TOML.parse(generated.files['config.toml'] as string)
      expect(settings).toHaveProperty('mcp_servers.vinaya_dev_tools.required', true)
    })

  test.todo('a Developer launch that ended before binding its session dispatches fresh')
  test.todo('quota exhaustion during a test run is reported and the run recovers')
  test.todo('a crash after an effect and before its acknowledgement repeats no effect')
})
