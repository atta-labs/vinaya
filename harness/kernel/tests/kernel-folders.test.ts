import { expect, test } from 'bun:test'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const folders = [
  'config/schema',
  'config/loader',
  'loops/runtimes/atta-engine',
  'adapters/agents',
  'adapters/agents/claude-code',
  'adapters/agents/codex',
  'adapters/code-host/github',
  'adapters/tracker/github-issues',
  'connectors/git',
  'connectors/checkpoint/control-store',
  'tools/host',
  'tools/catalog',
  'gates/checks',
  'gates/ring0-hooks',
  'gates/ring1-ci/workflows',
  'gates/ring2-audits',
  'conformance/unit',
  'conformance/live-matrix'
]
test('each implemented kernel subsystem has files in its target folder', () => {
  for (const folder of folders) expect(readdirSync(join(import.meta.dir, '..', folder)).length).toBeGreaterThan(0)
})
