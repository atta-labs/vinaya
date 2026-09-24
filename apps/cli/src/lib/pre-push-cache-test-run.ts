#!/usr/bin/env node
/**
 * The pre-push hook's own entrypoint into the O3 test-run cache
 * (`pr-report-engine.ts`'s `recordGreenTestRun`). Standalone, same discipline
 * as `pre-push-select-tests.ts` beside it — invoked directly from the
 * generated hook, never through the CLI's own argv-parsing layer.
 *
 * Called ONLY after the hook's own test run has already exited zero — this
 * script never runs a test itself, it records one that already ran green,
 * by the hook's own separate means. `source: 'pre-push'` is what makes an
 * earlier `pr report` able to reuse this exact run instead of re-executing
 * it: without a real writer on this side, that half of O3's reuse clause
 * ("in the pre-push hook or an earlier pr report") was never reachable.
 * `recordGreenTestRun` also files this run's own file list under a second,
 * state-only key, so a later Test-plan `bun test <files>`
 * command naming a SUBSET of the files this run covered reuses it too —
 * never only a command matching this run's own text verbatim.
 *
 * Best-effort, deliberately: a failure here (an unreadable log file, an
 * unresolvable git state) never fails the push — the test run itself
 * already succeeded, and the worst this script losing its own write can
 * cost is one avoidable re-run later, never a lost or corrupted result.
 *
 * Contract with the generated hook (`artifacts.ts`'s `prePushBody`):
 * `argv[2]` is the exact command text that was run (the pre-push hook's own
 * full selected-file list, space-joined) — matched verbatim for exact-command
 * reuse, and parsed for its own file arguments for per-file reuse — `argv[3]`
 * is the path to that command's captured stdout+stderr.
 */
import { readFileSync } from 'node:fs'
import { recordGreenTestRun } from './pr-report-engine.js'

async function main(): Promise<void> {
  const command = process.argv[2]
  const logPath = process.argv[3]
  if (!command || !logPath) {
    process.stderr.write('vinaya pre-push: cache-test-run given no command/log path — nothing recorded.\n')
    return
  }
  let output: string
  try {
    output = readFileSync(logPath, 'utf8')
  } catch (err) {
    process.stderr.write(
      `vinaya pre-push: could not read ${logPath} to cache this run — nothing recorded (${err instanceof Error ? err.message : String(err)}).\n`
    )
    return
  }
  try {
    const recorded = await recordGreenTestRun(command, output, process.cwd(), 'pre-push')
    process.stderr.write(
      recorded
        ? 'vinaya pre-push: this run is cached for reuse by a later `pr report`.\n'
        : 'vinaya pre-push: working tree/head could not be resolved — this run was not cached.\n'
    )
  } catch (err) {
    process.stderr.write(
      `vinaya pre-push: failed to cache this run — nothing recorded (${err instanceof Error ? err.message : String(err)}).\n`
    )
  }
}

main()
