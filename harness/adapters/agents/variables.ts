import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The real paths behind the `${...}` placeholders a role's grants file names:
 * the task worktree, a per-run scratch directory (created here), the Bun
 * install cache and the worktree's git common directory. A worktree git
 * cannot read (or that does not exist yet) falls back to `<worktree>/.git`.
 */
export function grantVariables(worktreePath: string, runDir: string): Record<string, string> {
  const scratch = join(runDir, 'scratch')
  mkdirSync(scratch, { recursive: true })
  let gitCommonDir = join(worktreePath, '.git')
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: worktreePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    gitCommonDir = resolve(worktreePath, out.trim())
  } catch {}
  return {
    WORKTREE: worktreePath,
    SCRATCH: scratch,
    BUN_INSTALL_CACHE: process.env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), '.bun', 'install', 'cache'),
    GIT_COMMON_DIR: gitCommonDir
  }
}
