#!/usr/bin/env node
/**
 * The pre-push hook's own entrypoint for recording a test run's result.
 * Standalone like `pre-push-select-tests.ts` beside it.
 *
 * Contract with the generated hook (`artifacts.ts`'s `prePushBody`):
 * `argv[2]` is `passed` or `failed`, `argv[3]` the captured `bun test` output
 * (may be empty for `storage`, which runs no tests), `argv[4]` the elapsed
 * seconds. `VINAYA_PUSH_MODE` names the push mode (`storage`, `ready`, or
 * unset for today's default push).
 *
 * A refused run leaves the failed-tests record the next push re-runs from; a
 * green run clears it. Both write the last-push summary the loop reads for
 * its Log events. Best-effort: never fails the push, and writes to STDERR
 * only, so the hook's own refusal summary stays the tail of STDOUT.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  completedTestSelection,
  TEST_SELECTION_COMPLETE,
  currentBranch,
  currentHead,
  FAILED_TESTS_RECORD,
  LAST_PUSH_RESULT,
  type LastPushResult,
  parseFailedTestFiles,
  readJsonUnderGit,
  recordFromRun,
  removeUnderGit,
  SELECTION_NOTE,
  type SelectionNote,
  writeJsonUnderGit
} from './pre-push-failed-tests.js'

function main(): void {
  if (process.argv[2] === 'run') {
    const files = process.argv.slice(3)
    const result = spawnSync('bun', ['test', '--timeout=30000', '--', ...files], { stdio: 'inherit' })
    if (result.signal === null && (result.status === 0 || result.status === 1))
      process.stdout.write(TEST_SELECTION_COMPLETE + JSON.stringify({ files, exitCode: result.status }) + '\n')
    process.exitCode = result.status ?? 1
    return
  }
  const repoRoot = process.cwd()
  const outcome = process.argv[2] === 'passed' ? 'passed' : 'failed'
  const logPath = process.argv[3]
  const elapsed = Number(process.argv[4])
  const envMode = process.env.VINAYA_PUSH_MODE
  const mode: LastPushResult['mode'] = envMode === 'storage' || envMode === 'ready' ? envMode : 'default'
  try {
    let log = ''
    if (logPath) {
      try {
        log = readFileSync(logPath, 'utf8')
      } catch {
        log = ''
      }
    }
    const head = currentHead(repoRoot)
    const branch = currentBranch(repoRoot)
    let selection: SelectionNote | null = null
    const noteText = mode === 'storage' ? null : readJsonUnderGit(repoRoot, SELECTION_NOTE)
    if (noteText) {
      try {
        const parsed = JSON.parse(noteText) as SelectionNote
        selection = parsed.head === head ? parsed : null
      } catch {
        selection = null
      }
    }
    const selectionCompleted =
      selection?.selected.length === 0 ||
      mode === 'storage' ||
      completedTestSelection(log, repoRoot, selection?.selected)
    const settledOutcome = outcome === 'passed' && !selectionCompleted ? 'failed' : outcome
    const failed = settledOutcome === 'failed' ? parseFailedTestFiles(log, repoRoot, true, selection?.selected) : []
    const record = recordFromRun(settledOutcome, failed, head, branch, new Date())
    if (record) writeJsonUnderGit(repoRoot, FAILED_TESTS_RECORD, record)
    else removeUnderGit(repoRoot, FAILED_TESTS_RECORD)

    const result: LastPushResult = {
      version: 1,
      head,
      branch,
      mode,
      outcome: settledOutcome,
      selectionCompleted,
      selection,
      failed,
      elapsedSeconds: Number.isFinite(elapsed) ? elapsed : null,
      recordedAt: new Date().toISOString()
    }
    writeJsonUnderGit(repoRoot, LAST_PUSH_RESULT, result)
    if (record && record.failed !== 'all') {
      process.stderr.write(
        `vinaya pre-push: recorded ${record.failed.length} failing file(s) — the next push re-runs only those plus what the fix affects.\n`
      )
    }
  } catch (err) {
    process.stderr.write(
      `vinaya pre-push: could not record this run (${err instanceof Error ? err.message : String(err)}).\n`
    )
  }
}

main()
