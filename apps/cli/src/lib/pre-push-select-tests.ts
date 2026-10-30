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
import { globToRegex } from '@attalabs/aeg-core'
import { existsSync } from 'node:fs'
import { loadConfig } from './config.js'
import {
  changedBetween,
  computeVerificationContext,
  currentBranch,
  currentHead,
  decideSelection,
  isAncestor,
  readFailedTestsRecord,
  readPassingRecord,
  SELECTION_NOTE,
  verificationInputsDirty,
  writeJsonUnderGit
} from './pre-push-failed-tests.js'
import { prePushSelection } from './pre-push-selection.js'
import type { ReadFailure } from './remote-base.js'
import { type SelectionResult, selectAffectedTestFiles } from './test-selector.js'

function main(): void {
  const repoRoot = process.cwd()
  const started = performance.now()
  // Re-run only what changed: a push after a refused one runs the files that
  // failed there plus the files affected since; a push after a verified
  // passing one runs the hook's own selection for the changes since that pass.
  // Any record that does not fit (another branch, a rewritten history, an
  // unnamed failure, another context, an unreadable diff) gives the full
  // selection — which is computed only then.
  const head = currentHead(repoRoot)
  const branch = currentBranch(repoRoot)
  const alwaysRun = (loadConfig()?.prePush?.alwaysRun ?? []).map(globToRegex)
  let sinceGreen: SelectionResult | null = null
  const { note, full } = decideSelection({
    repoRoot,
    head,
    branch,
    failed: readFailedTestsRecord(repoRoot),
    passing: readPassingRecord(repoRoot),
    context: computeVerificationContext(repoRoot)?.digest ?? null,
    inputsClean: verificationInputsDirty(repoRoot) === false,
    isAncestor: (ancestor) => isAncestor(repoRoot, ancestor, head),
    exists: existsSync,
    changedBetween: (from) => changedBetween(repoRoot, from, head),
    isAlwaysRun: (path) => alwaysRun.some((re) => re.test(path.slice(repoRoot.length + 1))),
    sinceGreen: (from) => {
      const failure: ReadFailure = { failed: false }
      const result = prePushSelection(repoRoot, from, 'one', failure)
      sinceGreen = result
      return { selected: result.selected, readFailed: failure.failed }
    },
    affectedSince: (changed) => selectAffectedTestFiles(repoRoot, changed, { depth: 'one' }).selected,
    full: () => prePushSelection(repoRoot)
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
  if (full) {
    process.stderr.write(
      `vinaya pre-push: selected ${selected.length} of ${full.totalTestFiles} test file(s) ` +
        `[${full.resolver}, ${elapsed.toFixed(0)} ms selector, ${full.programMs.toFixed(0)} ms program]\n`
    )
  } else {
    const read = sinceGreen as SelectionResult | null
    process.stderr.write(
      `vinaya pre-push: selected ${selected.length} test file(s) since the last passing run ` +
        `[${read?.resolver ?? 'none'}, ${elapsed.toFixed(0)} ms selector, ${(read?.programMs ?? 0).toFixed(0)} ms program]\n`
    )
  }
  if (note.mode === 'rerun') {
    process.stderr.write(
      `vinaya pre-push: re-running only what failed at ${note.rerunOf?.slice(0, 12)} — ` +
        `${note.rerunFailed?.length ?? 0} failed file(s) + ${note.affectedSince?.length ?? 0} affected since, ` +
        `instead of the full ${note.fullCount}\n`
    )
  } else if (note.mode === 'since-green') {
    process.stderr.write(
      `vinaya pre-push: running only what changed since the passing run at ${note.recordedHead.slice(0, 12)} — ` +
        `${note.affectedSince.length} affected file(s) plus the always-run files, instead of the full selection\n`
    )
  }
}

main()
