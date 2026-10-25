#!/usr/bin/env node
/**
 * The pre-push hook's own entrypoint into the test
 * selector. Standalone (not routed through `index.ts`/`commands/`) so it
 * bundles and ships exactly like `checks/bin/*.ts` does, and so the hook can
 * invoke it directly without paying for the whole CLI's argv-parsing layer.
 *
 * Contract with the generated hook (`artifacts.ts`'s `prePushBody`): prints
 * one absolute test-file path per line to STDOUT (empty output means
 * nothing was selected — a valid, common outcome, not an error), and the
 * human-facing "selected N of M" line to STDERR, so the hook's own
 * `$(...)` capture of STDOUT is never polluted by it.
 */
import { existsSync } from 'node:fs'
import {
  changedBetween,
  chooseTests,
  currentBranch,
  currentHead,
  isAncestor,
  readFailedTestsRecord,
  SELECTION_NOTE,
  writeJsonUnderGit
} from './pre-push-failed-tests.js'
import { prePushSelection } from './pre-push-selection.js'
import { selectAffectedTestFiles } from './test-selector.js'

function main(): void {
  const repoRoot = process.cwd()
  const started = performance.now()
  const full = prePushSelection(repoRoot)
  const { totalTestFiles, resolver, programMs } = full
  // Re-run only what failed: a push following a refused one runs the files
  // that failed there plus the files affected by what changed since, never
  // the whole selection again. Any record that does not fit (another branch,
  // a rewritten history, an unnamed failure) gives the full selection.
  const record = readFailedTestsRecord(repoRoot)
  const head = currentHead(repoRoot)
  const branch = currentBranch(repoRoot)
  const recordIsAncestor = record ? isAncestor(repoRoot, record.head, head) : false
  const affectedSince =
    record && record.failed !== 'all' && recordIsAncestor && record.branch === branch
      ? selectAffectedTestFiles(repoRoot, changedBetween(repoRoot, record.head, head), { depth: 'one' }).selected
      : []
  const note = chooseTests({
    record,
    head,
    branch,
    recordIsAncestor,
    fullSelection: full.selected,
    affectedSince,
    exists: existsSync
  })
  try {
    writeJsonUnderGit(repoRoot, SELECTION_NOTE, note)
  } catch {
    // Best-effort: the note only labels the result for the loop's Log.
  }
  const selected = note.selected
  const elapsed = performance.now() - started

  for (const file of selected) process.stdout.write(`${file}\n`)
  // Selector runtime is reported on its own, and split from the compiler
  // program build inside it, so a push-time budget can be judged against the
  // selector rather than against the tests it goes on to run.
  process.stderr.write(
    `vinaya pre-push: selected ${selected.length} of ${totalTestFiles} test file(s) ` +
      `[${resolver}, ${elapsed.toFixed(0)} ms selector, ${programMs.toFixed(0)} ms program]\n`
  )
  if (note.mode === 'rerun') {
    process.stderr.write(
      `vinaya pre-push: re-running only what failed at ${note.rerunOf?.slice(0, 12)} — ` +
        `${note.rerunFailed?.length ?? 0} failed file(s) + ${note.affectedSince?.length ?? 0} affected since, ` +
        `instead of the full ${note.fullCount}\n`
    )
  }
}

main()
