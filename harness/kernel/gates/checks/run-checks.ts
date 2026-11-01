import { guardedSpawnSync } from './guarded-spawn'

/** What one CLI run returned. */
export interface CliRun {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * Runs the CLI at `cliEntry` with `args` in `cwd`, under this process's own
 * runtime (`process.execPath`), `env` merged over this process's environment.
 * The entry is named explicitly, never read from `process.argv`, so a runner
 * that is not itself the CLI still runs the CLI. The child gets this
 * process's whole environment: it is the runner's own command (a gate, a
 * report), never an agent, so the agent allowlist does not apply to it.
 * It runs under `guardedSpawnSync`, so it ends when this process does.
 */
export function runCli(
  cliEntry: string,
  cwd: string,
  args: readonly string[],
  env: Record<string, string> = {}
): CliRun {
  const res = guardedSpawnSync(process.execPath, [cliEntry, ...args], {
    cwd,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024
  })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

/**
 * Runs `check --all` from the CLI at `cliEntry` with the worktree as cwd, so
 * it judges the branch's code; `env` carries the pull-request variables the
 * PR-body checks read.
 */
export async function runCliChecks(
  cliEntry: string,
  worktreePath: string,
  env: Record<string, string>
): Promise<{ passed: boolean; output: string }> {
  const res = runCli(cliEntry, worktreePath, ['check', '--all'], env)
  return { passed: res.status === 0, output: `${res.stdout}${res.stderr}` }
}
