import { join } from 'node:path'
import { generateClaudeSettings } from './claude-code/settings'
import { generateCodexConfig } from './codex/config'
import { loadRoleGrants, ROLE_NAMES } from './manifest'

if (!process.argv.includes('--dry-run')) throw new Error('Live agent launch is Principal-only; pass --dry-run')
const root = join(import.meta.dir, '../../../processes/vinaya/executing')
for (const role of ROLE_NAMES) {
  const grants = loadRoleGrants(join(root, role, 'grants.yaml'))
  const attempts = [
    ...Object.entries(grants.tools.builtins).map(([capability, decision]) => ({
      capability,
      decision,
      rule: `tools.builtins.${capability}`
    })),
    ...Object.keys(grants.hooks).map((hook) => ({ capability: hook, decision: 'deny', rule: `hooks.${hook}` }))
  ]
  const generated = [
    ['claude-code', generateClaudeSettings(grants, join(root, role, 'output.schema.json'))],
    ['codex', generateCodexConfig(grants, join(root, role, 'output.schema.json'))]
  ] as const
  for (const [vendor, output] of generated) {
    console.log(JSON.stringify({ vendor, role, command: output.launch, generatedFiles: output, attempts }))
  }
}
