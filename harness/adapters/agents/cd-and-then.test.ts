import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateClaudeSettings } from './claude-code/settings'
import { generateCodexConfig } from './codex/config'
import { loadRoleGrants } from './manifest'

const processRoot = join(import.meta.dir, '../../../processes/vinaya/executing')

function repository(branch: 'main' | 'task'): string {
  const directory = mkdtempSync(join(tmpdir(), `vinaya-cd-${branch}-`))
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
  const grants = loadRoleGrants(join(processRoot, 'developer/grants.yaml'))
  const outputSchema = JSON.parse(readFileSync(join(processRoot, 'developer/output.schema.json'), 'utf8'))
  const paths = {
    generatedDir: task,
    outputSchemaPath: 'output.schema.json',
    outputSchema,
    variables: {
      WORKTREE: task,
      SCRATCH: join(task, 'scratch'),
      BUN_INSTALL_CACHE: '/bun',
      GIT_COMMON_DIR: join(task, '.git')
    }
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
