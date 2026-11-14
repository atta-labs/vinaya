import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grantVariables } from './variables'
import { generateCodexConfig } from './codex/config'
import { generateClaudeSettings } from './claude-code/settings'
import { resolveRoleGrants } from './manifest'

describe('grantVariables', () => {
  test('resolves every placeholder to a real path for a git worktree', () => {
    const worktree = realpathSync(mkdtempSync(join(tmpdir(), 'grant-wt-')))
    execFileSync('git', ['init', '-q', worktree])
    const runDir = mkdtempSync(join(tmpdir(), 'grant-run-'))
    const vars = grantVariables(worktree, runDir)
    expect(Object.keys(vars).sort()).toEqual(['BUN_INSTALL_CACHE', 'GIT_COMMON_DIR', 'GIT_DIR', 'SCRATCH', 'WORKTREE'])
    expect(vars.WORKTREE).toBe(worktree)
    expect(vars.SCRATCH).toBe(join(runDir, 'scratch'))
    expect(existsSync(vars.SCRATCH as string)).toBe(true)
    expect(vars.GIT_COMMON_DIR).toBe(join(worktree, '.git'))
    expect(existsSync(vars.GIT_COMMON_DIR as string)).toBe(true)
    expect(vars.BUN_INSTALL_CACHE).toBeTruthy()
  })

  test('a worktree that does not exist yet falls back to <worktree>/.git', () => {
    const runDir = mkdtempSync(join(tmpdir(), 'grant-run-'))
    const missing = join(runDir, 'no-such-worktree')
    const vars = grantVariables(missing, runDir)
    expect(vars.GIT_DIR).toBeUndefined()
    expect(vars.WORKTREE).toBe(missing)
    expect(vars.GIT_COMMON_DIR).toBe(join(missing, '.git'))
    expect(existsSync(vars.SCRATCH as string)).toBe(true)
  })

  test('a worktree that does not exist yet takes the common directory of its repository', () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'grant-repo-')))
    execFileSync('git', ['init', '-q', repo])
    const runDir = mkdtempSync(join(tmpdir(), 'grant-run-'))
    const vars = grantVariables(join(repo, '.worktrees', 'task', 'issue-9'), runDir, repo)
    expect(vars.GIT_COMMON_DIR).toBe(join(repo, '.git'))
  })
})

test('a role writing its git dir resolves the exact linked git dir only after worktree creation', () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'grant-linked-')))
  execFileSync('git', ['init', '-q', repo])
  execFileSync('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '--allow-empty',
    '-qm',
    'init'
  ])
  const worktree = join(repo, 'task')
  const runDir = join(repo, 'run')
  // Grants defined inline: a role that writes its worktree, the repository's common git directory and its own.
  const grants = resolveRoleGrants({
    role: 'developer',
    models: { claude: 'process-supplied', codex: 'process-supplied' },
    capabilities: {
      read_files: 'allow',
      run_commands: { default: 'allow', allow: [], deny: [] },
      write_files: ['${WORKTREE}', '${SCRATCH}', '${GIT_COMMON_DIR}', '${GIT_DIR}'],
      network: [],
      web_fetch: 'deny',
      web_search: 'deny',
      subagents: 'deny',
      plan_tool: 'deny',
      view_image: 'deny'
    },
    mcp_tools: {},
    hooks: {
      background_shell: true,
      force_push: true,
      no_verify: true,
      default_branch_commit: true,
      write_scope: true
    },
    sandbox: 'enabled'
  })
  const paths = {
    outputSchema: {},
    generatedDir: runDir,
    outputSchemaPath: join(runDir, 'schema.json'),
    variables: grantVariables(worktree, runDir, repo)
  }
  const before = generateCodexConfig(grants, paths).files['config.toml']!
  expect(before).not.toContain('${GIT_DIR}')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-qb', 'task', worktree])
  paths.variables = grantVariables(worktree, runDir, repo)
  const gitDir = realpathSync(
    execFileSync('git', ['-C', worktree, 'rev-parse', '--absolute-git-dir'], { encoding: 'utf8' }).trim()
  )
  expect(paths.variables.GIT_DIR).toBe(gitDir)
  const config = generateCodexConfig(grants, paths).files['config.toml']!
  expect(JSON.parse(/writable_roots = (\[[^\n]*\])/.exec(config)![1]!)).toContain(gitDir)
  const claude = JSON.parse(generateClaudeSettings(grants, paths).files['role-settings.json']!)
  expect(claude.sandbox.filesystem.allowWrite).toContain(gitDir)
})
