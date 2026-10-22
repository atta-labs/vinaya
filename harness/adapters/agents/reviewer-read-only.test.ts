import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateClaudeSettings } from './claude-code/settings'
import { generateCodexConfig } from './codex/config'
import { loadRoleGrants } from './manifest'
import type { GeneratedAgentConfig } from './policy'

// A reviewer's shell is read-only twice over: by its sandbox (no writable path) and by its rules (reading
// commands only, their write-capable forms refused). These run the generated hooks, as the agents do.
const processRoot = join(import.meta.dir, '../../../processes/vinaya/executing')
const WRITE_FORMS = [
  'find . -name x -exec rm {} ;',
  'find . -execdir touch y ;',
  'find . -ok rm {} ;',
  'find . -delete',
  'find . -fprint /tmp/out',
  'find . -fprintf /tmp/out %p',
  'find . -fls /tmp/out',
  'git diff --output=/tmp/out',
  'git diff HEAD --output /tmp/out',
  'git diff --ext-diff',
  'git diff --textconv',
  'git log -p --output=/tmp/out',
  'git show HEAD --ext-diff',
  'git -c core.pager=touch status',
  'sed -n -i s/a/b/ file',
  'sed -n --in-place s/a/b/ file',
  'sed -n -Ei s/a/b/ file',
  'sed -n 1w/tmp/x file',
  "sed -n '1e touch y' file",
  'sed -n 1,20p file',
  'cat README.md > /tmp/x',
  'cat a >/tmp/x',
  'tail -n1 f >> /tmp/out',
  'grep -r x . > /tmp/out',
  '(cat a > b)',
  'cat a &> /tmp/out',
  'cat a 2> /tmp/err',
  "rg --pre 'sh -c touch' x",
  'git push origin HEAD',
  'gh pr comment 1 -b x',
  'touch file',
  'echo x > file'
]
const READS = [
  'cat README.md',
  'rg -n foo src',
  'git diff HEAD~1',
  'find . -name "*.ts"',
  'head -n 20 file',
  'ls -la',
  // Not a file write: a descriptor duplication, the null device, a quoted '>'.
  'rg -n foo src 2>&1',
  'cat a 2>/dev/null',
  "grep -n '>' file"
]

for (const role of ['code-reviewer', 'security-reviewer'] as const) {
  const grants = loadRoleGrants(join(processRoot, role, 'grants.yaml'))
  const workspace = mkdtempSync(join(tmpdir(), `reviewer-${role}-`))
  const paths = {
    generatedDir: workspace,
    outputSchemaPath: join(processRoot, role, 'output.schema.json'),
    outputSchema: JSON.parse(readFileSync(join(processRoot, role, 'output.schema.json'), 'utf8')),
    variables: { WORKTREE: workspace }
  }
  const configs: Record<'claude' | 'codex', GeneratedAgentConfig> = {
    claude: generateClaudeSettings(grants, paths),
    codex: generateCodexConfig(grants, paths)
  }
  const hookPath = (vendor: 'claude' | 'codex') => {
    const path = join(workspace, `${vendor}-hook.mjs`)
    writeFileSync(path, configs[vendor].files['hooks/pre-tool-use.mjs'] ?? '')
    return path
  }
  const hooks = { claude: hookPath('claude'), codex: hookPath('codex') }
  const decide = (vendor: 'claude' | 'codex', tool: string, input: Record<string, unknown>) => {
    const out = Bun.spawnSync(['node', hooks[vendor]], {
      cwd: workspace,
      stdin: Buffer.from(JSON.stringify({ tool_name: tool, tool_input: input }))
    }).stdout.toString()
    return out.includes('"permissionDecision":"deny"') ? 'deny' : 'allow'
  }

  describe(`${role}: read-only by sandbox and by rules`, () => {
    test('no vendor sandbox has a writable path, and no write tool is granted', () => {
      const settings = JSON.parse(configs.claude.files['role-settings.json'] as string)
      expect(settings.sandbox.enabled).toBe(true)
      expect(settings.sandbox.filesystem.allowWrite).toEqual([])
      for (const tool of ['Write', 'Edit', 'NotebookEdit', 'Bash']) expect(settings.permissions.deny).toContain(tool)
      const toml = configs.codex.files['config.toml'] as string
      expect(toml).toContain('sandbox_mode = "read-only"')
      expect(toml).toContain('writable_roots = []')
      expect(grants.tools.codex.apply_patch).toBe('deny')
    })

    test('writing a file through the write tools is refused on both vendors', () => {
      expect(decide('claude', 'Write', { file_path: join(workspace, 'x'), content: 'x' })).toBe('deny')
      expect(decide('claude', 'Edit', { file_path: join(workspace, 'x') })).toBe('deny')
      expect(
        decide('codex', 'apply_patch', {
          command: `*** Begin Patch\n*** Add File: ${join(workspace, 'x')}\n+x\n*** End Patch`
        })
      ).toBe('deny')
    })

    for (const command of WRITE_FORMS)
      test(`refuses \`${command}\` on both vendors`, () => {
        expect(decide('claude', 'Bash', { command })).toBe('deny')
        expect(decide('codex', 'Bash', { command })).toBe('deny')
      })

    test("the Codex reviewer's reading commands still run", () => {
      expect(READS.filter((command) => decide('codex', 'Bash', { command }) !== 'allow')).toEqual([])
    })
  })
}
