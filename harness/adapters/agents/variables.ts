import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * The real paths behind the `${...}` placeholders a role's grants file names:
 * the task worktree, a per-run scratch directory (created here), the Bun
 * install cache and the worktree's git common directory. A worktree that does
 * not exist yet (a run computes these before it creates the worktree) shares
 * its repository's common directory, so `repoRoot` answers for it; only when
 * neither can be read does it fall back to `<worktree>/.git`.
 */
export function grantVariables(worktreePath: string, runDir: string, repoRoot?: string): Record<string, string> {
  const scratch = join(runDir, 'scratch')
  mkdirSync(scratch, { recursive: true })
  const commonDirOf = (cwd: string): string | null => {
    try {
      const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      })
      return resolve(cwd, out.trim())
    } catch {
      return null
    }
  }
  const gitCommonDir =
    commonDirOf(worktreePath) ?? (repoRoot ? commonDirOf(repoRoot) : null) ?? join(worktreePath, '.git')
  return {
    WORKTREE: worktreePath,
    SCRATCH: scratch,
    BUN_INSTALL_CACHE: process.env.BUN_INSTALL_CACHE_DIR ?? join(homedir(), '.bun', 'install', 'cache'),
    GIT_COMMON_DIR: gitCommonDir
  }
}
