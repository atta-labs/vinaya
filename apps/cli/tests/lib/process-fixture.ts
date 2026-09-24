/**
 * Issue #660, O3 — the shared implementation of both isolation halves every
 * real-process test fixture under `apps/cli/tests` needs: this process's own
 * `VINAYA_*` environment (most importantly `VINAYA_RUNTIME_DIR`, checked
 * first, unconditionally, by `resolveRuntimeDirUncached`, ahead of `$HOME`
 * entirely) must never leak into a spawned child no matter how carefully the
 * child's own `$HOME` is isolated — the exact incident this task closes: a
 * dispatched Developer/Reviewer session's own environment redirecting every
 * fixture's driver subprocess to this MACHINE's real, shared runtime
 * directory, racing its driver lock and control-store files against every
 * other concurrent task run. And a genuinely stuck child (lock contention on
 * a path another fixture or another concurrent run still holds) must be
 * killed at an explicit, per-test budget and fail with the child's own
 * captured stdout/stderr, never a bare test-framework timeout with no
 * diagnostic at all.
 *
 * First landed inline, duplicated per file (`dev-review-loop.test.ts`,
 * `dispatch.test.ts`, and siblings); this is the one shared module those
 * duplicates were always meant to become. Round 5's architecture test
 * (`apps/cli/tests/process-fixture-coverage.test.ts`) is the mechanical
 * backstop: a file that spawns a real process and neither imports from here
 * nor appears on that test's grandfather list fails the build.
 */

import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'node:child_process'

/**
 * A copy of `env` (defaulting to this process's own) with every `VINAYA_*`
 * key removed, plus `GITHUB_ACTIONS` — the CI-runner flag that, left in
 * place, makes the child's own `log()` resolve its destination to `'ci'`
 * with no delivery credential configured, i.e. `'none'` (`log-sink.ts`'s
 * `resolveLogDestination`), so a fixture that spawns a real subprocess and
 * then polls its outbox for a landed log line times out on a CI runner
 * (this process's real `GITHUB_ACTIONS` leaking into the child) while
 * passing on a laptop. The same leak #721 fixed for the in-process loop
 * harness's `withWorldEnv`, here for every real-subprocess fixture that
 * shares this helper. `AEG_REPO`/`GITHUB_REPOSITORY` are deliberately left
 * alone — unlike the in-process harness, these subprocess fixtures run with
 * a real `cwd` and depend on the real repo-identity short-circuit those two
 * still provide.
 */
export function stripVinayaEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env }
  for (const key of Object.keys(out)) {
    if (key.startsWith('VINAYA_')) delete out[key]
  }
  delete out.GITHUB_ACTIONS
  return out
}

/**
 * Generous on a quiet host and below `bun:test`'s own default per-test
 * timeout, so a genuinely stuck subprocess is caught HERE, with its own
 * captured output, before a bare framework timeout can kill the run with no
 * diagnostic at all.
 */
export const PROCESS_FIXTURE_BUDGET_MS = 18_000

export type BudgetedSpawnResult = { status: number; stdout: string; stderr: string }

/**
 * Runs `command` with `args` under an explicit `budgetMs` (SIGKILL past it),
 * throwing with the budget figure plus the child's own captured
 * stdout/stderr when it's exceeded. `options.env` is the caller's own
 * responsibility to compose (typically `{ ...stripVinayaEnv(), HOME, PATH }`)
 * — this wraps the budget/diagnostic half of the pattern only.
 */
export function spawnSyncBudgeted(
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
  budgetMs: number = PROCESS_FIXTURE_BUDGET_MS,
  label: string = command
): BudgetedSpawnResult {
  const r = spawnSync(command, args, { ...options, timeout: budgetMs, killSignal: 'SIGKILL' })
  if (r.signal) {
    throw new Error(
      `${label} subprocess killed by ${r.signal} after exceeding its ${budgetMs}ms budget ` +
        `(args: ${args.join(' ')})\n--- stdout ---\n${r.stdout ?? ''}\n--- stderr ---\n${r.stderr ?? ''}`
    )
  }
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

/**
 * The `Bun.spawn` (async) equivalent of `spawnSyncBudgeted` — `Bun.spawn`
 * has no built-in `timeout`/`killSignal`, so the budget is a manual timer
 * that kills the child and marks it timed-out; the child's stdout/stderr
 * are always drained through `Response` before the diagnostic is thrown, so
 * a genuine timeout still surfaces whatever the child had already written.
 */
export async function spawnBudgetedAsync(
  command: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> },
  budgetMs: number = PROCESS_FIXTURE_BUDGET_MS,
  label: string = command[0] ?? 'spawn'
): Promise<BudgetedSpawnResult> {
  const proc = Bun.spawn(command, { ...options, stdout: 'pipe', stderr: 'pipe' })
  const timedOut = { value: false }
  const timer = setTimeout(() => {
    timedOut.value = true
    proc.kill('SIGKILL')
  }, budgetMs)
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const status = await proc.exited
  clearTimeout(timer)
  if (timedOut.value) {
    throw new Error(
      `${label} subprocess killed by SIGKILL after exceeding its ${budgetMs}ms budget ` +
        `(command: ${command.join(' ')})\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
    )
  }
  return { status, stdout, stderr }
}
