import { guardedSpawnSync } from './guarded-spawn'

/** What one program run returned. */
export interface CliRun {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * Runs the program at `program` with `args` in `cwd`, under this process's own
 * runtime (`process.execPath`), `env` merged over this process's environment.
 * The program is named explicitly, never read from `process.argv`, so a runner
 * that is not itself the program still runs it. The child gets this
 * process's whole environment: it is the runner's own program (a gate, a
 * report), never an agent, so the agent allowlist does not apply to it.
 * It runs under `guardedSpawnSync`, so it ends when this process does.
 */
export function runCli(
  program: string,
  cwd: string,
  args: readonly string[],
  env: Record<string, string> = {}
): CliRun {
  const res = guardedSpawnSync(process.execPath, [program, ...args], {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/**
 * Runs the checks program at `program` with `args` (the caller names both) and
 * the worktree as cwd, so it judges the branch's code; `env` carries the
 * pull-request variables the PR-body checks read.
 */
export async function runCliChecks(
  program: string,
  worktreePath: string,
  env: Record<string, string>,
  args: readonly string[]
): Promise<{ passed: boolean; output: string }> {
  const res = runCli(program, worktreePath, args, env)
  return { passed: res.status === 0, output: `${res.stdout}${res.stderr}` }
}
