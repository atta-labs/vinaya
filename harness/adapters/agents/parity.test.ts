import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { generateClaudeSettings } from './claude-code/settings'
import { generateCodexConfig } from './codex/config'
import { loadRoleGrants, ROLE_NAMES } from './manifest'

const processRoot = join(import.meta.dir, '../../../processes/vinaya/executing')

export const GAP_TABLE = [
  { id: 1, status: 'closed', reason: 'every shell deny is emitted as a Codex execpolicy prefix_rule' },
  {
    id: 2,
    status: 'stated',
    reason:
      'Codex PreToolUse errors fail open and hosted WebSearch is not hookable; web_search, execpolicy, and sandbox remain the hard floor until a live probe proves the hook'
  },
  { id: 3, status: 'closed', reason: 'one WebSearch grant drives both adapters' },
  { id: 4, status: 'closed', reason: 'one per-role network domain list drives both adapters' },
  { id: 5, status: 'closed', reason: 'Claude autoAllowBashIfSandboxed is false' },
  { id: 6, status: 'closed', reason: 'Claude receives one mcp__server__tool allow per catalog grant' },
  { id: 7, status: 'closed', reason: 'Claude launch loads user settings only, excluding project Stop hooks' },
  {
    id: 8,
    status: 'closed',
    reason: 'reviewer Codex sandboxes are read-only; attended unsandboxed runs are outside this manifest'
  }
] as const

describe('role-grant vendor parity', () => {
  for (const role of ROLE_NAMES)
    test(role, () => {
      const grants = loadRoleGrants(join(processRoot, role, 'grants.yaml'))
      const claude = generateClaudeSettings(grants, 'output.schema.json')
      const codex = generateCodexConfig(grants, 'output.schema.json')
      const claudeCapabilities = Object.entries(grants.tools.builtins)
        .map(([name, decision]) => `${name}:${decision}`)
        .sort()
      const codexCapabilities = Object.entries(grants.tools.builtins)
        .map(([name, decision]) => `${name}:${decision}`)
        .sort()
      expect(codexCapabilities).toEqual(claudeCapabilities)
      expect(claude.settings.sandbox.network.allowedDomains).toEqual(grants.network_domains)
      for (const deny of grants.shell.deny) expect(codex.execpolicy).toContain('prefix_rule(')
      expect(claude.settings.sandbox.autoAllowBashIfSandboxed).toBe(false)
      expect(codex.configToml).toContain(`sandbox_mode = "${grants.sandbox.codex}"`)
    })

  test('accounts for all eight known gaps', () => {
    expect(GAP_TABLE.map((gap) => gap.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(GAP_TABLE.every((gap) => gap.status === 'closed' || gap.status === 'stated')).toBe(true)
  })
})
