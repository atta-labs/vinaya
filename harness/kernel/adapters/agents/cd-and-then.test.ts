import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateClaudeSettings } from './claude-code/settings'
import { generateCodexConfig } from './codex/config'
import { type RoleContract, resolveRoleGrants } from './manifest'

// The grants here are defined inline: a role whose shell runs anything not denied, that writes its worktree and
// scratch directory, and whose hooks refuse a commit on the default branch. A process proves its own grants files
// through the same hooks in its own tests.
const WRITER: RoleContract = {
  role: 'developer',
  models: { claude: 'process-supplied', codex: 'process-supplied' },
  capabilities: {
    read_files: 'allow',
    run_commands: { default: 'allow', allow: [], deny: ['git push', 'gh'] },
    write_files: ['${WORKTREE}', '${SCRATCH}'],
    network: ['example.com'],
    web_fetch: 'deny',
    web_search: 'deny',
    subagents: 'deny',
    plan_tool: 'allow',
    view_image: 'allow'
  },
  mcp_tools: { tools: ['read_source'] },
  hooks: { background_shell: true, force_push: true, no_verify: true, default_branch_commit: true, write_scope: true },
  sandbox: 'enabled'
}
const READER: RoleContract = {
  ...WRITER,
  capabilities: { ...WRITER.capabilities, run_commands: 'deny', write_files: 'deny' }
}

function repository(branch: 'main' | 'task'): string {
  const directory = mkdtempSync(join(tmpdir(), `cd-and-then-${branch}-`))
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', directory, ...args])
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  }
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'probe@example.invalid')
  git('config', 'user.name', 'Probe')
  writeFileSync(join(directory, 'tracked'), 'x')
  git('add', 'tracked')
  git('commit', '-q', '-m', 'initial')
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main')
  if (branch === 'task') git('checkout', '-q', '-b', 'task')
  return directory
}

// A session started in the repository's main checkout changes into the task worktree before running git.
describe('a git command after `cd <worktree> &&` is judged in the worktree alone', () => {
  const main = repository('main')
  const task = repository('task')
  const grants = resolveRoleGrants(WRITER)
  const paths = {
    generatedDir: task,
    outputSchemaPath: 'output.schema.json',
    outputSchema: {},
    variables: { WORKTREE: task, SCRATCH: join(task, 'scratch') }
  }
  for (const vendor of ['claude', 'codex'] as const) {
    const config = vendor === 'claude' ? generateClaudeSettings(grants, paths) : generateCodexConfig(grants, paths)
    const hook = join(task, `${vendor}-hook.mjs`)
    writeFileSync(hook, config.files['hooks/pre-tool-use.mjs'] ?? '')
    const decide = (command: string) =>
      Bun.spawnSync(['node', hook], {
        cwd: main,
        stdin: Buffer.from(JSON.stringify({ tool_name: 'Bash', cwd: main, tool_input: { command } }))
      }).stdout.toString()

    test(`${vendor}: \`cd <task> && git merge\` is not a default-branch operation`, () => {
      expect(decide(`cd ${task} && git merge --no-commit origin/main`)).not.toContain('on the default branch')
    })

    test(`${vendor}: \`cd <task>; git commit\` may still run on main, and is denied`, () => {
      expect(decide(`cd ${task}; git commit -m x`)).toContain('on the default branch')
    })
  }
})

describe('a role that writes its scratch directory keeps npm cache there', () => {
  const paths = {
    generatedDir: '/gen',
    outputSchemaPath: 'x.json',
    outputSchema: {},
    variables: { WORKTREE: '/wt', SCRATCH: '/scratch' }
  }
  test('both vendors launch a role writing its scratch directory with npm_config_cache there', () => {
    const grants = resolveRoleGrants(WRITER)
    expect(generateClaudeSettings(grants, paths).env).toEqual({
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      npm_config_cache: '/scratch/npm-cache'
    })
    expect(generateCodexConfig(grants, paths).env.npm_config_cache).toBe('/scratch/npm-cache')
  })
  test('a role that writes nowhere gets no cache setting', () => {
    const reader = resolveRoleGrants(READER)
    expect(generateClaudeSettings(reader, paths).env).toEqual({ ENABLE_CLAUDEAI_MCP_SERVERS: 'false' })
    expect(generateCodexConfig(reader, paths).env.npm_config_cache).toBeUndefined()
  })
})
