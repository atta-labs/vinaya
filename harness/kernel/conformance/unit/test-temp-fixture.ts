import { spawn } from 'node:child_process'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { PROCESS_FIXTURE_BUDGET_MS, stripVinayaEnv } from './process-fixture'
import {
  claimTestTempRun,
  createTestTempRun,
  makeFixtureDir,
  type SweepReport,
  sweepAbandoned,
  type TestTempRun
} from './test-temp'

// One test process's heavy-fixture storage: a run directory on disk (see `test-temp.ts`), created on first use and
// removed by the test preload once every test file has run.

/** The repository id this repository's tests file their run directories under. */
export const TEST_TEMP_REPO_ID = 'vinaya'

let run: TestTempRun | null = null

/** A fresh fixture directory for a heavy fixture, in place of `mkdtempSync(join(tmpdir(), prefix))`. */
export function fixtureDir(prefix: string): string {
  run ??= createTestTempRun(TEST_TEMP_REPO_ID)
  return makeFixtureDir(run, prefix)
}

/**
 * Claims this run and supervises removal for a bounded interval. A worker that outlives the preload writes its
 * failure to the release receipt and stderr, so the next startup also reports it before retrying the removal.
 * `restorer` (which restores owner write) and `remover` each receive the claimed tree as their last argument;
 * a test replaces one to stage a failed removal or another process removing part of the tree.
 */
export async function releaseFixtureRun(
  remover: readonly string[] = ['rm', '-rf'],
  restorer: readonly string[] = ['chmod', '-R', 'u+w']
): Promise<string | null> {
  if (run === null) return null
  const result = claimTestTempRun(run)
  if ('error' in result) return `${run.dir}: ${result.error}`
  run = null
  const receipt = `${result.claimed}.owner.json`
  const recordFailure = (message: string): string => {
    try {
      const saved = JSON.parse(readFileSync(receipt, 'utf8')) as Record<string, unknown>
      const temp = `${receipt}.${process.pid}.tmp`
      writeFileSync(temp, JSON.stringify({ ...saved, cleanupError: message }), { mode: 0o600 })
      renameSync(temp, receipt)
    } catch (error) {
      message += `; could not persist cleanup failure: ${String(error)}`
    }
    console.error(`test temp: ${result.claimed}: ${message}`)
    return message
  }
  const script = `
    import { spawnSync } from 'node:child_process';
    import { existsSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs';
    const claimed = ${JSON.stringify(result.claimed)};
    const receipt = ${JSON.stringify(receipt)};
    const command = ${JSON.stringify(remover)};
    const restore = ${JSON.stringify(restorer)};
    const deadline = Date.now() + ${PROCESS_FIXTURE_BUDGET_MS};
    const execute = (executable, args) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('cleanup exceeded its process budget');
      const result = spawnSync(executable, args, { encoding: 'utf8', timeout: remaining, killSignal: 'SIGKILL' });
      if (result.error || result.status !== 0) throw new Error('cleanup ' + executable + ' exit ' + result.status + ': ' + (result.error?.message ?? result.stderr));
    };
    // A claimed tree belongs to no one: another test process's startup sweep may be removing it while this removal
    // runs, as runners running at once do, so either step can fail on an entry the sweep deleted under it. Restoring
    // write is best effort and the removal always runs after it; whether the tree is gone decides the attempt. A tree
    // still there gets one more attempt inside the same budget; a tree that is gone is removed, whoever removed it.
    let failure = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      let restoreError = null;
      let removeError = null;
      // Restore only owner write within the claimed tree; never follow links into another directory.
      try { execute(restore[0], [...restore.slice(1), claimed]); } catch (error) { restoreError = error; }
      try { execute(command[0], [...command.slice(1), claimed]); } catch (error) { removeError = error; }
      if (!existsSync(claimed)) {
        failure = null;
        break;
      }
      failure = removeError ?? restoreError ?? new Error('cleanup ' + command[0] + ' left the claimed tree in place');
    }
    if (failure === null) {
      rmSync(receipt, { force: true });
    } else {
      let message = String(failure);
      try {
        const saved = JSON.parse(readFileSync(receipt, 'utf8'));
        const temp = receipt + '.' + process.pid + '.tmp';
        writeFileSync(temp, JSON.stringify({ ...saved, cleanupError: message }), { mode: 0o600 });
        renameSync(temp, receipt);
      } catch (persistError) { message += '; could not persist cleanup failure: ' + persistError; }
      console.error('test temp: ' + claimed + ': ' + message);
      process.exitCode = 1;
    }
  `
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--eval', script], {
      detached: true,
      env: stripVinayaEnv(),
      stdio: ['ignore', 'ignore', 'inherit']
    })
    const killTimer = setTimeout(() => child.kill('SIGKILL'), PROCESS_FIXTURE_BUDGET_MS + 1000)
    killTimer.unref()
    const timer = setTimeout(() => resolve(null), 1000)
    child.on('error', (error) => {
      clearTimeout(killTimer)
      clearTimeout(timer)
      resolve(recordFailure(error.message))
    })
    child.on('close', (code, signal) => {
      clearTimeout(killTimer)
      clearTimeout(timer)
      if (code === 0) resolve(null)
      else {
        let message = `cleanup exit ${code}${signal ? ` (${signal})` : ''}`
        try {
          message =
            (JSON.parse(readFileSync(receipt, 'utf8')) as { cleanupError?: string }).cleanupError ??
            recordFailure(message)
        } catch {
          message = recordFailure(message)
        }
        resolve(message)
      }
    })
    child.unref()
  })
}

/** Sweeps run directories earlier test processes abandoned. */
export function sweepAbandonedFixtureRuns(): Promise<SweepReport> {
  return sweepAbandoned(TEST_TEMP_REPO_ID)
}
